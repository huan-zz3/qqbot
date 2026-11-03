package main

// qqbot 远程助手（Windows 控制台客户端）。
// 线协议见 .slim/deepwork/agent-client/protocol.md，本文件只管启动、窗口输出与重连循环。

import (
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 由构建脚本经 -ldflags -X main.endpoint=... / main.psk=... 注入。
// 故意不给默认值：缺了就报错退出，避免连到错误地址。
var (
	endpoint string
	psk      string
)

// 同样由构建脚本注入（毫秒/字符数的十进制字符串）。
// 解析失败或缺失时退回 tools.go 里的内置默认值（60000 / 20000），
// 这样没重新构建的旧 exe 仍能跑，不会因缺少注入值直接崩。
var (
	pshTimeoutMs   string
	maxOutputChars string
)

const (
	protocolVersion  = 1
	dialTimeout      = 10 * time.Second
	handshakeTimeout = 10 * time.Second
	initialBackoff   = 2 * time.Second
	maxBackoff       = 10 * time.Second
	codeGraceWindow  = 60 * time.Second // 服务端 AGENT_CLIENT_CODE_GRACE_MS 的默认值

	// handshakeRetryBackoff 用于服务端回 retry=true 的 error 帧（在线名额已满等）。
	handshakeRetryBackoff = 10 * time.Second
	// maxHandshakeRetries 是连续重试上限：超过就打印原因退出，避免永远转圈。
	maxHandshakeRetries = 5
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "错误：%v\n", err)
		os.Exit(1)
	}
}

func run() error {
	addr, err := parseEndpoint(endpoint)
	if err != nil {
		return err
	}
	pskBytes, err := parsePSK(psk)
	if err != nil {
		return err
	}

	u := &ui{w: os.Stdout}
	var resume *resumeInfo
	backoff := initialBackoff
	var graceDeadline time.Time
	handshakeRetries := 0

	for {
		sess, err := dialHandshake(addr, pskBytes, resume)
		if err != nil {
			var he *handshakeError
			if errors.As(err, &he) {
				if resume != nil && !he.retry {
					// 认领失败（码已注销/过期）：服务端不会再认这个码，改用新连接拿新码。
					// retry=true 只是暂时性拒绝，不能丢掉手上的码。
					resume = nil
					u.line("配对码已更新，请重新发给 bot")
					continue
				}
				if he.retry {
					handshakeRetries++
					if handshakeRetries > maxHandshakeRetries {
						return fmt.Errorf("服务端持续拒绝握手（已重试 %d 次）：%s", maxHandshakeRetries, he.msg)
					}
					u.line("服务端暂时不可用：%s（%s后重试，第 %d/%d 次）",
						he.msg, shortDuration(handshakeRetryBackoff), handshakeRetries, maxHandshakeRetries)
					time.Sleep(handshakeRetryBackoff)
					continue
				}
				return fmt.Errorf("服务端拒绝握手：%s", he.msg)
			}
			var pe *protocolError
			if errors.As(err, &pe) {
				u.line("连接中断：%s", pe.msg)
				return err
			}
			var pa *pairingError
			if errors.As(err, &pa) {
				// PSK 不匹配：重试永远不会成功，打印原因后直接退出。
				u.line("%s", pa.msg)
				return err
			}
			if resume != nil && !time.Now().Before(graceDeadline) {
				// 宽限期已过，原码作废
				resume = nil
				u.line("配对码已更新，请重新发给 bot")
				continue
			}
			u.line("连接失败：%v（%s后重试）", err, shortDuration(backoff))
			time.Sleep(backoff)
			backoff = min(backoff*2, maxBackoff)
			continue
		}

		if resume != nil {
			u.line("已重连，配对码不变（%s）", sess.code)
		} else {
			u.showPairingCode(sess.code)
		}
		backoff = initialBackoff
		handshakeRetries = 0

		serveErr := sess.serve(u)
		sess.conn.Close()

		var pe *protocolError
		if errors.As(serveErr, &pe) {
			u.line("连接中断：%s", pe.msg)
			return serveErr
		}
		u.line("已断线，重连中…")
		resume = &resumeInfo{Code: sess.code, Token: sess.token}
		graceDeadline = time.Now().Add(codeGraceWindow)
	}
}

func parseEndpoint(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", errors.New("未注入服务端地址：构建时需指定 AGENT_CLIENT_ENDPOINT（例如 tcp://1.2.3.4:7801）")
	}
	if !strings.HasPrefix(value, "tcp://") {
		return "", fmt.Errorf("服务端地址必须以 tcp:// 开头，当前是 %q", value)
	}
	hostPort := strings.TrimPrefix(value, "tcp://")
	host, port, err := net.SplitHostPort(hostPort)
	if err != nil || host == "" {
		return "", fmt.Errorf("服务端地址格式非法（应为 tcp://主机:端口）：%q", value)
	}
	portNum, err := strconv.Atoi(port)
	if err != nil || portNum < 1 || portNum > 65535 {
		return "", fmt.Errorf("服务端端口非法（应为 1-65535）：%q", port)
	}
	return hostPort, nil
}

func parsePSK(raw string) ([]byte, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return nil, errors.New("未注入 PSK：构建时需指定 AGENT_CLIENT_PSK（32 字节 hex）")
	}
	key, err := hex.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("PSK 不是合法的十六进制：%v", err)
	}
	if len(key) != sessionKeyLen {
		return nil, fmt.Errorf("PSK 必须是 %d 字节（%d 个十六进制字符），当前 %d 字节",
			sessionKeyLen, sessionKeyLen*2, len(key))
	}
	return key, nil
}

// ui 是控制台输出。读包 goroutine 不打印，但工具执行与重连循环可能并发，故加锁。
type ui struct {
	mu sync.Mutex
	w  io.Writer
}

func (u *ui) printf(format string, a ...any) {
	u.mu.Lock()
	defer u.mu.Unlock()
	fmt.Fprintf(u.w, format, a...)
}

func (u *ui) line(format string, a ...any) {
	u.printf(format+"\n", a...)
}

func (u *ui) showPairingCode(code string) {
	const bar = "=============================================="
	u.printf("\n%s\n  配对码：%s\n\n  把它发给 bot\n%s\n\n", bar, code, bar)
}

// toolCall 打一行调用摘要；toolResult 打一行结果，与命令摘要同列对齐。
func (u *ui) toolCall(tool, detail string) {
	u.printf("%s  %-9s %s\n", timestamp(), tool, detail)
}

func (u *ui) toolResult(detail string) {
	u.printf("%s└ %s\n", strings.Repeat(" ", 18), detail)
}

func timestamp() string {
	return time.Now().Format("15:04:05")
}

// summarize 把多行命令压成单行并限长，方便一行显示。
func summarize(s string, max int) string {
	flat := strings.Join(strings.Fields(s), " ")
	if flat == "" {
		return "（空）"
	}
	runes := []rune(flat)
	if len(runes) > max {
		return string(runes[:max]) + "…"
	}
	return flat
}

func humanBytes(n int) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := int64(n) / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGT"[exp])
}

func shortDuration(d time.Duration) string {
	return fmt.Sprintf("%.0f 秒", d.Seconds())
}
