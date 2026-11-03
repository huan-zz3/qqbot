package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

func gb18030Bytes(t *testing.T, s string) []byte {
	t.Helper()
	out, _, err := transform.Bytes(simplifiedchinese.GB18030.NewEncoder(), []byte(s))
	if err != nil {
		t.Fatalf("GB18030 编码失败：%v", err)
	}
	return out
}

// utf16Bytes 编出带 BOM 的 UTF-16 字节（模拟 PowerShell Out-File 的产物）。
func utf16Bytes(t *testing.T, s string, order unicode.Endianness) []byte {
	t.Helper()
	out, _, err := transform.Bytes(unicode.UTF16(order, unicode.UseBOM).NewEncoder(), []byte(s))
	if err != nil {
		t.Fatalf("UTF-16 编码失败：%v", err)
	}
	return out
}

func writeTempFile(t *testing.T, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sample.log")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("写临时文件失败：%v", err)
	}
	return path
}

func TestReadFileUTF8(t *testing.T) {
	content := "2026-11-03 12:00:00 启动成功\n第二行\n"
	path := writeTempFile(t, []byte(content))

	res, err := readFile(readArgs{Path: path})
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	if res.Text != content {
		t.Fatalf("文本不符：%q", res.Text)
	}
	if res.Bytes != len(content) {
		t.Fatalf("bytes 不符：%d want %d", res.Bytes, len(content))
	}
	if res.Encoding != "utf-8" || res.Truncated {
		t.Fatalf("encoding/truncated 不符：%s/%v", res.Encoding, res.Truncated)
	}
}

func TestReadFileStripsUTF8BOM(t *testing.T) {
	path := writeTempFile(t, append([]byte{0xef, 0xbb, 0xbf}, []byte("日志")...))
	res, err := readFile(readArgs{Path: path})
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	if res.Text != "日志" {
		t.Fatalf("BOM 未剥除：%q", res.Text)
	}
}

func TestReadFileEmpty(t *testing.T) {
	path := writeTempFile(t, nil)
	res, err := readFile(readArgs{Path: path})
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	if res.Text != "" || res.Bytes != 0 || res.Truncated || res.Encoding != "utf-8" {
		t.Fatalf("空文件结果不符：%+v", res)
	}
}

func TestReadFileGB18030(t *testing.T) {
	content := "2026-11-03 错误日志：连接失败\n"
	path := writeTempFile(t, gb18030Bytes(t, content))

	res, err := readFile(readArgs{Path: path})
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	if res.Encoding != "gb18030" {
		t.Fatalf("encoding 不符：%s", res.Encoding)
	}
	if res.Text != content {
		t.Fatalf("文本不符：%q want %q", res.Text, content)
	}
}

func TestReadFileUTF16LEWithBOM(t *testing.T) {
	// PowerShell 5.1 的 Out-File 默认就是这种形态：UTF-16LE + BOM。
	content := "2026-11-03 错误日志：连接失败\r\n"
	data := utf16Bytes(t, content, unicode.LittleEndian)
	if !bytes.HasPrefix(data, []byte{0xff, 0xfe}) {
		t.Fatalf("测试数据应带 UTF-16LE BOM：% x", data[:4])
	}
	path := writeTempFile(t, data)

	res, err := readFile(readArgs{Path: path})
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	if res.Encoding != "utf-16le" {
		t.Fatalf("encoding 不符：%s", res.Encoding)
	}
	if res.Text != content {
		t.Fatalf("文本不符：%q want %q", res.Text, content)
	}
}

func TestReadFileUTF16BEWithBOM(t *testing.T) {
	content := "big endian 文本\n"
	data := utf16Bytes(t, content, unicode.BigEndian)
	if !bytes.HasPrefix(data, []byte{0xfe, 0xff}) {
		t.Fatalf("测试数据应带 UTF-16BE BOM：% x", data[:4])
	}
	path := writeTempFile(t, data)

	res, err := readFile(readArgs{Path: path})
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	if res.Encoding != "utf-16be" {
		t.Fatalf("encoding 不符：%s", res.Encoding)
	}
	if res.Text != content {
		t.Fatalf("文本不符：%q", res.Text)
	}
}

