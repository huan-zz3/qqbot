package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"testing"
)

// testToken 是测试用的 32 字节 token（base64），由密文 paired 帧下发
// （最后一个字符换成 b，避免它恰好以明文出现在其他断言里造成误判）。
var testToken = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0xa5}, 32))

// acceptHello 读取并校验明文 hello（只应有 v/kind/nonce），返回原始字节与客户端 nonce。
func acceptHello(conn net.Conn) (raw, clientNonce []byte, err error) {
	raw, err = readFrame(conn)
	if err != nil {
		return nil, nil, err
	}
	var hello helloFrame
	if err := json.Unmarshal(raw, &hello); err != nil {
		return nil, nil, fmt.Errorf("hello 不是合法 JSON：%w", err)
	}
	if hello.V != protocolVersion || hello.Kind != "hello" {
		return nil, nil, fmt.Errorf("hello 报文不符：v=%d kind=%q", hello.V, hello.Kind)
	}
	clientNonce, err = base64.StdEncoding.DecodeString(hello.Nonce)
	if err != nil || len(clientNonce) != handshakeNonceLen {
		return nil, nil, errors.New("客户端 nonce 非法")
	}
	return raw, clientNonce, nil
}

// writeHelloAck 发明文 hello-ack。
func writeHelloAck(conn net.Conn, serverNonce []byte) error {
	body, err := json.Marshal(serverFrame{
		V:     protocolVersion,
		Kind:  "hello-ack",
		Nonce: base64.StdEncoding.EncodeToString(serverNonce),
	})
	if err != nil {
		return err
	}
	return writeFrame(conn, body)
}

// writeReadyFrame 发送握手后的第一帧密文：{"kind":"ready"}，不带任何凭证。
func writeReadyFrame(conn net.Conn, key []byte) error {
	payload, err := seal(key, []byte(`{"kind":"ready"}`))
	if err != nil {
		return err
	}
	return writeFrame(conn, payload)
}

// readOpenFrame 读取客户端在 ready 之后立刻发来的密文 open 帧并解密。
func readOpenFrame(conn net.Conn, key []byte) (openFrame, error) {
	var frame openFrame
	raw, err := readFrame(conn)
	if err != nil {
		return frame, fmt.Errorf("等待 open 帧失败：%w", err)
	}
	plaintext, err := open(key, raw)
	if err != nil {
		return frame, fmt.Errorf("open 帧解密失败：%w", err)
	}
	if err := json.Unmarshal(plaintext, &frame); err != nil {
		return frame, fmt.Errorf("open 帧不是合法 JSON：%w", err)
	}
	if frame.Kind != "open" {
		return frame, fmt.Errorf("握手后客户端首帧应为 open，实际 kind=%q", frame.Kind)
	}
	return frame, nil
}

// writePairedFrame 发送密文 paired：配对码与 token 只在这里下发。
func writePairedFrame(conn net.Conn, key []byte, code, token string) error {
	body, err := json.Marshal(pairedFrame{Kind: "paired", Code: code, Token: token})
	if err != nil {
		return err
	}
	payload, err := seal(key, body)
	if err != nil {
		return err
	}
	return writeFrame(conn, payload)
}

