package main

// 连接、握手与一个会话的收包/回包循环。

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

// protocolError 表示对端违反了线协议：断开后不再重连。
type protocolError struct{ msg string }

func (e *protocolError) Error() string { return e.msg }

func newProtocolError(format string, a ...any) error {
	return &protocolError{msg: fmt.Sprintf(format, a...)}
}

// handshakeError 表示服务端在握手阶段回了 error 帧（PSK 不匹配、版本不符、认领失败等）。
// retry 来自 error 帧的 retry 字段：true 表示暂时性（名额已满等），上层退避重试。
type handshakeError struct {
	msg   string
	retry bool
}

func (e *handshakeError) Error() string { return e.msg }

// pairingError 表示密文就绪帧（ready）解不开：两边 PSK 不同。
// 此时服务端还没收到 open、也没回 paired；同一份构建的 PSK 不会自己变，
// 重试永远不会成功，所以上层直接退出、不重连。
type pairingError struct{ msg string }

func (e *pairingError) Error() string { return e.msg }

type resumeInfo struct {
	Code  string `json:"code"`
	Token string `json:"token"`
}

// helloFrame 是明文握手第一帧：只交换版本与 nonce。
// 重连凭证 token 绝不放进这里——链路上的旁观者拿到就能顶掉真客户端。
type helloFrame struct {
	V     int    `json:"v"`
	Kind  string `json:"kind"`
	Nonce string `json:"nonce"`
}

// serverFrame 是明文握手的第二帧（hello-ack），或明文阶段的 error 帧。
type serverFrame struct {
	V       int    `json:"v"`
	Kind    string `json:"kind"`
	Nonce   string `json:"nonce"`
	Message string `json:"message"`
	Retry   *bool  `json:"retry"`
}

// readyFrame 是明文握手之后第一帧密文：只证明服务端持有 PSK，不带任何凭证。
type readyFrame struct {
	Kind string `json:"kind"`
}

// openFrame 是客户端对 ready 的应答：首次连接不带 resume，重连带上一轮的码与 token。
// 这一帧是客户端持有 PSK 的证明，服务端凭它把码标为可兑付。
type openFrame struct {
	Kind   string      `json:"kind"`
	Resume *resumeInfo `json:"resume,omitempty"`
}

// pairedFrame 是服务端对 open 的回应（密文）：码与重连凭证 token 只在这里下发。
type pairedFrame struct {
	Kind    string `json:"kind"`
	Code    string `json:"code"`
	Token   string `json:"token"`
	Message string `json:"message"`
	Retry   *bool  `json:"retry"`
}

// controlFrame 是无 id 的控制帧（ping/pong/ready）。有 id 的才是工具帧。
type controlFrame struct {
	Kind string `json:"kind"`
}

// request / response 即协议里的信封。
type request struct {
	ID   string          `json:"id"`
	Tool string          `json:"tool"`
	Args json.RawMessage `json:"args"`

	// receivedAt 是读到这一帧的时刻（不是开始执行的时刻）：run_batch 的预算从这里起算。
	// 客户端串行执行，帧可能在队列里等前一个调用，等待时间同样要吃掉预算。
	receivedAt time.Time `json:"-"`
}

type response struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type session struct {
	conn  net.Conn
	key   []byte
	code  string
	token string // base64(32B)，来自密文 paired 帧，重连时原样回传（只在密文 open 帧里）

	writeMu sync.Mutex // 回包与 pong 共用，读包 goroutine 也会写
}

