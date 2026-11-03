package main

// 心跳、控制帧与可重连判定的测试。

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// startFakeServer 起一个按新帧序握手的假服务端：
// 明文 hello → 明文 hello-ack → 密文 ready → 密文 open（断言无 resume）→ 密文 paired，
// 之后把连接与派生出的会话密钥交给 then。then 返回的错误经 done 回传。
func startFakeServer(t *testing.T, psk []byte, code string, then func(net.Conn, []byte) error) (string, <-chan error) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	done := make(chan error, 1)
	go func() {
		defer ln.Close()
		conn, err := ln.Accept()
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()

		_, clientNonce, err := acceptHello(conn)
		if err != nil {
			done <- err
			return
		}
		serverNonce := bytes.Repeat([]byte{0x5a}, handshakeNonceLen)
		if err := writeHelloAck(conn, serverNonce); err != nil {
			done <- err
			return
		}
		key, err := deriveKey(psk, clientNonce, serverNonce)
		if err != nil {
			done <- err
			return
		}
		if err := writeReadyFrame(conn, key); err != nil {
			done <- err
			return
		}
		// open 帧就是客户端持有 PSK 的证明，也是它主动把码变可兑付的唯一动作。
		opened, err := readOpenFrame(conn, key)
		if err != nil {
			done <- err
			return
		}
		if opened.Resume != nil {
			done <- errors.New("首次连接不应带 resume")
			return
		}
		if err := writePairedFrame(conn, key, code, testToken); err != nil {
			done <- err
			return
		}
		done <- then(conn, key)
	}()
	return ln.Addr().String(), done
}

// 收到密文 ping 必须回 {"kind":"pong"}。
func TestPingGetsPong(t *testing.T) {
	psk := bytes.Repeat([]byte{0x31}, sessionKeyLen)
	addr, done := startFakeServer(t, psk, "11112222", func(conn net.Conn, key []byte) error {
		payload, err := seal(key, []byte(`{"kind":"ping"}`))
		if err != nil {
			return err
		}
		if err := writeFrame(conn, payload); err != nil {
			return err
		}
		raw, err := readFrame(conn)
		if err != nil {
			return err
		}
		plaintext, err := open(key, raw)
		if err != nil {
			return err
		}
		var pong controlFrame
		if err := json.Unmarshal(plaintext, &pong); err != nil {
			return err
		}
		if pong.Kind != "pong" {
			return errors.New("未回 pong，实际 kind=" + pong.Kind)
		}
		return nil
	})

	sess, err := dialHandshake(addr, psk, nil)
	if err != nil {
		t.Fatalf("dialHandshake: %v", err)
	}
	_ = sess.serve(&ui{w: io.Discard})
	sess.conn.Close()
	if err := <-done; err != nil {
		t.Fatalf("服务端侧断言失败：%v", err)
	}
}

// 无 id 的控制帧不能走工具路径；未知 kind 只记日志并忽略，后续工具帧照常处理。
func TestControlFramesAreNotToolCalls(t *testing.T) {
	psk := bytes.Repeat([]byte{0x32}, sessionKeyLen)
	path := writeTempFile(t, []byte("你好\n"))
	addr, done := startFakeServer(t, psk, "33334444", func(conn net.Conn, key []byte) error {
		for _, body := range []string{`{"kind":"nonsense"}`, `{"kind":"pong"}`} {
			payload, err := seal(key, []byte(body))
			if err != nil {
				return err
			}
			if err := writeFrame(conn, payload); err != nil {
				return err
			}
		}
		args, _ := json.Marshal(readArgs{Path: path})
		reqBody, _ := json.Marshal(request{ID: "tool-1", Tool: "read_file", Args: args})
		payload, err := seal(key, reqBody)
		if err != nil {
			return err
		}
		if err := writeFrame(conn, payload); err != nil {
			return err
		}
		raw, err := readFrame(conn)
		if err != nil {
			return err
		}
		plaintext, err := open(key, raw)
		if err != nil {
			return err
		}
		var res response
		if err := json.Unmarshal(plaintext, &res); err != nil {
			return err
		}
		if res.ID != "tool-1" || !res.OK {
			return errors.New("工具帧未被正常处理")
		}
		return nil
	})

	sess, err := dialHandshake(addr, psk, nil)
	if err != nil {
		t.Fatalf("dialHandshake: %v", err)
	}
	_ = sess.serve(&ui{w: io.Discard})
	sess.conn.Close()
	if err := <-done; err != nil {
		t.Fatalf("服务端侧断言失败：%v", err)
	}
}