// 假服务端按新帧序做完整握手，然后跑一条 read_file 调用。
func TestSessionHandshakeAndToolCall(t *testing.T) {
	psk := bytes.Repeat([]byte{0x07}, sessionKeyLen)
	path := writeTempFile(t, []byte("日志内容\n"))

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	serverErr := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			serverErr <- err
			return
		}
		defer conn.Close()

		_, clientNonce, err := acceptHello(conn)
		if err != nil {
			serverErr <- err
			return
		}
		serverNonce := bytes.Repeat([]byte{0x09}, handshakeNonceLen)
		if err := writeHelloAck(conn, serverNonce); err != nil {
			serverErr <- err
			return
		}
		key, err := deriveKey(psk, clientNonce, serverNonce)
		if err != nil {
			serverErr <- err
			return
		}
		if err := writeReadyFrame(conn, key); err != nil {
			serverErr <- err
			return
		}
		opened, err := readOpenFrame(conn, key)
		if err != nil {
			serverErr <- err
			return
		}
		if opened.Resume != nil {
			serverErr <- errors.New("首次连接不应带 resume")
			return
		}
		if err := writePairedFrame(conn, key, "12345678", testToken); err != nil {
			serverErr <- err
			return
		}

		args, _ := json.Marshal(readArgs{Path: path, MaxBytes: 1024})
		reqBody, _ := json.Marshal(request{ID: "req-1", Tool: "read_file", Args: args})
		payload, err := seal(key, reqBody)
		if err != nil {
			serverErr <- err
			return
		}
		if err := writeFrame(conn, payload); err != nil {
			serverErr <- err
			return
		}

		raw, err := readFrame(conn)
		if err != nil {
			serverErr <- err
			return
		}
		plaintext, err := open(key, raw)
		if err != nil {
			serverErr <- err
			return
		}
		var res response
		if err := json.Unmarshal(plaintext, &res); err != nil {
			serverErr <- err
			return
		}
		if res.ID != "req-1" || !res.OK {
			serverErr <- errors.New("回包 id/ok 不符")
			return
		}
		result, ok := res.Result.(map[string]any)
		if !ok || result["text"] != "日志内容\n" || result["encoding"] != "utf-8" {
			serverErr <- errors.New("回包 result 不符")
			return
		}
		serverErr <- nil
	}()

	sess, err := dialHandshake(ln.Addr().String(), psk, nil)
	if err != nil {
		t.Fatalf("dialHandshake: %v", err)
	}
	if sess.code != "12345678" {
		t.Fatalf("配对码不符：%q", sess.code)
	}
	if sess.token != testToken {
		t.Fatalf("token 应来自密文 paired 帧，实际 %q", sess.token)
	}
	if len(sess.key) != sessionKeyLen {
		t.Fatalf("会话密钥长度不符：%d", len(sess.key))
	}

	serveErr := sess.serve(&ui{w: io.Discard})
	sess.conn.Close()
	if serveErr != nil {
		var pe *protocolError
		if errors.As(serveErr, &pe) {
			t.Fatalf("不应出现协议错误：%v", serveErr)
		}
	}
	if err := <-serverErr; err != nil {
		t.Fatalf("服务端侧断言失败：%v", err)
	}
}

// 明文阶段的服务端 error 仍是明文帧：不解密，直接作为 handshakeError 返回。
func TestHandshakeErrorIsReported(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		if _, err := readFrame(conn); err != nil {
			return
		}
		body, _ := json.Marshal(serverFrame{V: protocolVersion, Kind: "error", Message: "PSK 不匹配"})
		writeFrame(conn, body)
	}()

	_, err = dialHandshake(ln.Addr().String(), bytes.Repeat([]byte{0x01}, sessionKeyLen), nil)
	var he *handshakeError
	if !errors.As(err, &he) {
		t.Fatalf("应返回 handshakeError，实际 %v", err)
	}
	if he.msg != "PSK 不匹配" {
		t.Fatalf("错误信息不符：%q", he.msg)
	}
}

func TestHandshakeVersionMismatch(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		if _, err := readFrame(conn); err != nil {
			return
		}
		body, _ := json.Marshal(serverFrame{
			V:     protocolVersion + 1,
			Kind:  "hello-ack",
			Nonce: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x02}, handshakeNonceLen)),
		})
		writeFrame(conn, body)
	}()

	_, err = dialHandshake(ln.Addr().String(), bytes.Repeat([]byte{0x01}, sessionKeyLen), nil)
	var he *handshakeError
	if !errors.As(err, &he) {
		t.Fatalf("版本不符应返回 handshakeError，实际 %v", err)
	}
	if !bytes.Contains([]byte(he.msg), []byte("版本不匹配")) {
		t.Fatalf("错误信息不符：%q", he.msg)
	}
}