// 截断落在 code unit 中间时应回退到 2 字节对齐，不吐 U+FFFD。
func TestReadFileUTF16TruncatedOnUnitBoundary(t *testing.T) {
	content := "日志内容"
	data := utf16Bytes(t, content, unicode.LittleEndian)
	for _, maxBytes := range []int{2 + 2*2 + 1, 2 + 2*3 + 1} {
		path := writeTempFile(t, data)
		res, err := readFile(readArgs{Path: path, MaxBytes: maxBytes})
		if err != nil {
			t.Fatalf("max_bytes=%d readFile: %v", maxBytes, err)
		}
		if !res.Truncated || res.Encoding != "utf-16le" {
			t.Fatalf("max_bytes=%d 结果不符：%+v", maxBytes, res)
		}
		if strings.ContainsRune(res.Text, '\uFFFD') {
			t.Fatalf("max_bytes=%d 文本不应含替换字符：%q", maxBytes, res.Text)
		}
	}
}

// 截断正好切开代理对（4 字节 emoji）时也不能吐出半个字符。
func TestReadFileUTF16TruncatedMidSurrogatePair(t *testing.T) {
	content := "日志😀内容"
	data := utf16Bytes(t, content, unicode.LittleEndian)
	// BOM(2) + 日(2) + 志(2) + 高代理(2)
	res, err := readFile(readArgs{Path: writeTempFile(t, data), MaxBytes: 8})
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	if !res.Truncated || res.Encoding != "utf-16le" {
		t.Fatalf("结果不符：%+v", res)
	}
	if res.Text != "日志" {
		t.Fatalf("文本不符：%q", res.Text)
	}
}

func TestReadFileTruncatedUTF8MidRune(t *testing.T) {
	// "日志内容" 每字 3 字节；max_bytes=7 会切在第三个字中间
	path := writeTempFile(t, []byte("日志内容"))
	res, err := readFile(readArgs{Path: path, MaxBytes: 7})
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	if !res.Truncated {
		t.Fatal("应当标记 truncated")
	}
	if res.Bytes != 7 {
		t.Fatalf("bytes 不符：%d", res.Bytes)
	}
	if res.Encoding != "utf-8" {
		t.Fatalf("截断在多字节边界上仍应判为 utf-8，实际 %s", res.Encoding)
	}
	if res.Text != "日志" {
		t.Fatalf("文本不符：%q", res.Text)
	}
}

func TestReadFileTruncatedGB18030MidRune(t *testing.T) { // GB18030 里每个汉字 2 字节；max_bytes=5 会切在第三个字中间
	path := writeTempFile(t, gb18030Bytes(t, "日志内容"))
	res, err := readFile(readArgs{Path: path, MaxBytes: 5})
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	if !res.Truncated || res.Encoding != "gb18030" {
		t.Fatalf("结果不符：%+v", res)
	}
	if res.Text != "日志" {
		t.Fatalf("文本不符：%q", res.Text)
	}
}

func TestReadFileExactBoundaryIsNotTruncated(t *testing.T) {
	path := writeTempFile(t, []byte("abcdef"))
	res, err := readFile(readArgs{Path: path, MaxBytes: 6})
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	if res.Truncated {
		t.Fatal("正好读满不应标记 truncated")
	}
	if res.Text != "abcdef" {
		t.Fatalf("文本不符：%q", res.Text)
	}
}

func TestReadFileMissing(t *testing.T) {
	_, err := readFile(readArgs{Path: filepath.Join(t.TempDir(), "nope.log")})
	if err == nil {
		t.Fatal("不存在的文件应当报错")
	}
	if !strings.Contains(err.Error(), "文件不存在") {
		t.Fatalf("错误信息应说明文件不存在：%v", err)
	}
}