// dialHandshake 建立一条连接并完成握手。resume 为 nil 表示首次连接。
//
// 帧序（逐字按协议）：明文 hello → 明文 hello-ack → 密文 ready → 密文 open → 密文 paired/error。
// 明文段只交换版本与 nonce，token 只在密文 paired 里下发、在密文 open 里回传。
func dialHandshake(addr string, psk []byte, resume *resumeInfo) (*session, error) {
	conn, err := net.DialTimeout("tcp", addr, dialTimeout)
	if err != nil {
		return nil, fmt.Errorf("连接 %s 失败：%w", addr, err)
	}
	established := false
	defer func() {
		if !established {
			conn.Close()
		}
	}()

	// 握手总超时：一个绝对截止时间贯穿到收到 paired 为止，而不是每次读各给 10s。
	deadline := time.Now().Add(handshakeTimeout)
	if err := conn.SetDeadline(deadline); err != nil {
		return nil, err
	}

	clientNonce, err := randomBytes(handshakeNonceLen)
	if err != nil {
		return nil, err
	}
	hello, err := json.Marshal(helloFrame{
		V:     protocolVersion,
		Kind:  "hello",
		Nonce: base64.StdEncoding.EncodeToString(clientNonce),
	})
	if err != nil {
		return nil, fmt.Errorf("编码握手报文失败：%w", err)
	}
	if err := writeFrame(conn, hello); err != nil {
		return nil, fmt.Errorf("发送握手失败：%w", err)
	}

	// 明文 hello-ack：只校验版本/kind/nonce。
	raw, err := readFrame(conn)
	if err != nil {
		return nil, fmt.Errorf("等待握手响应失败：%w", err)
	}
	var sf serverFrame
	if err := json.Unmarshal(raw, &sf); err != nil {
		return nil, newProtocolError("握手响应不是合法 JSON：%v", err)
	}
	// 明文阶段的 error 仍是明文；此时的 conn 还没有 key，不存在"先试明文再试密文"的分支。
	if sf.Kind == "error" {
		return nil, &handshakeError{msg: errorMessage(sf.Message), retry: sf.Retry != nil && *sf.Retry}
	}
	if sf.Kind != "hello-ack" {
		return nil, newProtocolError("握手响应类型未知（kind=%q，应为 hello-ack）", sf.Kind)
	}
	if sf.V != protocolVersion {
		return nil, &handshakeError{msg: fmt.Sprintf(
			"协议版本不匹配（服务端 v=%d，客户端 v=%d），请重新获取客户端", sf.V, protocolVersion)}
	}
	serverNonce, err := base64.StdEncoding.DecodeString(sf.Nonce)
	if err != nil || len(serverNonce) != handshakeNonceLen {
		return nil, newProtocolError("握手响应里的 nonce 非法")
	}
	key, err := deriveKey(psk, clientNonce, serverNonce)
	if err != nil {
		return nil, err
	}

	// 密文 ready：按协议这是服务端的 PSK 证明。
	// 解不开即说明两边 PSK 不同（HKDF 派生出的会话密钥也就不同），
	// 此时立刻报错退出，不要拖到第一次工具调用才表现为 90 秒超时。
	// 读这一帧超时/读错误不属于永久失败：交给上层按可重连处理。
	rawReady, err := readFrame(conn)
	if err != nil {
		return nil, fmt.Errorf("等待就绪帧失败：%w", err)
	}
	readyPlain, err := open(key, rawReady)
	if err != nil {
		return nil, &pairingError{msg: "配对失败：密钥不匹配（客户端与服务端构建时用的 PSK 不同）"}
	}
	var ready readyFrame
	if err := json.Unmarshal(readyPlain, &ready); err != nil {
		return nil, newProtocolError("就绪帧不是合法 JSON：%v", err)
	}
	if ready.Kind != "ready" {
		return nil, newProtocolError("握手后第一帧不是就绪帧（kind=%q）", ready.Kind)
	}

	// 密文 open：解出 ready 后立刻主动发，这是客户端持有 PSK 的证明，也顺带回传重连凭证。
	// 服务端反向要求「收到合法 open 才把码标为可兑付」，不发就要等它第一次 ping（20 秒）。
	openBody, err := json.Marshal(openFrame{Kind: "open", Resume: resume})
	if err != nil {
		return nil, fmt.Errorf("编码 open 帧失败：%w", err)
	}
	openPayload, err := seal(key, openBody)
	if err != nil {
		return nil, err
	}
	if err := writeFrame(conn, openPayload); err != nil {
		return nil, fmt.Errorf("发送 open 帧失败：%w", err)
	}

	// 密文 paired / error：此时 key 已派生，所以一律按密文解。
	rawResult, err := readFrame(conn)
	if err != nil {
		return nil, fmt.Errorf("等待配对结果失败：%w", err)
	}
	resultPlain, err := open(key, rawResult)
	if err != nil {
		return nil, newProtocolError("配对结果解密失败：%v", err)
	}
	var pf pairedFrame
	if err := json.Unmarshal(resultPlain, &pf); err != nil {
		return nil, newProtocolError("配对结果不是合法 JSON：%v", err)
	}
	switch pf.Kind {
	case "error":
		return nil, &handshakeError{msg: errorMessage(pf.Message), retry: pf.Retry != nil && *pf.Retry}
	case "paired":
	default:
		return nil, newProtocolError("配对结果类型未知（kind=%q）", pf.Kind)
	}
	if pf.Code == "" {
		return nil, newProtocolError("配对结果缺少配对码")
	}
	token, err := base64.StdEncoding.DecodeString(pf.Token)
	if err != nil || len(token) != 32 {
		return nil, newProtocolError("配对结果里的 token 非法")
	}

	if err := conn.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	established = true
	return &session{conn: conn, key: key, code: pf.Code, token: pf.Token}, nil
}