func TestServeReportsProtocolErrorOnBadCiphertext(t *testing.T) {
	psk := bytes.Repeat([]byte{0x05}, sessionKeyLen)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, clientNonce, err := acceptHello(conn)
		if err != nil {
			return
		}
		serverNonce := bytes.Repeat([]byte{0x06}, handshakeNonceLen)
		if err := writeHelloAck(conn, serverNonce); err != nil {
			return
		}
		key, err := deriveKey(psk, clientNonce, serverNonce)
		if err != nil {
			return
		}
		if err := writeReadyFrame(conn, key); err != nil {
			return
		}
		if _, err := readOpenFrame(conn, key); err != nil {
			return
		}
		if err := writePairedFrame(conn, key, "12345678", testToken); err != nil {
			return
		}
		payload, err := seal(key, []byte(`{"id":"x","tool":"read_file","args":{"path":"/etc/hostname"}}`))
		if err != nil {
			return
		}
		payload[len(payload)-1] ^= 0xff // 破坏 tag
		writeFrame(conn, payload)
	}()

	sess, err := dialHandshake(ln.Addr().String(), psk, nil)
	if err != nil {
		t.Fatalf("dialHandshake: %v", err)
	}
	defer sess.conn.Close()

	err = sess.serve(&ui{w: io.Discard})
	var pe *protocolError
	if !errors.As(err, &pe) {
		t.Fatalf("解密失败应返回 protocolError，实际 %v", err)
	}
	if !bytes.Contains([]byte(pe.msg), []byte("解密失败")) {
		t.Fatalf("错误信息不符：%q", pe.msg)
	}
}

// 确认 Windows 路径的 JSON 转义与协议示例一致。
func TestReadArgsJSONEscaping(t *testing.T) {
	raw, err := json.Marshal(readArgs{Path: `C:\logs\a.log`})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(raw) != `{"path":"C:\\logs\\a.log","max_bytes":0}` {
		t.Fatalf("JSON 不符：%s", raw)
	}
}

// 两边 PSK 不同时，密文就绪帧解不开：必须报「密钥不匹配」，且是 pairingError（上层据此退出、不重连）。
func TestReadyFrameWrongPSKIsFatal(t *testing.T) {
	clientPSK := bytes.Repeat([]byte{0x11}, sessionKeyLen)
	serverPSK := bytes.Repeat([]byte{0x22}, sessionKeyLen)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, clientNonce, err := acceptHello(conn)
		if err != nil {
			return
		}
		serverNonce := bytes.Repeat([]byte{0x33}, handshakeNonceLen)
		if err := writeHelloAck(conn, serverNonce); err != nil {
			return
		}
		key, err := deriveKey(serverPSK, clientNonce, serverNonce)
		if err != nil {
			return
		}
		writeReadyFrame(conn, key)
	}()

	_, err = dialHandshake(ln.Addr().String(), clientPSK, nil)
	var pa *pairingError
	if !errors.As(err, &pa) {
		t.Fatalf("应返回 pairingError，实际 %v", err)
	}
	if !bytes.Contains([]byte(pa.msg), []byte("密钥不匹配")) {
		t.Fatalf("错误信息应提示密钥不匹配，实际：%q", pa.msg)
	}
	var pe *protocolError
	if errors.As(err, &pe) {
		t.Fatalf("密钥不匹配不应被当成可重连的协议错误：%v", err)
	}
}

// 能解开但不是 ready：按协议错误处理（打印原因后退出，不重连）。
func TestHandshakeRejectsUnexpectedFirstFrame(t *testing.T) {
	psk := bytes.Repeat([]byte{0x55}, sessionKeyLen)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, clientNonce, err := acceptHello(conn)
		if err != nil {
			return
		}
		serverNonce := bytes.Repeat([]byte{0x66}, handshakeNonceLen)
		if err := writeHelloAck(conn, serverNonce); err != nil {
			return
		}
		key, err := deriveKey(psk, clientNonce, serverNonce)
		if err != nil {
			return
		}
		payload, err := seal(key, []byte(`{"kind":"nope"}`))
		if err != nil {
			return
		}
		writeFrame(conn, payload)
	}()

	_, err = dialHandshake(ln.Addr().String(), psk, nil)
	var pe *protocolError
	if !errors.As(err, &pe) {
		t.Fatalf("非就绪帧应返回 protocolError，实际 %v", err)
	}
	if !bytes.Contains([]byte(pe.msg), []byte("就绪帧")) {
		t.Fatalf("错误信息不符：%q", pe.msg)
	}
}