func TestReadFileEmptyPath(t *testing.T) {
	if _, err := readFile(readArgs{}); err == nil {
		t.Fatal("空 path 应当报错")
	}
}

func TestReadFileMaxBytesClampedLocally(t *testing.T) {
	// 本地上限 = max(4×maxOutputChars, 64KiB)；请求更大的值应被钳位而不是报错。
	capBytes := readBytesLimit()
	path := writeTempFile(t, bytes.Repeat([]byte("x"), capBytes+128))
	res, err := readFile(readArgs{Path: path, MaxBytes: capBytes * 10})
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	if res.Bytes != capBytes {
		t.Fatalf("max_bytes 未被钳位：读到 %d 字节，上限 %d", res.Bytes, capBytes)
	}
	if !res.Truncated {
		t.Fatal("超过上限时应标记 truncated")
	}
}

func TestInjectedIntFallsBack(t *testing.T) {
	cases := []struct {
		raw      string
		fallback int
		want     int
	}{
		{"", 60000, 60000},
		{"   ", 20000, 20000},
		{"abc", 60000, 60000},
		{"0", 60000, 60000},
		{"-5", 60000, 60000},
		{" 30000 ", 60000, 30000},
		{"1234", 20000, 1234},
	}
	for _, c := range cases {
		if got := injectedInt(c.raw, c.fallback); got != c.want {
			t.Fatalf("injectedInt(%q,%d) = %d，want %d", c.raw, c.fallback, got, c.want)
		}
	}
}

// 构建注入值必须在本地生效：超大的 timeout_ms / max_output_chars 被按注入值封顶。
func TestResolvePshLimitsClampsToInjectedValues(t *testing.T) {
	oldTimeout, oldChars := pshTimeoutMs, maxOutputChars
	pshTimeoutMs, maxOutputChars = "30000", "1234"
	defer func() { pshTimeoutMs, maxOutputChars = oldTimeout, oldChars }()

	timeoutMS, limitChars := resolvePshLimits(pshArgs{TimeoutMS: 10 * 60 * 1000, MaxOutputChars: 999999})
	if timeoutMS != 30000 {
		t.Fatalf("timeout_ms 未按注入值封顶：%d", timeoutMS)
	}
	if limitChars != 1234 {
		t.Fatalf("max_output_chars 未按注入值封顶：%d", limitChars)
	}

	// 请求值小于注入值时尊重请求值。
	timeoutMS, limitChars = resolvePshLimits(pshArgs{TimeoutMS: 5000, MaxOutputChars: 100})
	if timeoutMS != 5000 || limitChars != 100 {
		t.Fatalf("较小的请求值应被保留：%d/%d", timeoutMS, limitChars)
	}

	// 缺省时用注入值。
	timeoutMS, limitChars = resolvePshLimits(pshArgs{})
	if timeoutMS != 30000 || limitChars != 1234 {
		t.Fatalf("缺省应使用注入值：%d/%d", timeoutMS, limitChars)
	}
}

func TestReadBytesLimit(t *testing.T) {
	oldChars := maxOutputChars
	defer func() { maxOutputChars = oldChars }()

	maxOutputChars = ""
	if got := readBytesLimit(); got != 80000 {
		t.Fatalf("默认上限应为 4×20000=80000，实际 %d", got)
	}
	maxOutputChars = "1000"
	if got := readBytesLimit(); got != minReadCapBytes {
		t.Fatalf("低于下限时应取 64KiB，实际 %d", got)
	}
}

func TestRunPshRejectsEmptyCommand(t *testing.T) {
	if _, err := runPsh(pshArgs{Command: "   "}); err == nil {
		t.Fatal("空 command 应当报错")
	}
}

