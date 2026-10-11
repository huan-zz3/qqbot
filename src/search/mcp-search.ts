/**
 * mcp-search.ts —— 联网搜索客户端：连一个远程 MCP 服务器，把它 `tools/list` 返回的全部工具
 * 原样暴露给 DeepSeek。
 *
 * 用法：`index.ts` 在启动时 `connect()` 一次并缓存工具清单；`runtime.ts` 用 `usable()`
 * 决定是否挂载；`reply.ts` 用 `tools()` 生成给模型的工具，模型的调用经由 handler 转发到
 * MCP 的 `tools/call`。
 *
 * 约束：
 * - 连接断了就置为不可用并打日志，不自动重连、不重试——搜索功能停用，重启即可恢复。
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
 * 联网搜索客户端：MCP 连接与工具清单的持有者。
 */
export class McpSearch {
  private client: Client | undefined;
  private listing: McpTool[] = [];
  private ready = false;

  constructor(private readonly options: McpSearchOptions) {}

  /**
   * 建立连接并拉取工具清单。失败抛出错误（由调用方决定只告警）。
   * 订阅传输层的 close/error：断开即置为不可用并打日志，避免误以为还连着。
   */
  async connect(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(this.options.url));
    // 仅在仍可用时记录：dispose() 会先置 ready=false 再关流，主动关闭引发的 abort 不报警告。
    transport.onerror = (error) => {
      if (this.ready) logger.warn(`MCP 搜索传输错误：${error.message}`);
    };
    transport.onclose = () => this.markDown("连接已关闭");
    const client = new Client({ name: "qqbot", version: "0.1.0" });
    await client.connect(transport, { timeout: this.options.timeoutMs });
    // 先记下 client：即使 listTools 失败，dispose() 也能关掉连接，不泄漏。
    this.client = client;
    const { tools } = await client.listTools(undefined, { timeout: this.options.timeoutMs });
    this.listing = tools;
    this.ready = true;
    logger.info(`MCP 搜索已连接：${this.options.url}（${tools.length} 个工具：${tools.map((tool) => tool.name).join(", ")}）`);
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
      handler: async (args) => {
        try {
          return await this.call(tool.name, args);
        } catch (error) {
          logger.warn(`MCP 工具 ${tool.name} 调用失败：${(error as Error).message}`);
          throw error;
        }
      },
    }));
  }

  /** 关闭连接，供进程退出时调用。 */
  async dispose(): Promise<void> {
    this.ready = false;
    await this.client?.close().catch(() => undefined);
  }

  /** 调用一个 MCP 工具并把结果拼成文本；isError 时记警告并原样返回文本。 */
  private async call(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("MCP 搜索未连接");
    const result = await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: this.options.timeoutMs,
    });
    const text = contentToText(result.content);
    if (result.isError) {
      logger.warn(`MCP 工具 ${name} 返回错误：${text}`);
      return text || `${name} 执行失败`;
    }
    return text || `${name} 没有返回文本结果`;
  }

  /** 置为不可用并打一次日志（重复断开只记一次）。 */
  private markDown(reason: string): void {
    if (this.ready) logger.warn(`MCP 搜索不可用：${reason}，重启前不再挂载`);
    this.ready = false;
  }
}
