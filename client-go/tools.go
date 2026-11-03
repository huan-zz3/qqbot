package main

// 两个工具的本地实现：run_psh / read_file。串行由 session.serve 保证。

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

const (
	// defaultPshTimeoutMS / defaultMaxOutputChars 是构建注入值缺失或非法时的兜底，
	// 与服务端 AGENT_CLIENT_PSH_TIMEOUT_MS / AGENT_CLIENT_MAX_OUTPUT_CHARS 的默认值对齐。
	defaultPshTimeoutMS   = 60000
	defaultMaxOutputChars = 20000
	// defaultReadMaxBytes 是 read_file 的 max_bytes 缺省值（256 KiB），仍受本地封顶约束。
	defaultReadMaxBytes = 256 * 1024
	// minReadCapBytes 是 read_file 本地封顶的下限（协议：max(4×maxOutputChars, 64KiB)）。
	minReadCapBytes = 64 * 1024
	// killGrace 是超时后等 taskkill 生效的宽限时间。
	killGrace = 5 * time.Second
)

// injectedInt 解析 -ldflags -X 注入的十进制整数；空值或非法时用 fallback。
func injectedInt(raw string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

// pshTimeoutLimit 是本地 psh 超时上限（毫秒）。
func pshTimeoutLimit() int { return injectedInt(pshTimeoutMs, defaultPshTimeoutMS) }

// outputCharLimit 是本地输出字符数量上限。
func outputCharLimit() int { return injectedInt(maxOutputChars, defaultMaxOutputChars) }

// readBytesLimit 是 read_file 的本地字节上限：max(4×maxOutputChars, 64KiB)。
func readBytesLimit() int {
	limit := 4 * outputCharLimit()
	if limit < minReadCapBytes {
		limit = minReadCapBytes
	}
	return limit
}

// resolvePshLimits 把请求参数收敛到本地上限内：
// 缺省（<=0）用注入值；给了更大的值则按注入值封顶（服务端也会钳，这里是兜底）。
func resolvePshLimits(args pshArgs) (timeoutMS, limitChars int) {
	timeoutMS = pshTimeoutLimit()
	if args.TimeoutMS > 0 && args.TimeoutMS < timeoutMS {
		timeoutMS = args.TimeoutMS
	}
	limitChars = outputCharLimit()
	if args.MaxOutputChars > 0 && args.MaxOutputChars < limitChars {
		limitChars = args.MaxOutputChars
	}
	return timeoutMS, limitChars
}

type pshArgs struct {
	Command        string `json:"command"`
	TimeoutMS      int    `json:"timeout_ms"`
	MaxOutputChars int    `json:"max_output_chars"`
}

type pshResult struct {
	Exit      int    `json:"exit"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	TimedOut  bool   `json:"timedOut"`
	Truncated bool   `json:"truncated"`
}

type readArgs struct {
	Path     string `json:"path"`
	MaxBytes int    `json:"max_bytes"`
}

type readResult struct {
	Text      string `json:"text"`
	Bytes     int    `json:"bytes"`
	Truncated bool   `json:"truncated"`
	Encoding  string `json:"encoding"`
}

// handleTool 执行一次调用并回包（id 原样带回）。
func handleTool(u *ui, req request) response {
	switch req.Tool {
	case "run_psh":
		var args pshArgs
		if len(req.Args) > 0 {
			if err := json.Unmarshal(req.Args, &args); err != nil {
				u.toolCall(req.Tool, summarize(string(req.Args), 120))
				return failCall(u, req.ID, fmt.Sprintf("参数不是合法 JSON：%v", err))
			}
		}
		timeoutMS, _ := resolvePshLimits(args)
		u.toolCall("run_psh", summarize(args.Command, 120))
		result, err := runPsh(args)
		if err != nil {
			return failCall(u, req.ID, err.Error())
		}
		u.toolResult(describePsh(result, timeoutMS))
		return response{ID: req.ID, OK: true, Result: result}

	case "read_file":
		var args readArgs
		if len(req.Args) > 0 {
			if err := json.Unmarshal(req.Args, &args); err != nil {
				u.toolCall(req.Tool, summarize(string(req.Args), 120))
				return failCall(u, req.ID, fmt.Sprintf("参数不是合法 JSON：%v", err))
			}
		}
		u.toolCall("read_file", summarize(args.Path, 120))
		result, err := readFile(args)
		if err != nil {
			return failCall(u, req.ID, err.Error())
		}
		u.toolResult(describeRead(result))
		return response{ID: req.ID, OK: true, Result: result}

	default:
		u.toolCall(req.Tool, "（未知工具）")
		return failCall(u, req.ID, "未知工具："+req.Tool)
	}
}

func failCall(u *ui, id, message string) response {
	u.toolResult("失败：" + message)
	return response{ID: id, OK: false, Error: message}
}

func describePsh(r pshResult, timeoutMS int) string {
	var b strings.Builder
	if r.TimedOut {
		fmt.Fprintf(&b, "超时（%d 毫秒）已终止进程树，退出码 -1", timeoutMS)
	} else {
		fmt.Fprintf(&b, "完成：退出码 %d，stdout %s，stderr %s",
			r.Exit, humanBytes(len(r.Stdout)), humanBytes(len(r.Stderr)))
	}
	if r.Truncated {
		b.WriteString("，输出已截断")
	}
	return b.String()
}

func describeRead(r readResult) string {
	var b strings.Builder
	fmt.Fprintf(&b, "完成：%s（%d 字节，%s", humanBytes(r.Bytes), r.Bytes, r.Encoding)
	if r.Truncated {
		b.WriteString("，已截断")
	}
	b.WriteString("）")
	return b.String()
}

// runPsh 跑一条 PowerShell 命令；超时用 taskkill 杀进程树。
func runPsh(args pshArgs) (pshResult, error) {
	if strings.TrimSpace(args.Command) == "" {
		return pshResult{}, errors.New("command 为空")
	}
	timeoutMS, limitChars := resolvePshLimits(args)
	// 保留足够字节以便按字符截断多字节文本
	retain := limitChars*4 + 8

	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", args.Command)
	stdout := newLimitedBuffer(retain)
	stderr := newLimitedBuffer(retain)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return pshResult{}, fmt.Errorf("无法启动 powershell：%w", err)
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	timer := time.NewTimer(time.Duration(timeoutMS) * time.Millisecond)
	defer timer.Stop()

	timedOut := false
	var waitErr error
	select {
	case waitErr = <-done:
	case <-timer.C:
		timedOut = true
		killProcessTree(cmd.Process)
		select {
		case waitErr = <-done:
		case <-time.After(killGrace):
			// taskkill 没生效也不阻塞窗口，直接按超时回包
		}
	}

	exit := 0
	if timedOut {
		exit = -1
	} else if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			exit = exitErr.ExitCode()
		} else {
			return pshResult{}, fmt.Errorf("执行失败：%w", waitErr)
		}
	}

	outText, outCut := truncateRunes(decodeOutput(stdout.Bytes()), limitChars)
	errText, errCut := truncateRunes(decodeOutput(stderr.Bytes()), limitChars)
	return pshResult{
		Exit:      exit,
		Stdout:    outText,
		Stderr:    errText,
		TimedOut:  timedOut,
		Truncated: outCut || errCut || stdout.Dropped() || stderr.Dropped(),
	}, nil
}

// killProcessTree 用 taskkill 杀掉整棵进程树；taskkill 失败时至少杀掉 powershell 本身。
func killProcessTree(p *os.Process) {
	if p == nil {
		return
	}
	kill := exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(p.Pid))
	kill.Stdout = io.Discard
	kill.Stderr = io.Discard
	if err := kill.Run(); err != nil {
		_ = p.Kill()
	}
}

// readFile 按 BOM 优先解码：UTF-16LE/BE、UTF-8(剥 BOM)，无 BOM 时 UTF-8 → GB18030。
func readFile(args readArgs) (readResult, error) {
	if args.Path == "" {
		return readResult{}, errors.New("path 为空")
	}
	capBytes := readBytesLimit()
	maxBytes := args.MaxBytes
	if maxBytes <= 0 {
		maxBytes = defaultReadMaxBytes
	}
	// 服务端也会钳；这里本地兜底，防止一个离谱的 max_bytes 一次读进几百 MB。
	if maxBytes > capBytes {
		maxBytes = capBytes
	}

	f, err := os.Open(args.Path)
	if err != nil {
		return readResult{}, describeFileError(args.Path, err)
	}
	defer f.Close()

	// 多读 1 字节用于判断是否截断
	buf := make([]byte, maxBytes+1)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return readResult{}, fmt.Errorf("读取文件失败：%w", err)
	}
	truncated := n > maxBytes
	if truncated {
		n = maxBytes
	}
	data := buf[:n]

	text, encoding, err := decodeFileText(data, truncated)
	if err != nil {
		return readResult{}, err
	}
	return readResult{Text: text, Bytes: len(data), Truncated: truncated, Encoding: encoding}, nil
}

func describeFileError(path string, err error) error {
	switch {
	case errors.Is(err, os.ErrNotExist):
		return fmt.Errorf("文件不存在：%s", path)
	case errors.Is(err, os.ErrPermission):
		return fmt.Errorf("没有权限读取：%s", path)
	default:
		return fmt.Errorf("打开文件失败：%v", err)
	}
}

// decodeFileText 按 BOM 优先解码（Windows PowerShell 5.1 的 Out-File 默认 UTF-16LE+BOM）：
// FF FE → UTF-16LE，FE FF → UTF-16BE，EF BB BF → UTF-8（剥 BOM）；
// 无 BOM 时先严格试 UTF-8，失败按 GB18030。
// 截断可能切在多字节/双字节字符中间，因此从尾部回退若干字节再试（UTF-16 按 2 字节对齐）。
func decodeFileText(data []byte, truncated bool) (text, encoding string, err error) {
	switch {
	case bytes.HasPrefix(data, []byte{0xff, 0xfe}):
		return decodeUTF16(data[2:], unicode.LittleEndian, truncated, "utf-16le")
	case bytes.HasPrefix(data, []byte{0xfe, 0xff}):
		return decodeUTF16(data[2:], unicode.BigEndian, truncated, "utf-16be")
	case bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}):
		return decodeUTF8(data[3:], truncated)
	}
	return decodeUTF8(data, truncated)
}

// decodeUTF8 严格解 UTF-8，失败按 GB18030。
func decodeUTF8(data []byte, truncated bool) (text, encoding string, err error) {
	cuts := []int{0}
	if truncated {
		cuts = []int{0, 1, 2, 3}
	}
	for _, cut := range cuts {
		if cut > len(data) {
			break
		}
		if b := data[:len(data)-cut]; utf8.Valid(b) {
			return strings.TrimPrefix(string(b), "\ufeff"), "utf-8", nil
		}
	}
	var lastErr error
	var fallback string
	haveFallback := false
	for _, cut := range cuts {
		if cut > len(data) {
			break
		}
		out, _, decErr := transform.Bytes(simplifiedchinese.GB18030.NewDecoder(), data[:len(data)-cut])
		if decErr != nil {
			lastErr = decErr
			continue
		}
		text := string(out)
		// 截断可能切在多字节序列中间：解码器会把残尾换成 U+FFFD，这里再回退一字节重试
		if truncated && strings.HasSuffix(text, "\uFFFD") {
			if !haveFallback {
				fallback, haveFallback = text, true
			}
			lastErr = errors.New("文件末尾落在不完整的多字节序列上")
			continue
		}
		return text, "gb18030", nil
	}
	if haveFallback {
		return fallback, "gb18030", nil
	}
	return "", "", fmt.Errorf("文件既不是 UTF-8 也不是 GB18030 编码：%v", lastErr)
}

// decodeUTF16 按给定字节序解 UTF-16（BOM 已由调用方剥掉）。
// 截断可能切在一个 code unit 中间，故按 2 字节对齐回退。
func decodeUTF16(data []byte, order unicode.Endianness, truncated bool, label string) (string, string, error) {
	cuts := []int{0}
	if truncated {
		cuts = []int{0, 2, 1, 3}
	}
	var lastErr error
	var fallback string
	haveFallback := false
	for _, cut := range cuts {
		if cut > len(data) {
			break
		}
		body := data[:len(data)-cut]
		if len(body)%2 != 0 {
			lastErr = errors.New("UTF-16 数据长度不是 2 的倍数")
			continue
		}
		out, _, decErr := transform.Bytes(unicode.UTF16(order, unicode.IgnoreBOM).NewDecoder(), body)
		if decErr != nil {
			lastErr = decErr
			continue
		}
		text := string(out)
		// 截断可能切在代理对中间，解码器会留下 U+FFFD；记录后继续回退重试。
		if truncated && strings.HasSuffix(text, "\uFFFD") {
			if !haveFallback {
				fallback, haveFallback = text, true
			}
			lastErr = errors.New("文件末尾落在不完整的 UTF-16 序列上")
			continue
		}
		return text, label, nil
	}
	if haveFallback {
		return fallback, label, nil
	}
	return "", "", fmt.Errorf("按 %s 解码失败：%v", label, lastErr)
}

// decodeOutput 解 PowerShell 输出：合法 UTF-8 直接转，否则按 GB18030（中文 Windows 的 OEM 代码页）。
func decodeOutput(data []byte) string {
	if utf8.Valid(data) {
		return string(data)
	}
	if out, _, err := transform.Bytes(simplifiedchinese.GB18030.NewDecoder(), data); err == nil {
		return string(out)
	}
	return string(data)
}

// truncateRunes 按字符（rune）截断，返回是否发生截断。
func truncateRunes(s string, limit int) (string, bool) {
	if limit <= 0 {
		return "", s != ""
	}
	if utf8.RuneCountInString(s) <= limit {
		return s, false
	}
	runes := []rune(s)
	return string(runes[:limit]), true
}

// limitedBuffer 只保留前 limit 字节，其余丢弃但计数。
type limitedBuffer struct {
	buf   bytes.Buffer
	limit int
	total int
}

func newLimitedBuffer(limit int) *limitedBuffer {
	return &limitedBuffer{limit: limit}
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	l.total += len(p)
	if remain := l.limit - l.buf.Len(); remain > 0 {
		if len(p) <= remain {
			l.buf.Write(p)
		} else {
			l.buf.Write(p[:remain])
		}
	}
	return len(p), nil
}

func (l *limitedBuffer) Bytes() []byte { return l.buf.Bytes() }

// Dropped 表示有字节因超出保留上限被丢弃。
func (l *limitedBuffer) Dropped() bool { return l.total > l.buf.Len() }