// 对端静默超过 readIdleTimeout 必须判为断线（可重连），而不是协议错误。
func TestReadTimeoutIsReconnectable(t *testing.T) {
	old := readIdleTimeout
	readIdleTimeout = 120 * time.Millisecond
	defer func() { readIdleTimeout = old }()

	psk := bytes.Repeat([]byte{0x33}, sessionKeyLen)
	release := make(chan struct{})
	addr, done := startFakeServer(t, psk, "55556666", func(conn net.Conn, key []byte) error {
		<-release // 保持静默，等客户端自己判死
		return nil
	})

	sess, err := dialHandshake(addr, psk, nil)
	if err != nil {
		t.Fatalf("dialHandshake: %v", err)
	}
	defer sess.conn.Close()

	started := time.Now()
	err = sess.serve(&ui{w: io.Discard})
	close(release)
	if err == nil {
		t.Fatal("静默超时应返回错误")
	}
	var pe *protocolError
	if errors.As(err, &pe) {
		t.Fatalf("读超时应视为可重连的普通错误，实际 %v", err)
	}
	if !strings.Contains(err.Error(), "未收到") {
		t.Fatalf("错误信息应说明静默超时：%v", err)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("判死太慢：%s", elapsed)
	}
	<-done
}

// 服务端回了 hello-ack 却读不到密文就绪帧（超时/读错误）：可重连，不能当成协议错误或密钥不匹配。
func TestReadyFrameReadErrorIsReconnectable(t *testing.T) {
	psk := bytes.Repeat([]byte{0x34}, sessionKeyLen)
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
		if _, err := readFrame(conn); err != nil {
			conn.Close()
			return
		}
		writeHelloAck(conn, bytes.Repeat([]byte{0x5b}, handshakeNonceLen))
		conn.Close() // 不发就绪帧，直接断开
	}()

	_, err = dialHandshake(ln.Addr().String(), psk, nil)
	if err == nil {
		t.Fatal("缺少就绪帧应当报错")
	}
	var pe *protocolError
	if errors.As(err, &pe) {
		t.Fatalf("就绪帧读错误不应是协议错误：%v", err)
	}
	var pa *pairingError
	if errors.As(err, &pa) {
		t.Fatalf("就绪帧读错误不应被判成密钥不匹配：%v", err)
	}
	if !strings.Contains(err.Error(), "就绪帧") {
		t.Fatalf("错误信息不符：%v", err)
	}
}

// error 帧的 retry 标志必须原样带给上层：true=退避重试，false=退出。
// 明文阶段（hello 之后）的 error 是明文帧；派生 key 之后的 error 是密文帧——两条路径分别覆盖。
func TestHandshakeErrorCarriesRetryFlag(t *testing.T) {
	psk := bytes.Repeat([]byte{0x01}, sessionKeyLen)
	cases := []struct {
		name      string
		body      string
		retry     bool
		encrypted bool
	}{
		{"plaintext retry true", `{"v":1,"kind":"error","message":"在线客户端已达上限","retry":true}`, true, false},
		{"plaintext retry false", `{"v":1,"kind":"error","message":"版本不匹配","retry":false}`, false, false},
		{"plaintext retry absent", `{"v":1,"kind":"error","message":"版本不匹配"}`, false, false},
		{"encrypted retry true", `{"kind":"error","message":"在线客户端已达上限","retry":true}`, true, true},
		{"encrypted retry false", `{"kind":"error","message":"token 失效","retry":false}`, false, true},
		{"encrypted retry absent", `{"kind":"error","message":"token 失效"}`, false, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
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
				if !c.encrypted {
					if _, err := readFrame(conn); err != nil {
						return
					}
					writeFrame(conn, []byte(c.body))
					return
				}
				_, clientNonce, err := acceptHello(conn)
				if err != nil {
					return
				}
				serverNonce := bytes.Repeat([]byte{0x02}, handshakeNonceLen)
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
				payload, err := seal(key, []byte(c.body))
				if err != nil {
					return
				}
				writeFrame(conn, payload)
			}()

			_, err = dialHandshake(ln.Addr().String(), psk, nil)
			var he *handshakeError
			if !errors.As(err, &he) {
				t.Fatalf("应返回 handshakeError，实际 %v", err)
			}
			if he.retry != c.retry {
				t.Fatalf("retry 不符：got %v want %v", he.retry, c.retry)
			}
		})
	}
}

// 未派生 key 时不能把密文 error 当明文解；反过来派生 key 之后也不该再按明文解析。
// 这里让服务端在密文阶段发一帧「看着像明文 error」的帧——客户端必须解密，
// 而按明文解析会得到错误结论（帧本身是密文，JSON 解析必失败）。
func TestEncryptedStageErrorIsNotParsedAsPlaintext(t *testing.T) {
	psk := bytes.Repeat([]byte{0x03}, sessionKeyLen)
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
		serverNonce := bytes.Repeat([]byte{0x04}, handshakeNonceLen)
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
		// 未加密的「error」帧出现在密文阶段：按 Protocol 属协议错误，不能被当成可重试的握手拒绝。
		writeFrame(conn, []byte(`{"kind":"error","message":"伪装成明文","retry":true}`))
	}()

	_, err = dialHandshake(ln.Addr().String(), psk, nil)
	var he *handshakeError
	if errors.As(err, &he) {
		t.Fatalf("密文阶段的明文帧不应被当成 error 帧：%v", err)
	}
	var pe *protocolError
	if !errors.As(err, &pe) {
		t.Fatalf("应返回 protocolError，实际 %v", err)
	}
}
