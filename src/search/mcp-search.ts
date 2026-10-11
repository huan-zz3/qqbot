/**
 * mcp-search.ts —— 联网搜索客户端：连一个远程 MCP 服务器，把它 `tools/list` 返回的全部工具
 * 原样暴露给 DeepSeek。
 *
 * 用法：`index.ts` 在启动时 `connect()` 一次并缓存工具清单；`runtime.ts` 用 `usable()`
 * 决定是否挂载；`reply.ts` 用 `tools()` 生成给模型的工具，模型的调用经由 handler 转发到
 * MCP 的 `tools/call`。
 *
 * 约束：
 * - 每个 JSON-RPC 消息都是一次独立的 HTTP POST，靠 mcp-session-id 关联会话；那条 GET SSE
 *   （服务端→客户端推送）是可选的，断了不影响 POST 调用，故只在 onerror 记日志、不触发重连。
 * - 会永久失效的是：启动时连不上、运行中会话失效（服务器重启 / 会话过期导致 POST 抛错）。
 *   这两种情况都按指数退避自动重连（间隔封顶），重连期间 `usable()` 为 false、不挂载，
 *   成功后自动恢复；`dispose()` 后不再重连。
 * - 不针对具体工具名写分支：服务器返回什么就挂什么。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { Tool } from "../llm/deepseek.js";
import { logger } from "../logger.js";

/** 连接参数；由 config.search 提供。 */
export type McpSearchOptions = {
  /** MCP 服务器地址（streamable HTTP）。 */
  url: string;
  /** 连接与单次请求的超时（毫秒）。 */
  timeoutMs: number;
  /** 断连后首次重连的间隔（毫秒）。 */
  reconnectMinMs: number;
  /** 重连间隔的封顶（毫秒）。 */
  reconnectMaxMs: number;
};

/** 从 MCP 工具清单里用到的字段。 */
type McpTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

/**
 * 把 MCP `tools/call` 返回的 content 拼接成纯文本：只取 type 为 text 的块，
 * 其余（图片等）忽略；没有文本块时返回空串。
 */
export function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    const item = block as { type?: unknown; text?: unknown };
    if (item?.type === "text" && typeof item.text === "string") texts.push(item.text);
  }
  return texts.join("\n");
}

/**
 * 提取错误信息，并带上 undici `fetch failed` 藏在 cause 里的真实原因（code/message），
 * 否则日志里只剩笼统的 `fetch failed`，无法排查。
 */
function errorText(error: unknown): string {
  const cause = (error as { cause?: unknown } | undefined)?.cause as
    | { code?: string; message?: string }
    | undefined;
  const base = error instanceof Error ? error.message : String(error);
  if (!cause) return base;
  const detail = cause.code ? `${cause.code}: ${cause.message ?? ""}`.trim() : cause.message;
  return detail ? `${base}（${detail}）` : base;
}

/**
 * 联网搜索客户端：MCP 连接与工具清单的持有者，断连后按退避自动重连。
 */
export class McpSearch {
  private client: Client | undefined;
  private listing: McpTool[] = [];
  private ready = false;
  /** 进程退出标志：置位后不再排定任何重连。 */
  private stopped = false;
  /** 连续失败次数，用于算退避；连接成功后清零。 */
  private attempt = 0;
  /** 已排定的重连定时器；存在即表示不重复排定。 */
  private timer: NodeJS.Timeout | undefined;
  /** 进行中的连接尝试；用于并发去重，避免同时发起多次连接。 */
  private connecting: Promise<void> | undefined;
  /** 上一条传输错误文本，用于消除 SDK 同一次错误被上报两遍的重复日志。 */
  private lastTransportError = "";

  constructor(private readonly options: McpSearchOptions) {}

  /**
   * 建立连接并拉取工具清单。失败会抛出（供调用方记录启动告警），同时已在内部排定重连。
   * 订阅传输层的 error/close：断开即置为不可用并打日志，避免误以为还连着。
   */
  async connect(): Promise<void> {
    return this.ensureConnecting();
  }

  /** 当前是否可用（不额外发网络请求）。 */
  usable(): boolean {
    return this.ready;
  }

