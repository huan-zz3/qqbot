package main

// 线协议 v1 的密码学与帧编解码（见 .slim/deepwork/agent-client/protocol.md）。

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

const (
	// hkdfInfo 是会话密钥派生的 info，与协议逐字一致。
	hkdfInfo = "qqbot-agent/v1"

	sessionKeyLen     = 32 // AES-256
	gcmNonceLen       = 12 // 载荷前缀
	handshakeNonceLen = 16 // 握手 nonce

	// maxFrameLen 是单帧载荷上限，超过即协议错误（防止对端一个长度头就吃满内存）。
	maxFrameLen = 64 << 20
)

// deriveKey 按协议派生会话密钥：HKDF-SHA256(psk, clientNonce||serverNonce, "qqbot-agent/v1", 32)。
func deriveKey(psk, clientNonce, serverNonce []byte) ([]byte, error) {
	if len(psk) != sessionKeyLen {
		return nil, fmt.Errorf("PSK 长度必须是 %d 字节，实际 %d 字节", sessionKeyLen, len(psk))
	}
	salt := make([]byte, 0, len(clientNonce)+len(serverNonce))
	salt = append(salt, clientNonce...)
	salt = append(salt, serverNonce...)
	key, err := hkdf.Key(sha256.New, psk, salt, hkdfInfo, sessionKeyLen)
	if err != nil {
		return nil, fmt.Errorf("HKDF 派生失败：%w", err)
	}
	return key, nil
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("初始化 AES 失败：%w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("初始化 GCM 失败：%w", err)
	}
	return aead, nil
}

// seal 把明文封成载荷：12 字节随机 nonce + 密文 + 16 字节 tag。无 AAD。
func seal(key, plaintext []byte) ([]byte, error) {
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcmNonceLen)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("生成 nonce 失败：%w", err)
	}
	out := make([]byte, gcmNonceLen, gcmNonceLen+len(plaintext)+aead.Overhead())
	copy(out, nonce)
	return aead.Seal(out, nonce, plaintext, nil), nil
}

// open 解载荷；tag 不对（密钥不符或数据被篡改）返回错误。
func open(key, payload []byte) ([]byte, error) {
	if len(payload) < gcmNonceLen {
		return nil, fmt.Errorf("帧载荷过短（%d 字节），缺少 nonce", len(payload))
	}
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	plaintext, err := aead.Open(nil, payload[:gcmNonceLen], payload[gcmNonceLen:], nil)
	if err != nil {
		return nil, errors.New("AES-GCM 认证失败（密钥不匹配或数据被篡改）")
	}
	return plaintext, nil
}

func randomBytes(n int) ([]byte, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return nil, fmt.Errorf("生成随机数失败：%w", err)
	}
	return buf, nil
}

// writeFrame 写 4 字节大端长度 + 载荷。调用方负责串行化写。
func writeFrame(w io.Writer, payload []byte) error {
	if len(payload) == 0 {
		return errors.New("帧载荷为空")
	}
	if len(payload) > maxFrameLen {
		return fmt.Errorf("帧载荷 %d 字节，超过上限 %d", len(payload), maxFrameLen)
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	if _, err := w.Write(header[:]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

// readFrame 读一帧。返回的载荷已去掉长度头。
func readFrame(r io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, io.EOF
		}
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, errors.New("帧长度头不完整")
		}
		return nil, err
	}
	length := binary.BigEndian.Uint32(header[:])
	if length == 0 {
		return nil, newProtocolError("收到长度为 0 的帧")
	}
	if length > maxFrameLen {
		return nil, newProtocolError("帧长度 %d 超过上限 %d 字节", length, maxFrameLen)
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, fmt.Errorf("帧载荷不完整（声明 %d 字节）", length)
		}
		return nil, err
	}
	return payload, nil
}
