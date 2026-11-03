package main

// 跨语言互通向量：由 TS 侧 src/agent-client/crypto.ts 的真实实现生成（一次性实测输出，不得修改）。
// 本文件把 TS 服务端与 Go 客户端的线格式钉死：密钥派生、载荷布局、GCM 语义任一漂移都会失败。

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"testing"
)

const (
	interopPSKHex        = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
	interopClientNonce   = "EREREREREREREREREREREQ=="
	interopServerNonce   = "IiIiIiIiIiIiIiIiIiIiIg=="
	interopKeyHex        = "23cb6733ec43cda149a111581c811567a65ec98b3c14afdf93af6f0d1796332d"
	interopPayloadB64    = "MzMzMzMzMzMzMzMzNAwcEnH0a+RaMVvGmKGhjpwKaV7QhiCZ5pOU8t1KG+tnzzz3l6E8SykF5NJkK4UkCsfrd2Aa2XAPxNnYE5EvL9B4ruEbGkZLdTfOmn0="
	interopPlaintextJSON = `{"id":"probe-1","tool":"run_psh","args":{"command":"whoami"}}`
)

func interopB64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatalf("测试向量不是合法 base64：%v", err)
	}
	return b
}

// 断言 1：同一 psk + clientNonce||serverNonce + info "qqbot-agent/v1" 必须派生出 TS 侧的 keyHex。
func TestInteropDeriveKey(t *testing.T) {
	psk := mustHex(t, interopPSKHex)
	client := interopB64(t, interopClientNonce)
	server := interopB64(t, interopServerNonce)

	key, err := deriveKey(psk, client, server)
	if err != nil {
		t.Fatalf("deriveKey: %v", err)
	}
	if got := hex.EncodeToString(key); got != interopKeyHex {
		t.Fatalf("会话密钥与 TS 不一致\n got=%s\nwant=%s", got, interopKeyHex)
	}
}

// 断言 2：用该 key 打开 TS 产出的 payload，必须得到与 plaintext 逐字节相同的字节串。
func TestInteropOpenTSPayload(t *testing.T) {
	key := mustHex(t, interopKeyHex)
	payload := interopB64(t, interopPayloadB64)

	got, err := open(key, payload)
	if err != nil {
		t.Fatalf("open TS 载荷失败（TS 与 Go 不互通）：%v", err)
	}
	if !bytes.Equal(got, []byte(interopPlaintextJSON)) {
		t.Fatalf("明文不逐字节相同\n got=%q\nwant=%q", got, interopPlaintextJSON)
	}
}

// 断言 3：反方向 —— 固定 nonce 0x33×12 封出的载荷前 12 字节是 nonce、后 16 字节是 tag，
// 且同一 key 必须能解开。注意：给定的 TS 载荷本身就是用 nonce 0x33×12 生成的
// （payloadB64 前 12 字节实测为 333333333333333333333333），因此这里应增强为整段逐字节相等；
// “随机 nonce 语义”由 seal() 单独验证。
func TestInteropSealFixedNonce(t *testing.T) {
	key := mustHex(t, interopKeyHex)
	plaintext := []byte(interopPlaintextJSON)
	tsPayload := interopB64(t, interopPayloadB64)

	nonce := bytes.Repeat([]byte{0x33}, gcmNonceLen)
	aead, err := newAEAD(key)
	if err != nil {
		t.Fatalf("newAEAD: %v", err)
	}
	body := aead.Seal(nil, nonce, plaintext, nil) // 密文 || tag
	payload := append(append([]byte(nil), nonce...), body...)

	if !bytes.Equal(payload[:gcmNonceLen], nonce) {
		t.Fatalf("载荷前 %d 字节不是 nonce：%x", gcmNonceLen, payload[:gcmNonceLen])
	}
	tagLen := aead.Overhead()
	if tagLen != 16 {
		t.Fatalf("GCM tag 长度应为 16，实际 %d", tagLen)
	}
	wantTag := body[len(body)-tagLen:]
	if !bytes.Equal(payload[len(payload)-tagLen:], wantTag) {
		t.Fatalf("载荷末 %d 字节不是 tag：%x", tagLen, payload[len(payload)-tagLen:])
	}
	// 预期相等：TS 向量用的就是同一个固定 nonce。整段相等是比“前 12 字节 + 后 16 字节”更强的格式证明。
	if !bytes.Equal(payload, tsPayload) {
		t.Fatalf("固定 nonce 载荷与 TS 载荷不逐字节相同\n got=%x\nwant=%x", payload, tsPayload)
	}

	got, err := open(key, payload)
	if err != nil {
		t.Fatalf("open 固定 nonce 载荷失败：%v", err)
	}
	if !bytes.Equal(got, plaintext) {
		t.Fatalf("回开明文不符：%q", got)
	}

	// 随机 nonce 语义：真实 seal() 每次取新 nonce，不能命中固定值，且能自洽解开。
	first, err := seal(key, plaintext)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	second, err := seal(key, plaintext)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if bytes.Equal(first[:gcmNonceLen], nonce) || bytes.Equal(second[:gcmNonceLen], nonce) {
		t.Fatal("seal 使用了固定 nonce，随机 nonce 语义不符")
	}
	if bytes.Equal(first[:gcmNonceLen], second[:gcmNonceLen]) {
		t.Fatal("两次 seal 的 nonce 相同，随机 nonce 语义不符")
	}
	back, err := open(key, first)
	if err != nil || !bytes.Equal(back, plaintext) {
		t.Fatalf("seal/open 往返失败：err=%v got=%q", err, back)
	}
}