  /** 把缓存的 MCP 工具映射成 DeepSeek 工具；未连接时返回空数组。 */
  tools(): Tool[] {
    if (!this.ready) return [];
    return this.listing.map((tool) => ({
      definition: {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description ?? "",
          // MCP 的 inputSchema 本身就是 JSON Schema 对象，直接透传。
          parameters: tool.inputSchema,
        },
      },
      // 失败日志由 call() 统一记录（含 markDown 与重连），这里不再重复记。
      handler: (args) => this.call(tool.name, args),
    }));
  }

  /** 关闭连接，供进程退出时调用；此后不再重连。 */
  async dispose(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    this.ready = false;
    await this.client?.close().catch(() => undefined);
    this.connecting = undefined;
  }

  /** 去重地发起一次连接尝试：已有进行中的尝试则直接复用。 */
  private ensureConnecting(): Promise<void> {
    if (this.connecting) return this.connecting;
    const connecting = this.attemptConnect().finally(() => {
      // 仅当仍是当前尝试时才清空（dispose 可能已提前清空）。
      if (this.connecting === connecting) this.connecting = undefined;
    });
    this.connecting = connecting;
    return connecting;
  }

  /** 一次连接尝试：成功则置 ready 并清退避；失败则置 down、排定重连并抛出。 */
  private async attemptConnect(): Promise<void> {
    // 关闭上一个连接（best-effort）。此处 connecting 已置位，onclose 触发的重连排定为 no-op。
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    const transport = new StreamableHTTPClientTransport(new URL(this.options.url));
    // 仅在仍可用时记录：dispose() 会先置 ready=false 再关流，主动关闭引发的 abort 不报警告。
    transport.onerror = (error) => this.logTransportError(error);
    transport.onclose = () => this.markDown("连接已关闭");
    const client = new Client({ name: "qqbot", version: "0.1.0" });
    try {
      await client.connect(transport, { timeout: this.options.timeoutMs });
      // 先记下 client：即使 listTools 失败，dispose() 也能关掉连接，不泄漏。
      this.client = client;
      const { tools } = await client.listTools(undefined, { timeout: this.options.timeoutMs });
      this.listing = tools;
      this.ready = true;
      this.attempt = 0;
      this.lastTransportError = "";
      this.clearTimer();
      logger.info(`MCP 搜索已连接：${this.options.url}（${tools.length} 个工具：${tools.map((tool) => tool.name).join(", ")}）`);
    } catch (error) {
      await client.close().catch(() => undefined);
      this.markDown(`连接失败：${errorText(error)}`);
      this.attempt += 1;
      this.scheduleReconnect();
      throw error;
    }
  }

  /**
   * 按指数退避排定一次重连；已有排定、或已停止时不重复排定。
   * 注意：不检查 `connecting`——本方法会从一次连接尝试的失败路径里调用，那时 `connecting` 尚未清空。
   * 若恰有一次尝试在进行中，排定后的定时器触发时会复用/另起一次，成功连接会清掉该定时器，不会叠加。
   */
  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const delay = Math.min(
      this.options.reconnectMinMs * 2 ** Math.max(0, this.attempt - 1),
      this.options.reconnectMaxMs,
    );
    logger.warn(`MCP 搜索将在 ${delay}ms 后重连（已连续失败 ${this.attempt} 次）`);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // 失败时 attemptConnect 内部会再排定下一次；这里吞掉拒绝避免未处理的 Promise。
      void this.ensureConnecting().catch(() => undefined);
    }, delay);
  }

  /** 调用一个 MCP 工具并把结果拼成文本；isError 时记警告并原样返回文本。 */
  private async call(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("MCP 搜索未连接");
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await this.client.callTool({ name, arguments: args }, undefined, {
        timeout: this.options.timeoutMs,
      });
    } catch (error) {
      // 抛出（HTTP/网络/协议错）说明会话或传输不可用：置 down 并按退避重连；本轮把错误交给上层。
      this.markDown(`工具 ${name} 调用失败：${errorText(error)}`);
      this.attempt += 1;
      this.scheduleReconnect();
      throw error;
    }
    const text = contentToText(result.content);
    if (result.isError) {
      logger.warn(`MCP 工具 ${name} 返回错误：${text}`);
      return text || `${name} 执行失败`;
    }
    return text || `${name} 没有返回文本结果`;
  }

  /** 置为不可用并打一次日志（ready 已为 false 时不重复记）。 */
  private markDown(reason: string): void {
    if (this.ready) logger.warn(`MCP 搜索不可用：${reason}`);
    this.ready = false;
  }

  /**
   * 记录传输层错误：ready 已为 false 时忽略噪音；连续相同的消息只记一次——
   * SDK 在同一次失败里会先 `onerror` 再 throw，调用处又 `.catch(onerror)`，导致同一错误上报两遍。
   */
  private logTransportError(error: unknown): void {
    if (!this.ready) return;
    const message = errorText(error);
    if (message === this.lastTransportError) return;
    this.lastTransportError = message;
    logger.warn(`MCP 搜索传输错误：${message}`);
  }

  /** 清除待执行的重连定时器。 */
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
