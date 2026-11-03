package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

// 跨语言向量：psk / 两个 nonce / 明文固定，key 与密文由 Node 侧
// crypto.hkdfSync("sha256", ...) + AES-256-GCM 的等价实现算出（一次性生成后写死在这里）。
// 测试只用 crypto/aes 直接解密，不经过 seal()/open()，避免自引用。
const (
	vecPSKHex         = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
	vecClientNonceHex = "101112131415161718191a1b1c1d1e1f"
	vecServerNonceHex = "202122232425262728292a2b2c2d2e2f"
	vecKeyHex         = "f1c8f609cd5c2c3ad1efde1261a2540b65f10e9757fa1bc0bdfcf136507f4226"
	vecPlain          = `{"id":"vec-1","tool":"read_file","args":{"path":"C:\\logs\\a.log","max_bytes":262144}}`
	vecCipherHex      = "000102030405060708090a0b2443f76e290e4517049362fe943fbcdb686d71c41a4f2807e4d0be9e4725d90be7ea33dd2f67a0707aeda8bb1790833906d5b0ccd170ccc61edfa4d687994f0be8cda4f79dddf3b9765de07e446ca2796a07c3d136094a7ced3658b293a8b2d6b58a6cb1b4bd"
)

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("测试向量不是合法 hex：%v", err)
	}
	return b
}

func TestDeriveKeyMatchesVector(t *testing.T) {
	key, err := deriveKey(mustHex(t, vecPSKHex), mustHex(t, vecClientNonceHex), mustHex(t, vecServerNonceHex))
	if err != nil {
		t.Fatalf("deriveKey: %v", err)
	}
	if got := hex.EncodeToString(key); got != vecKeyHex {
		t.Fatalf("会话密钥不符\n got=%s\nwant=%s", got, vecKeyHex)
	}
}

// 用 stdlib 独立验证向量本身，再验证 open() 能还原明文。
func TestOpenCrossLanguageVector(t *testing.T) {
	key := mustHex(t, vecKeyHex)
	payload := mustHex(t, vecCipherHex)

	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatalf("aes.NewCipher: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("cipher.NewGCM: %v", err)
	}
	want, err := gcm.Open(nil, payload[:gcmNonceLen], payload[gcmNonceLen:], nil)
	if err != nil {
		t.Fatalf("固定向量无法用 stdlib 解开（向量本身有问题）：%v", err)
	}
	if string(want) != vecPlain {
		t.Fatalf("向量明文不符：%q", want)
	}

	got, err := open(key, payload)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if string(got) != vecPlain {
		t.Fatalf("open 结果不符：%q", got)
	}
}

// 反向：seal 出来的帧必须能被独立的 stdlib 路径解开（密文格式 = nonce||ct||tag）。
func TestSealMatchesStdlibLayout(t *testing.T) {
	key := mustHex(t, vecKeyHex)
	plaintext := []byte(vecPlain)

	payload, err := seal(key, plaintext)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if len(payload) != gcmNonceLen+len(plaintext)+16 {
		t.Fatalf("载荷长度不符：%d", len(payload))
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatalf("aes.NewCipher: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("cipher.NewGCM: %v", err)
	}
	decrypted, err := gcm.Open(nil, payload[:gcmNonceLen], payload[gcmNonceLen:], nil)
	if err != nil {
		t.Fatalf("stdlib 解 seal 结果失败：%v", err)
	}
	if string(decrypted) != vecPlain {
		t.Fatalf("解密结果不符：%q", decrypted)
	}
}

func TestSealOpenRoundTrip(t *testing.T) {
	key, err := deriveKey(mustHex(t, vecPSKHex), []byte("client-nonce-123"), []byte("server-nonce-456"))
	if err != nil {
		t.Fatalf("deriveKey: %v", err)
	}
	for _, plaintext := range []string{"", "a", strings.Repeat("中文 payload ", 500)} {
		payload, err := seal(key, []byte(plaintext))
		if err != nil {
			t.Fatalf("seal(%d bytes): %v", len(plaintext), err)
		}
		got, err := open(key, payload)
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		if string(got) != plaintext {
			t.Fatalf("往返不一致：got %q want %q", got, plaintext)
		}
	}
}

func TestSealUsesFreshNonce(t *testing.T) {
	key := mustHex(t, vecKeyHex)
	first, err := seal(key, []byte("same plaintext"))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	second, err := seal(key, []byte("same plaintext"))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if bytes.Equal(first[:gcmNonceLen], second[:gcmNonceLen]) {
		t.Fatalf("两次 seal 用了相同 nonce")
	}
}

func TestOpenRejectsTampering(t *testing.T) {
	key := mustHex(t, vecKeyHex)
	payload := mustHex(t, vecCipherHex)

	tamperedCT := append([]byte(nil), payload...)
	tamperedCT[len(tamperedCT)-1] ^= 0x01
	if _, err := open(key, tamperedCT); err == nil {
		t.Fatal("篡改密文后仍然解密成功")
	}

	tamperedNonce := append([]byte(nil), payload...)
	tamperedNonce[0] ^= 0xff
	if _, err := open(key, tamperedNonce); err == nil {
		t.Fatal("篡改 nonce 后仍然解密成功")
	}

	if _, err := open(key, payload[:len(payload)-1]); err == nil {
		t.Fatal("截断 tag 后仍然解密成功")
	}

	wrongKey := make([]byte, sessionKeyLen)
	if _, err := open(wrongKey, payload); err == nil {
		t.Fatal("错误密钥仍然解密成功")
	}
}

func TestOpenRejectsShortPayload(t *testing.T) {
	key := mustHex(t, vecKeyHex)
	for _, n := range []int{0, 1, gcmNonceLen - 1} {
		if _, err := open(key, make([]byte, n)); err == nil {
			t.Fatalf("载荷长度 %d 应当被拒绝", n)
		}
	}
}

func TestDeriveKeyRequires32BytePSK(t *testing.T) {
	if _, err := deriveKey(make([]byte, 16), []byte("a"), []byte("b")); err == nil {
		t.Fatal("短 PSK 应当报错")
	}
}

// 确认 hkdf 用法与协议一致（salt = clientNonce||serverNonce, info = "qqbot-agent/v1"）。
func TestDeriveKeyMatchesDirectHKDF(t *testing.T) {
	psk := mustHex(t, vecPSKHex)
	client := mustHex(t, vecClientNonceHex)
	server := mustHex(t, vecServerNonceHex)
	salt := append(append([]byte(nil), client...), server...)

	want, err := hkdf.Key(sha256.New, psk, salt, "qqbot-agent/v1", 32)
	if err != nil {
		t.Fatalf("hkdf.Key: %v", err)
	}
	got, err := deriveKey(psk, client, server)
	if err != nil {
		t.Fatalf("deriveKey: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("deriveKey 与直接 HKDF 不一致")
	}
}