// errorMessage 兜底服务端没给原因的情况。
func errorMessage(msg string) string {
	if msg == "" {
		return "服务端未给出原因"
	}
	return msg
}

// readIdleTimeout 是静默断线判定：超过这么久没读到任何可解密帧就按断线重连。
// 协议要求 45s；做成包级变量仅为测试能改小。
var readIdleTimeout = 45 * time.Second

// serve 串行执行工具调用：读包 goroutine 入队，主循环一次只跑一个，按到达顺序回包。
// 返回 nil 或普通错误表示断线（可重连）；返回 *protocolError 表示协议错误（不重连）。
func (s *session) serve(u *ui) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	queue := make(chan request, 16)
	errCh := make(chan error, 1)
	go s.readLoop(ctx, queue, errCh, u)

	for {
		select {
		case req := <-queue:
			done := make(chan response, 1)
			go func(r request) { done <- handleTool(u, r) }(req)
			select {
			case res := <-done:
				if err := s.sendResponse(res); err != nil {
					return err
				}
			case err := <-errCh:
				// 连接已断：本条结果无处可送，直接放弃
				return err
			}
		case err := <-errCh:
			return err
		}
	}
}

func (s *session) readLoop(ctx context.Context, queue chan<- request, errCh chan<- error, u *ui) {
	deliver := func(err error) {
		select {
		case errCh <- err:
		default:
		}
	}
	for {
		// 每帧刷新读超时：对端静默（拔网线、合盖、进程被杀）时能及时判死并重连。
		// Linux 默认的 TCP keepalive 要十几分钟才判死，不能只靠它。
		if err := s.conn.SetReadDeadline(time.Now().Add(readIdleTimeout)); err != nil {
			deliver(err)
			return
		}
		payload, err := readFrame(s.conn)
		if err != nil {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				// 静默超时属断线（可重连），不是协议错误。
				deliver(fmt.Errorf("超过 %s 未收到任何可解密帧，判定连接已失效", readIdleTimeout))
				return
			}
			deliver(err)
			return
		}
		plaintext, err := open(s.key, payload)
		if err != nil {
			// 解密失败：断开，由上层打印原因并退出
			deliver(newProtocolError("解密失败：%v", err))
			return
		}
		var ctrl controlFrame
		if err := json.Unmarshal(plaintext, &ctrl); err != nil {
			deliver(newProtocolError("收到无法解析的报文：%v", err))
			return
		}
		var req request
		if err := json.Unmarshal(plaintext, &req); err != nil {
			deliver(newProtocolError("收到无法解析的报文：%v", err))
			return
		}
		// 记读到这一帧的时刻：run_batch 的预算从这里起算，排队等待前一个调用也要扣。
		req.receivedAt = time.Now()
		// 控制帧没有 id，绝不能当成工具回包处理。
		if req.ID == "" {
			switch ctrl.Kind {
			case "ping":
				if err := s.sendControl(`{"kind":"pong"}`); err != nil {
					deliver(err)
					return
				}
			case "pong", "ready":
				// 心跳回应 / 重复的就绪帧：忽略
			default:
				u.line("忽略未知控制帧（kind=%q）", ctrl.Kind)
			}
			continue
		}
		select {
		case queue <- req:
		case <-ctx.Done():
			return
		}
	}
}

func (s *session) sendResponse(res response) error {
	plaintext, err := json.Marshal(res)
	if err != nil {
		return fmt.Errorf("编码回包失败：%w", err)
	}
	return s.sendPlaintext(plaintext)
}

// sendControl 发送一条控制帧（pong）。
func (s *session) sendControl(plaintext string) error {
	return s.sendPlaintext([]byte(plaintext))
}

func (s *session) sendPlaintext(plaintext []byte) error {
	payload, err := seal(s.key, plaintext)
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := writeFrame(s.conn, payload); err != nil {
		return fmt.Errorf("发送回包失败：%w", err)
	}
	return nil
}