func TestTruncateRunes(t *testing.T) {
	cases := []struct {
		in        string
		limit     int
		want      string
		truncated bool
	}{
		{"abc", 5, "abc", false},
		{"abcdef", 3, "abc", true},
		{"中文日志", 2, "中文", true},
		{"", 3, "", false},
	}
	for _, c := range cases {
		got, truncated := truncateRunes(c.in, c.limit)
		if got != c.want || truncated != c.truncated {
			t.Fatalf("truncateRunes(%q,%d) = (%q,%v)，want (%q,%v)",
				c.in, c.limit, got, truncated, c.want, c.truncated)
		}
	}
}

func TestLimitedBufferDropsExcess(t *testing.T) {
	buf := newLimitedBuffer(4)
	if _, err := buf.Write([]byte("abcdef")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if string(buf.Bytes()) != "abcd" {
		t.Fatalf("保留内容不符：%q", buf.Bytes())
	}
	if !buf.Dropped() {
		t.Fatal("应当报告丢弃")
	}

	small := newLimitedBuffer(8)
	small.Write([]byte("ab"))
	if small.Dropped() {
		t.Fatal("未超限不应报告丢弃")
	}
}

func TestDecodeOutput(t *testing.T) {
	if got := decodeOutput([]byte("正常 UTF-8")); got != "正常 UTF-8" {
		t.Fatalf("UTF-8 解码不符：%q", got)
	}
	if got := decodeOutput(gb18030Bytes(t, "错误：找不到文件")); got != "错误：找不到文件" {
		t.Fatalf("GB18030 解码不符：%q", got)
	}
}

func TestHandleToolReadFile(t *testing.T) {
	content := "hello\n"
	path := writeTempFile(t, []byte(content))
	u := &ui{w: io.Discard}

	args, err := json.Marshal(readArgs{Path: path})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	res := handleTool(u, request{ID: "abc", Tool: "read_file", Args: args})
	if !res.OK || res.ID != "abc" {
		t.Fatalf("回包不符：%+v", res)
	}
	result, ok := res.Result.(readResult)
	if !ok {
		t.Fatalf("result 类型不符：%T", res.Result)
	}
	if result.Text != content {
		t.Fatalf("文本不符：%q", result.Text)
	}
}

func TestHandleToolUnknown(t *testing.T) {
	u := &ui{w: io.Discard}
	res := handleTool(u, request{ID: "x", Tool: "rm_rf"})
	if res.OK || !strings.Contains(res.Error, "未知工具") {
		t.Fatalf("回包不符：%+v", res)
	}
}

func TestHandleToolBadArgs(t *testing.T) {
	u := &ui{w: io.Discard}
	res := handleTool(u, request{ID: "y", Tool: "read_file", Args: json.RawMessage(`"not an object"`)})
	if res.OK || res.Error == "" {
		t.Fatalf("参数非法时应回 ok:false：%+v", res)
	}
}

func TestHandleToolMissingFileIsNotFaked(t *testing.T) {
	u := &ui{w: io.Discard}
	args, _ := json.Marshal(readArgs{Path: filepath.Join(t.TempDir(), "gone.log")})
	res := handleTool(u, request{ID: "z", Tool: "read_file", Args: args})
	if res.OK || res.Result != nil {
		t.Fatalf("文件不存在必须回 ok:false 且无 result：%+v", res)
	}
}

func TestResponseJSONShape(t *testing.T) {
	failed, err := json.Marshal(response{ID: "i1", OK: false, Error: "原因"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(failed) != `{"id":"i1","ok":false,"error":"原因"}` {
		t.Fatalf("失败回包 JSON 不符：%s", failed)
	}

	okBody, err := json.Marshal(response{ID: "i2", OK: true, Result: pshResult{Exit: 0}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !bytes.Contains(okBody, []byte(`"result"`)) || bytes.Contains(okBody, []byte(`"error"`)) {
		t.Fatalf("成功回包 JSON 不符：%s", okBody)
	}
}