// ① 明文的 hello 帧里绝不能出现 resume / token（链路上的旁观者拿到就能顶掉真客户端）。
// 这里带 resume 发起「重连」，断言服务端收到的原始字节里不含这两个词，也不含 token 本身。
func TestHelloFrameCarriesNoResumeOrToken(t *testing.T) {
	psk := bytes.Repeat([]byte{0x71}, sessionKeyLen)
	resume := &resumeInfo{Code: "12345678", Token: testToken}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	serverErr := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			serverErr <- err
			return
		}
		defer conn.Close()
		raw, clientNonce, err := acceptHello(conn)
		if err != nil {
			serverErr <- err
			return
		}
		for _, bad := range [][]byte{[]byte("resume"), []byte("token"), []byte(testToken)} {
			if bytes.Contains(raw, bad) {
				serverErr <- fmt.Errorf("明文 hello 里出现了 %q：%s", bad, raw)
				return
			}
		}
		serverNonce := bytes.Repeat([]byte{0x72}, handshakeNonceLen)
		if err := writeHelloAck(conn, serverNonce); err != nil {
			serverErr <- err
			return
		}
		key, err := deriveKey(psk, clientNonce, serverNonce)
		if err != nil {
			serverErr <- err
			return
		}
		if err := writeReadyFrame(conn, key); err != nil {
			serverErr <- err
			return
		}
		if _, err := readOpenFrame(conn, key); err != nil {
			serverErr <- err
			return
		}
		serverErr <- writePairedFrame(conn, key, resume.Code, testToken)
	}()

	sess, err := dialHandshake(ln.Addr().String(), psk, resume)
	if err != nil {
		t.Fatalf("dialHandshake: %v", err)
	}
	defer sess.conn.Close()
	if err := <-serverErr; err != nil {
		t.Fatalf("服务端侧断言失败：%v", err)
	}
}

// ② 重连时 token 只出现在密文 open 帧里：服务端解密后必须看到原样回传的 resume。
// 同时把握手期间收到的所有明文帧拼起来，断言里面没有 token。
func TestResumeTokenOnlyInEncryptedOpenFrame(t *testing.T) {
	psk := bytes.Repeat([]byte{0x73}, sessionKeyLen)
	resume := &resumeInfo{Code: "87654321", Token: testToken}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	type result struct {
		plaintextSeen []byte
		opened        openFrame
		err           error
	}
	got := make(chan result, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			got <- result{err: err}
			return
		}
		defer conn.Close()
		raw, clientNonce, err := acceptHello(conn)
		if err != nil {
			got <- result{err: err}
			return
		}
		serverNonce := bytes.Repeat([]byte{0x74}, handshakeNonceLen)
		if err := writeHelloAck(conn, serverNonce); err != nil {
			got <- result{err: err}
			return
		}
		key, err := deriveKey(psk, clientNonce, serverNonce)
		if err != nil {
			got <- result{err: err}
			return
		}
		if err := writeReadyFrame(conn, key); err != nil {
			got <- result{err: err}
			return
		}
		opened, err := readOpenFrame(conn, key)
		if err != nil {
			got <- result{err: err}
			return
		}
		if err := writePairedFrame(conn, key, resume.Code, testToken); err != nil {
			got <- result{err: err}
			return
		}
		got <- result{plaintextSeen: raw, opened: opened}
	}()

	sess, err := dialHandshake(ln.Addr().String(), psk, resume)
	if err != nil {
		t.Fatalf("dialHandshake: %v", err)
	}
	defer sess.conn.Close()

	res := <-got
	if res.err != nil {
		t.Fatalf("服务端侧失败：%v", res.err)
	}
	if bytes.Contains(res.plaintextSeen, []byte(testToken)) ||
		bytes.Contains(res.plaintextSeen, []byte("token")) {
		t.Fatalf("明文段里出现了 token：%s", res.plaintextSeen)
	}
	if res.opened.Resume == nil {
		t.Fatal("重连时 open 帧必须带 resume")
	}
	if res.opened.Resume.Code != resume.Code || res.opened.Resume.Token != resume.Token {
		t.Fatalf("open 帧里的 resume 不符：%+v", *res.opened.Resume)
	}
	if sess.code != resume.Code || sess.token != testToken {
		t.Fatalf("配对结果不符：code=%q token=%q", sess.code, sess.token)
	}
}
