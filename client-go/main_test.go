package main

import (
	"strings"
	"testing"
)

func TestParseEndpoint(t *testing.T) {
	ok, err := parseEndpoint("tcp://1.2.3.4:7801")
	if err != nil {
		t.Fatalf("有效地址被拒绝：%v", err)
	}
	if ok != "1.2.3.4:7801" {
		t.Fatalf("解析结果不符：%q", ok)
	}
	if _, err := parseEndpoint("tcp://[::1]:7801"); err != nil {
		t.Fatalf("IPv6 地址被拒绝：%v", err)
	}

	bad := []struct{ raw, hint string }{
		{"", "未注入"},
		{"   ", "未注入"},
		{"1.2.3.4:7801", "tcp://"},
		{"ws://1.2.3.4:7801", "tcp://"},
		{"tcp://1.2.3.4", "格式非法"},
		{"tcp://:7801", "格式非法"},
		{"tcp://1.2.3.4:0", "端口非法"},
		{"tcp://1.2.3.4:70000", "端口非法"},
		{"tcp://1.2.3.4:abc", "端口非法"},
	}
	for _, c := range bad {
		_, err := parseEndpoint(c.raw)
		if err == nil {
			t.Fatalf("%q 应当报错", c.raw)
		}
		if !strings.Contains(err.Error(), c.hint) {
			t.Fatalf("%q 的错误信息应包含 %q：%v", c.raw, c.hint, err)
		}
	}
}

func TestParsePSK(t *testing.T) {
	key, err := parsePSK("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	if err != nil {
		t.Fatalf("有效 PSK 被拒绝：%v", err)
	}
	if len(key) != sessionKeyLen {
		t.Fatalf("PSK 长度不符：%d", len(key))
	}

	bad := []struct{ raw, hint string }{
		{"", "未注入"},
		{"zz", "十六进制"},
		{"00010203", "32 字节"},
		{"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f00", "32 字节"},
	}
	for _, c := range bad {
		_, err := parsePSK(c.raw)
		if err == nil {
			t.Fatalf("%q 应当报错", c.raw)
		}
		if !strings.Contains(err.Error(), c.hint) {
			t.Fatalf("%q 的错误信息应包含 %q：%v", c.raw, c.hint, err)
		}
	}
}

func TestSummarize(t *testing.T) {
	if got := summarize("Get-Process\r\n  | Select-Object", 60); got != "Get-Process | Select-Object" {
		t.Fatalf("多行压缩不符：%q", got)
	}
	if got := summarize("", 10); got != "（空）" {
		t.Fatalf("空命令不符：%q", got)
	}
	got := summarize(strings.Repeat("中", 10), 4)
	if !strings.HasPrefix(got, "中中中中") || !strings.HasSuffix(got, "…") {
		t.Fatalf("限长不符：%q", got)
	}
}

func TestHumanBytes(t *testing.T) {
	cases := map[int]string{
		0:       "0 B",
		999:     "999 B",
		1024:    "1.0 KB",
		1536:    "1.5 KB",
		1 << 20: "1.0 MB",
	}
	for n, want := range cases {
		if got := humanBytes(n); got != want {
			t.Fatalf("humanBytes(%d) = %q，want %q", n, got, want)
		}
	}
}
