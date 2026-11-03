/**
 * agent-client 服务端：TCP 入口（握手 + AES-GCM 帧）、配对码注册表、MCP Streamable HTTP 前端。
 *
 * 数据流：
 *   群友 Windows 客户端 --裸 TCP(PSK/AES-GCM)--> 本文件：连接/配对码
 *   opencode 子进程 --MCP over HTTP(127.0.0.1, X-Pair-Code)--> 本文件：tools/call
 *   tools/call --按 uuid 关联、按连接串行--> 对应 TCP 连接 --执行--> 回包
 *
 * 关键取舍：
 * - MCP 用 stateless（`sessionIdGenerator: undefined`）：每个 POST 只靠 `X-Pair-Code` 查连接，
 *   不维护「MCP 会话 ↔ TCP 连接」的对齐状态机。
 * - 同一连接上的调用串行：客户端本来就单线程执行，串行让「谁的输出」不会混在一起；
 *   不同连接之间互不影响（两个 opencode 子进程可以各跑各的）。
 * - 调用超时只向 MCP 回错误，不向客户端发取消帧：客户端那条命令会自己撞 psh 超时，
 *   少一条控制帧就少一类协议分支。
 */
import { randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { basename } from "node:path";

import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { errorText } from "../errors.js";
import { logger } from "../logger.js";
import {
  FrameDecoder,
  PROTOCOL_VERSION,
  deriveSessionKey,
  encodeFrame,
  open,
  randomNonce,
  seal,
} from "./crypto.js";
import { PairingRegistry, type PairingEntry } from "./registry.js";
import { TOOL_DEFINITIONS, handleToolCall, type ToolName, type ToolReply } from "./tools.js";
import type { AgentClient } from "./types.js";

/** MCP 只监听本机：外部连不上，配对码泄露也兑付不了。 */
const MCP_HOST = "127.0.0.1";

/**
 * 握手超时：TCP 入口经 frp 对公网开放，任何人都能建连接后什么都不发；
 * 没有这道闸，一条空 socket 会一直占着连接表，反复开就是零成本耗尽。
 * 客户端自身的握手超时也是 10 秒，取同值不会误杀慢客户端。
 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * 应用层心跳：半开连接（拔网线/合盖）不会触发 close，只能靠「多久没收到可解密帧」判定。
 * 20s 发一帧 ping，连续 45s 收不到任何可解密帧即断开并进入宽限期。
 */
const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

/** read_file 未指定 max_bytes 时的缺省值（256 KiB）。 */
const DEFAULT_MAX_BYTES = 262_144;

export type AgentClientServerOptions = {
  /** 客户端入口绑定地址（经 frp 暴露）。 */
  host: string;
  port: number;
  /** MCP 端口（固定绑 127.0.0.1）。 */
  mcpPort: number;
  /** 32 字节 PSK；日志里永不打印。 */
  psk: Buffer;
  graceMs: number;
  maxClients: number;
  callTimeoutMs: number;
  /** 客户端 psh 超时上限；模型传入的 timeout_ms 会被钳到这个值。 */
  pshTimeoutMs: number;
  maxOutputChars: number;
  /** 静态文件服务地址，只用于拼给 NapCat 的下载 URL。 */
  fileHost: string;
  filePort: number;
  file: string;
};

/** 一条未完成调用：回包或超时都会 resolve，只是内容不同。 */
type PendingCall = {
  resolve: (reply: ToolReply) => void;
  timer: NodeJS.Timeout;
};

/** 一条已接入的 TCP 连接；握手前没有 key/code。 */
type Connection = {
  id: string;
  socket: Socket;
  decoder: FrameDecoder;
  key?: Buffer;
  code?: string;
  /** 串行队列的尾部：保证同一连接上同一时刻只有一个调用在等回包。 */
  chain: Promise<void>;
  pending: Map<string, PendingCall>;
  /** 已关闭（不再接受新帧/新调用）；closeConnection 用它可以幂等。 */
  closed: boolean;
  /** 是否已完成配对（收到合法 open 并发出 paired）；心跳计时从这一刻起算。 */
  paired: boolean;
  /** 握手超时闸；配对完成或连接关闭时清掉。 */
  handshakeTimer?: NodeJS.Timeout;
  /** 最近一次收到可解密帧的时刻；心跳超时判定依据。 */
  lastRecvAt: number;
  /** 本条连接是否已用可解密帧证明过持有 PSK（与 registry 的 verified 对应）。 */
  verified: boolean;
  /** 每连接一个心跳定时器；closeConnection 清掉。 */
  heartbeatTimer?: NodeJS.Timeout;
};

/** 明文握手报文（hello）；字段全部按不可信处理。 */
type HelloMessage = {
  v?: unknown;
  kind?: unknown;
  nonce?: unknown;
};

/** 从握手报文取 base64 的 16 字节 nonce；长度不对直接判非法。 */
function decodeNonce(value: unknown): Buffer | undefined {
  if (typeof value !== "string") return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 16 ? decoded : undefined;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value?.trim() ?? "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function respondText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

export class AgentClientServer implements AgentClient {
  private readonly registry: PairingRegistry;
  private readonly connections = new Map<string, Connection>();
  private readonly clientFileName: string;
  private tcp: TcpServer | undefined;
  private http: HttpServer | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: AgentClientServerOptions) {
    this.registry = new PairingRegistry({ graceMs: options.graceMs, maxClients: options.maxClients });
    this.clientFileName = basename(options.file);
  }

  /** 启动 TCP 与 MCP；任一绑定失败都会抛出（已启动的另一半会先关掉）。 */
  async start(): Promise<void> {
    this.tcp = await this.listenTcp();
    try {
      this.http = await this.listenHttp();
    } catch (error) {
      await this.dispose();
      throw error;
    }
    // 宽限期的淘汰靠定时扫描：断线后没有任何请求进来时，码也要能按时注销。
    const interval = Math.max(1000, Math.min(this.options.graceMs, 30_000));
    this.sweepTimer = setInterval(() => {
      const removed = this.registry.sweep(Date.now());
      if (removed.length > 0) logger.info(`agent-client 配对码已过期：${removed.join(", ")}`);
    }, interval);
    // 不因为一个清理定时器拖住进程退出。
    this.sweepTimer.unref();
    logger.info(
      `agent-client 已启动：客户端入口 ${this.options.host}:${this.options.port}，MCP ${MCP_HOST}:${this.options.mcpPort}`,
    );
  }

  /** 关闭所有监听与连接；不新起任何重连。 */
  async dispose(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;

    for (const conn of [...this.connections.values()]) this.closeConnection(conn, "服务关闭");

    const http = this.http;
    this.http = undefined;
    if (http) {
      // close() 会等在途请求（最长 callTimeoutMs）；systemd TimeoutStopSec=90 会把后续 flush 截断。
      // 先强杀所有 HTTP 连接，再关监听。
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }

    const tcp = this.tcp;
    this.tcp = undefined;
    if (tcp) await new Promise<void>((resolve) => tcp.close(() => resolve()));
  }

  /** 码存在、在线、已证明持有 PSK 且连接仍在，才允许带这个码 spawn opencode。 */
  resolveForOpencode(code: string): { ok: true } | { ok: false; message: string } {
    const located = this.locate(code);
    if (!located.ok) return { ok: false, message: located.message };
    return { ok: true };
  }

  /** NapCat 从容器里下载客户端压缩包用的 URL。 */
  fileUrl(): string {
    return `http://${this.options.fileHost}:${this.options.filePort}/${encodeURIComponent(this.clientFileName)}`;
  }

  fileName(): string {
    return this.clientFileName;
  }

  private async listenTcp(): Promise<TcpServer> {
    const server = createTcpServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(new Error(`绑定 ${this.options.host}:${this.options.port} 失败：${errorText(error)}`));
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.port, this.options.host);
    });
    server.on("error", (error) => logger.error(`agent-client TCP 服务错误：${errorText(error)}`));
    return server;
  }

  private async listenHttp(): Promise<HttpServer> {
    const server = createHttpServer((req, res) => {
      // handleHttp 自身不会抛；仍兜一层，避免未处理的 Promise 让进程退出。
      this.handleHttp(req, res).catch((error: unknown) => {
        logger.error(`agent-client MCP 请求处理异常：${errorText(error)}`);
        if (!res.headersSent) respondText(res, 500, "MCP 请求处理失败");
        else res.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(new Error(`绑定 ${MCP_HOST}:${this.options.mcpPort} 失败：${errorText(error)}`));
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.mcpPort, MCP_HOST);
    });
    server.on("error", (error) => logger.error(`agent-client MCP 服务错误：${errorText(error)}`));
    return server;
  }

  private onConnection(socket: Socket): void {
    const conn: Connection = {
      id: randomUUID(),
      socket,
      decoder: new FrameDecoder(),
      chain: Promise.resolve(),
      pending: new Map(),
      closed: false,
      paired: false,
      lastRecvAt: Date.now(),
      verified: false,
    };
    this.connections.set(conn.id, conn);
    // 工具调用是「一问一答」的小包，关掉 Nagle 能让握手与回包少等几十毫秒。
    socket.setNoDelay(true);
    // TCP keepalive 只是补充：它能发现对端主机不在，但默认探测间隔太久，不能替代应用层心跳。
    socket.setKeepAlive(true, 15_000);

    // 公共入口的兜底：到点仍未配对就断开，不给空连接长期占位。
    // 故意不 unref：连接存活期间它必须生效；由配对完成/closeConnection 及时清理，不会泄漏。
    conn.handshakeTimer = setTimeout(() => {
      if (!conn.code) {
        logger.warn(`agent-client 握手超时（连接 ${conn.id}，${HANDSHAKE_TIMEOUT_MS}ms 内未完成）`);
        this.closeConnection(conn, "握手超时");
      }
    }, HANDSHAKE_TIMEOUT_MS);

    // 一条连接一个心跳定时器（setTimeout 链）：半开连接收不到 close，只能靠静默时长判定。
    // 下一次触发取 min(20s, 距超时还剩多久)，所以静默满 45s 就会断开，而不是等整 20s 节拍。
    this.armHeartbeat(conn);

    socket.on("data", (chunk: Buffer) => {
      let frames: Buffer[];
      try {
        frames = conn.decoder.push(chunk);
      } catch (error) {
        logger.warn(`agent-client 帧解析失败（连接 ${conn.id}）：${errorText(error)}`);
        this.closeConnection(conn, "帧解析失败");
        return;
      }
      for (const frame of frames) {
        if (conn.closed) return;
        // 握手前的第一帧是明文；拿到 key 之后一律按密文解。
        if (!conn.key) this.handshake(conn, frame);
        else this.onEncrypted(conn, frame);
      }
    });
    socket.on("error", (error) => logger.warn(`agent-client TCP 连接错误（连接 ${conn.id}）：${errorText(error)}`));
    socket.on("close", () => this.closeConnection(conn, "连接关闭"));
  }

  /**
   * 处理明文 hello：只校验版本/kind/nonce，回明文 hello-ack 并派生会话密钥，
   * 紧接着发密文 ready（既是 PSK 证明，也宣告「明文段结束」）。
   * 此阶段**不注册码**：码只在收到合法密文 open 之后才产生。
   */
  private handshake(conn: Connection, frame: Buffer): void {
    let hello: HelloMessage;
    try {
      hello = JSON.parse(frame.toString("utf8")) as HelloMessage;
    } catch {
      this.failHandshake(conn, "握手报文不是合法 JSON");
      return;
    }
    // 不做兼容分支：版本不等就要求重新获取客户端，避免两端字段含义悄悄错位。
    if (hello.v !== PROTOCOL_VERSION) {
      this.failHandshake(
        conn,
        `协议版本不匹配（服务端 v=${PROTOCOL_VERSION}，客户端 v=${String(hello.v)}），请重新获取客户端`,
      );
      return;
    }
    if (hello.kind !== "hello") {
      this.failHandshake(conn, "握手 kind 必须是 hello");
      return;
    }
    const clientNonce = decodeNonce(hello.nonce);
    if (!clientNonce) {
      this.failHandshake(conn, "握手 nonce 必须是 base64 的 16 字节");
      return;
    }

    const serverNonce = randomNonce();
    const ack = JSON.stringify({
      v: PROTOCOL_VERSION,
      kind: "hello-ack",
      nonce: serverNonce.toString("base64"),
    });
    try {
      conn.socket.write(encodeFrame(Buffer.from(ack, "utf8")));
    } catch (error) {
      logger.warn(`agent-client 发送 hello-ack 失败（连接 ${conn.id}）：${errorText(error)}`);
      this.closeConnection(conn, "发送 hello-ack 失败");
      return;
    }

    conn.key = deriveSessionKey(this.options.psk, clientNonce, serverNonce);
    try {
      // 密文 ready：客户端解不开即说明两边 PSK 不一致，应直接退出而不是反复重连。
      conn.socket.write(
        encodeFrame(seal(conn.key, Buffer.from(JSON.stringify({ kind: "ready" }), "utf8"))),
      );
    } catch (error) {
      logger.warn(`agent-client 发送就绪帧失败（连接 ${conn.id}）：${errorText(error)}`);
      this.closeConnection(conn, "发送就绪帧失败");
    }
    // 之后等密文 open：握手超时闸仍然生效，直到 paired 发出。
  }

  /**
   * 回明文 error 帧后优雅关闭（end 先冲刷写缓冲，避免客户端只看到断线看不到原因）。
   * `retry` 告诉客户端这是暂时性（名额满/服务刚重启）还是永久性（版本/token/码失效）失败。
   */
  private failHandshake(conn: Connection, message: string, retry = false): void {
    logger.warn(`agent-client 握手失败（连接 ${conn.id}）：${message}`);
    if (!conn.socket.destroyed) {
      try {
        conn.socket.write(
          encodeFrame(
            Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, kind: "error", message, retry }), "utf8"),
          ),
        );
      } catch (error) {
        logger.warn(`agent-client 发送握手错误帧失败（连接 ${conn.id}）：${errorText(error)}`);
      }
    }
    this.closeConnection(conn, "握手失败", true);
  }

  /**
   * 回**密文** error 帧后优雅关闭；此时连接已证明持有 PSK，明文 error 会破坏「此后没有明文」的约定。
   * `retry`：true = 暂时性（名额满），客户端退避重试；false = 永久性（token 失效/码已注销）。
   */
  private failOpen(conn: Connection, message: string, retry: boolean): void {
    logger.warn(`agent-client 配对失败（连接 ${conn.id}）：${message}`);
    const key = conn.key;
    if (key && !conn.socket.destroyed) {
      try {
        conn.socket.write(
          encodeFrame(seal(key, Buffer.from(JSON.stringify({ kind: "error", message, retry }), "utf8"))),
        );
      } catch (error) {
        logger.warn(`agent-client 发送配对错误帧失败（连接 ${conn.id}）：${errorText(error)}`);
      }
    }
    this.closeConnection(conn, "配对失败", true);
  }

  /**
   * 处理密文 open：首次连接登记新码，带 resume 的重连认领旧码。
   * 能解出这一帧本身就证明客户端持有 PSK，所以成功时置 verified 并回密文 paired。
   */
  private handleOpen(conn: Connection, fields: Record<string, unknown>): void {
    if (conn.code) {
      // 协议里 open 只发一次；重复到达不改变状态，也不断开（免得误伤正在进行的调用）。
      logger.debug(`agent-client 收到重复的 open 帧（连接 ${conn.id}）`);
      return;
    }
    const now = Date.now();
    const resumeRaw = fields.resume;
    let entry: PairingEntry | undefined;
    const isResume = resumeRaw !== undefined;
    if (isResume) {
      const resume = asRecord(resumeRaw);
      const code = typeof resume.code === "string" ? resume.code : "";
      const token = typeof resume.token === "string" ? resume.token : "";
      // resume 会就地改写同一个 entry 的 connectionId，旧值必须在调用前取出。
      const previousId = this.registry.lookup(code, now)?.entry.connectionId;
      entry = this.registry.resume(code, token, now, conn.id);
      if (!entry) {
        // 不自动发新码：客户端必须显式重连一次才能拿新码，避免两端对「当前码」理解不一致。
        this.failOpen(conn, "配对码已失效或 token 不正确，请重新打开客户端获取新码", false);
        return;
      }
      if (previousId && previousId !== conn.id) {
        // 旧 socket 可能还活着（TCP 半开、客户端没来得及关）：两条连接同属一个码会让帧去向不确定，
        // 这里主动收掉旧的，保证一个码只有一个在用的连接。closeConnection 幂等，已关则不动。
        const previous = this.connections.get(previousId);
        if (previous) {
          logger.info(`agent-client 连接被接管：码 ${entry.code}，旧连接 ${previousId} → 新连接 ${conn.id}`);
          this.closeConnection(previous, "被新连接接管");
        }
      }
    } else {
      try {
        entry = this.registry.register(now, conn.id);
      } catch (error) {
        // 当前唯一失败原因是名额已满，属暂时性：客户端退避后重试，别退出。
        this.failOpen(conn, errorText(error), true);
        return;
      }
    }

    const key = conn.key;
    if (!key) {
      // 走到这里说明状态机被破坏了（open 只在派生密钥之后才可能解开）。
      this.closeConnection(conn, "配对状态异常");
      return;
    }
    conn.code = entry.code;
    // 收到合法 open 就是持有 PSK 的证明：从这一刻起这条码可兑付。
    this.registry.markVerified(entry.code);
    conn.verified = true;

    const paired = JSON.stringify({ kind: "paired", code: entry.code, token: entry.token });
    try {
      conn.socket.write(encodeFrame(seal(key, Buffer.from(paired, "utf8"))));
    } catch (error) {
      logger.warn(`agent-client 发送 paired 帧失败（连接 ${conn.id}）：${errorText(error)}`);
      this.closeConnection(conn, "发送 paired 帧失败");
      return;
    }

    conn.paired = true;
    // 握手已完成：撤掉超时闸，否则连接会在 10 秒后被无谓断开。
    if (conn.handshakeTimer) {
      clearTimeout(conn.handshakeTimer);
      conn.handshakeTimer = undefined;
    }
    // 心跳从回完 paired 才开始计：握手本身花掉的时间不该算进没有可解密帧的时长。
    conn.lastRecvAt = Date.now();
    if (conn.heartbeatTimer) {
      clearTimeout(conn.heartbeatTimer);
      conn.heartbeatTimer = undefined;
    }
    this.armHeartbeat(conn);
    // 配对码可以打日志（本来就是给人看的）；PSK/token 绝不出现在日志里。
    logger.info(`agent-client 已配对：码 ${entry.code}（${isResume ? "重连" : "新连接"}，连接 ${conn.id}）`);
  }

  /** 解密一帧并按 id 配对回包；解密失败即断开（可能是 PSK 不匹配或链路被篡改）。 */
  private onEncrypted(conn: Connection, frame: Buffer): void {
    const key = conn.key;
    if (!key) return;
    let plaintext: Buffer;
    try {
      plaintext = open(key, frame);
    } catch (error) {
      logger.warn(
        `agent-client 解密失败（连接 ${conn.id}，可能是 PSK 不匹配或链路被篡改）：${errorText(error)}`,
      );
      this.closeConnection(conn, "解密失败");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(plaintext.toString("utf8"));
    } catch {
      logger.warn(`agent-client 收到非 JSON 的加密帧（连接 ${conn.id}）`);
      this.closeConnection(conn, "报文非法");
      return;
    }
    // 能解开就证明对端持有 PSK：刷新心跳静默计时。
    conn.lastRecvAt = Date.now();
    const fields = asRecord(message);
    const kind = typeof fields.kind === "string" ? fields.kind : "";
    if (kind === "open") {
      this.handleOpen(conn, fields);
      return;
    }
    if (kind === "pong") {
      // 心跳回应：lastRecvAt 已刷新，无需其它处理。
      return;
    }
    if (kind === "ping") {
      try {
        conn.socket.write(encodeFrame(seal(key, Buffer.from(JSON.stringify({ kind: "pong" }), "utf8"))));
      } catch (error) {
        logger.warn(`agent-client 回复 pong 失败（连接 ${conn.id}）：${errorText(error)}`);
        this.closeConnection(conn, "发送心跳回应失败");
      }
      return;
    }
    const id = typeof fields.id === "string" ? fields.id : "";
    const pending = conn.pending.get(id);
    if (!pending) {
      // 超时后到达的迟到回包会走到这里：不是错误，只是没人等它了。
      logger.debug(`agent-client 收到无人等待的回包（连接 ${conn.id}）：${id || "（空 id）"}`);
      return;
    }
    conn.pending.delete(id);
    clearTimeout(pending.timer);
    if (fields.ok === true) {
      pending.resolve({ ok: true, result: fields.result });
    } else {
      const reason = typeof fields.error === "string" && fields.error ? fields.error : "客户端未给出原因";
      pending.resolve({ ok: false, error: reason });
    }
  }

  /** 安排下一次心跳：到点先判静默超时，再发 ping 并续期；配对完成前不发 ping、也不计静默。 */
  private armHeartbeat(conn: Connection): void {
    if (conn.closed) return;
    if (!conn.paired) {
      // 握手阶段由握手超时闸负责；这里只维持节拍，绝不在配对前发 ping（客户端此时还没进心跳循环）。
      conn.heartbeatTimer = setTimeout(() => {
        conn.heartbeatTimer = undefined;
        this.armHeartbeat(conn);
      }, HEARTBEAT_INTERVAL_MS);
      conn.heartbeatTimer.unref();
      return;
    }
    const elapsed = Date.now() - conn.lastRecvAt;
    const remaining = HEARTBEAT_TIMEOUT_MS - elapsed;
    if (remaining <= 0) {
      logger.warn(`agent-client 心跳超时（连接 ${conn.id}，${HEARTBEAT_TIMEOUT_MS}ms 内无可解密帧）`);
      this.closeConnection(conn, "心跳超时");
      return;
    }
    const delay = Math.min(HEARTBEAT_INTERVAL_MS, remaining);
    conn.heartbeatTimer = setTimeout(() => {
      conn.heartbeatTimer = undefined;
      if (conn.closed) return;
      if (Date.now() - conn.lastRecvAt >= HEARTBEAT_TIMEOUT_MS) {
        logger.warn(`agent-client 心跳超时（连接 ${conn.id}，${HEARTBEAT_TIMEOUT_MS}ms 内无可解密帧）`);
        this.closeConnection(conn, "心跳超时");
        return;
      }
      try {
        const ping = seal(conn.key!, Buffer.from(JSON.stringify({ kind: "ping" }), "utf8"));
        conn.socket.write(encodeFrame(ping));
      } catch (error) {
        logger.warn(`agent-client 发送心跳失败（连接 ${conn.id}）：${errorText(error)}`);
        this.closeConnection(conn, "发送心跳失败");
        return;
      }
      this.armHeartbeat(conn);
    }, delay);
    // 心跳定时器不该阻止进程退出。
    conn.heartbeatTimer.unref();
  }

  /** 关闭一条连接：幂等；标记离线（仅当这条连接仍是该码的当前连接）、让在等的调用立即失败。 */
  private closeConnection(conn: Connection, reason: string, graceful = false): void {
    if (conn.closed) return;
    conn.closed = true;
    this.connections.delete(conn.id);

    if (conn.handshakeTimer) {
      clearTimeout(conn.handshakeTimer);
      conn.handshakeTimer = undefined;
    }
    if (conn.heartbeatTimer) {
      clearTimeout(conn.heartbeatTimer);
      conn.heartbeatTimer = undefined;
    }

    for (const pending of conn.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: `客户端连接已断开（${reason}）` });
    }
    conn.pending.clear();

    if (conn.code) {
      const found = this.registry.lookup(conn.code, Date.now());
      // 重连会把 connectionId 换成新连接；旧 socket 晚到的 close 不能把新连接标成离线。
      if (found && found.entry.connectionId === conn.id) {
        this.registry.markOffline(conn.code, Date.now());
        const seconds = Math.round(this.options.graceMs / 1000);
        logger.warn(`agent-client 连接断开：码 ${conn.code}，进入 ${seconds}s 宽限期（${reason}）`);
      }
    }

    if (!conn.socket.destroyed) {
      if (graceful) conn.socket.end();
      else conn.socket.destroy();
    }
  }

  /**
   * 码 → 可兑付连接。resolveForOpencode 与 forward 共用同一套判定，
   * 避免「码在线但连接已不在」时白 spawn 一个 opencode 子进程。
   */
  private locate(code: string): { ok: true; conn: Connection } | { ok: false; message: string } {
    const found = this.registry.lookup(code, Date.now());
    if (!found) {
      return {
        ok: false,
        message: "配对码不存在或已过期，请让群友重新打开客户端，把窗口里显示的新码发过来。",
      };
    }
    if (!found.entry.online) {
      const seconds = Math.ceil(found.remainingMs / 1000);
      return { ok: false, message: `客户端已断线、正在重连（剩余 ${seconds} 秒）。` };
    }
    // 光发过 hello 不算配对成功：没有合法 open 帧就证明不了对端持有 PSK，不能兑付。
    if (!found.entry.verified) {
      return { ok: false, message: "客户端仍在握手，请让群友稍等几秒。" };
    }
    const connectionId = found.entry.connectionId ?? "";
    const conn = this.connections.get(connectionId);
    if (!conn || conn.closed || !conn.key) {
      return { ok: false, message: "客户端连接已断开，正在重连。" };
    }
    return { ok: true, conn };
  }

  /**
   * 模型给的数字不可信：不打穿超时预算（pshTimeoutMs），也不让 read_file 一次读走上 GB。
   * 非法类型（字符串等）按缺省值处理，绝不原样透传给客户端。
   */
  private clampArgs(tool: ToolName, args: Record<string, unknown>): Record<string, unknown> {
    const clamped: Record<string, unknown> = { ...args };
    if (tool === "run_psh") {
      const raw = args.timeout_ms;
      const requested = typeof raw === "number" && Number.isFinite(raw) ? raw : this.options.pshTimeoutMs;
      const max = Math.max(this.options.pshTimeoutMs, 1000);
      clamped.timeout_ms = Math.min(Math.max(Math.trunc(requested), 1000), max);
      // 协议要求服务端下发这个字段，客户端用它截断输出。
      clamped.max_output_chars = this.options.maxOutputChars;
    } else {
      const raw = args.max_bytes;
      const requested = typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_MAX_BYTES;
      const max = Math.max(4 * this.options.maxOutputChars, 65_536);
      clamped.max_bytes = Math.min(Math.max(Math.trunc(requested), 1024), max);
    }
    return clamped;
  }

  /** 查码 → 找连接 → 钳位参数 → 串行转发；离线/过期都在这里转成可读错误，绝不排队等重连。 */
  private async forward(code: string, tool: ToolName, args: Record<string, unknown>): Promise<ToolReply> {
    const located = this.locate(code);
    if (!located.ok) return { ok: false, error: located.message };
    return this.enqueueCall(located.conn, tool, this.clampArgs(tool, args));
  }

  /** 同一连接串行：前一个调用（含超时等待）结束后才发下一个。 */
  private enqueueCall(conn: Connection, tool: ToolName, args: Record<string, unknown>): Promise<ToolReply> {
    const run = conn.chain.then(
      () => this.sendCall(conn, tool, args),
      () => this.sendCall(conn, tool, args),
    );
    // 队列尾部只关心「上一件已完成」，所以把结果吞掉；错误已经交给各自的 run。
    conn.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private sendCall(conn: Connection, tool: ToolName, args: Record<string, unknown>): Promise<ToolReply> {
    const key = conn.key;
    if (conn.closed || !key) {
      return Promise.resolve({ ok: false, error: "客户端连接已断开，正在重连" });
    }
    const id = randomUUID();
    return new Promise<ToolReply>((resolve) => {
      const timer = setTimeout(() => {
        // 只向 MCP 报错，不发取消帧：客户端那条命令会自己撞 psh 超时。
        conn.pending.delete(id);
        logger.warn(
          `agent-client 工具调用超时（连接 ${conn.id}，${tool}，${this.options.callTimeoutMs}ms）`,
        );
        resolve({
          ok: false,
          error: `调用超时：客户端在 ${Math.round(this.options.callTimeoutMs / 1000)} 秒内没有返回结果`,
        });
      }, this.options.callTimeoutMs);
      conn.pending.set(id, { resolve, timer });

      try {
        const payload = Buffer.from(JSON.stringify({ id, tool, args }), "utf8");
        conn.socket.write(encodeFrame(seal(key, payload)));
      } catch (error) {
        conn.pending.delete(id);
        clearTimeout(timer);
        logger.warn(`agent-client 发送工具调用失败（连接 ${conn.id}）：${errorText(error)}`);
        resolve({ ok: false, error: `发送到客户端失败：${errorText(error)}` });
      }
    });
  }

  /**
   * 一个 MCP HTTP 请求：只认 POST /mcp，码从 `X-Pair-Code` 取。
   * stateless 模式下每个请求新建一对 Server/Transport，请求结束即关，避免跨请求状态泄漏。
   */
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path !== "/mcp") {
      respondText(res, 404, "未找到：MCP 端点是 /mcp");
      return;
    }
    if (req.method !== "POST") {
      // stateless 不开 GET SSE，DELETE 也没有会话可删。
      res.writeHead(405, { allow: "POST", "content-type": "text/plain; charset=utf-8" });
      res.end("只支持 POST");
      return;
    }
    const code = headerValue(req.headers["x-pair-code"]);
    if (!code) {
      logger.warn("agent-client MCP 请求缺少 X-Pair-Code 头");
      respondText(res, 401, "缺少 X-Pair-Code 头");
      return;
    }
    // 码的存在性/verified/offline 全部留给 forward 转成 tools/call 的可读 isError；
    // 在 HTTP 层回 401 只会让 opencode 看到 MCP 传输错误，模型读不到原因。

    const server = new McpServer({ name: "agent", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOL_DEFINITIONS }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const outcome = await handleToolCall(
        request.params.name,
        request.params.arguments,
        (tool, args) => this.forward(code, tool, args),
        this.options.maxOutputChars,
      );
      return {
        content: [{ type: "text" as const, text: outcome.text }],
        isError: outcome.isError,
      };
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      // 关闭失败不影响响应本身，只记录。
      void transport.close().catch((error: unknown) => logger.debug(`agent-client 关闭 MCP transport 失败：${errorText(error)}`));
      void server.close().catch((error: unknown) => logger.debug(`agent-client 关闭 MCP server 失败：${errorText(error)}`));
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.warn(`agent-client MCP 请求处理失败：${errorText(error)}`);
      if (!res.headersSent) respondText(res, 500, "MCP 请求处理失败");
      else res.destroy();
    }
  }
}
