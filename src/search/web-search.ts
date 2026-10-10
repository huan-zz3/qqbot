/**
 * web-search.ts —— Codex 联网搜索客户端（web_search 工具的后端实现）
 *
 * 用 Codex（ChatGPT 订阅）OAuth 的 access token 调用内部 alpha 搜索接口
 * `codex/alpha/search`，把搜索结果以纯文本返回。凭证由 `codex-auth.ts` 提供
 * （只读、过期重读、从不刷新）；模型、上下文大小、超时等参数来自 `config.search`。
 * 被 `chat/reply.ts` 的 web_search 工具使用；`chat/runtime.ts` 在挂工具前会先
 * 用 usable() 检查凭证是否可用。
 *
 * 约束：这是 Codex 源码里的内部接口，不是公开 API，协议随时可能变。
 */
import { randomUUID } from "node:crypto";

import { config } from "../config.js";
import type { CodexAuth } from "./codex-auth.js";

// Codex 源码里的内部 alpha 接口（codex-rs/codex-api/src/endpoint/search.rs）；
// pi-extensions/websearch 用的是同一套接法。
const SEARCH_ENDPOINT = "https://chatgpt.com/backend-api/codex/alpha/search";
// 失败重试上限：只对网络错误和 429/5xx 生效，退避间隔 1s、2s。
const MAX_RETRIES = 2;
// 返回文本的默认截断长度，避免把超长结果整段塞给模型。
const MAX_OUTPUT_CHARS = 8000;

/**
 * 一次搜索请求的参数。
 */
export type WebSearchRequest = {
  /** 搜索词。 */
  query: string;
  /** 只看最近多少天内的结果；缺省或非正数时不限制（下发时向下取整）。 */
  recencyDays?: number;
  // 这次搜索服务于哪句聊天提问；Codex 用它聚焦结果。
  question?: string;
};

/**
 * 清理 Codex 返回的搜索文本：Codex 会混入只为它自家 UI 服务的引用标记
 * （形如 "\ue200cite\ue202turn0search0\ue201"），这里统统去掉，另清掉残留的
 * 私有区控制字符（\ue200-\ue2ff）、压缩连续空行；超过 maxChars 就截断并加省略提示。
 * 导出是为了让测试能单独覆盖它。
 * @param output 接口返回的原始文本
 * @param maxChars 截断上限，默认 MAX_OUTPUT_CHARS
 * @returns 清理（必要时截断）后的文本
 */
export function cleanSearchOutput(output: string, maxChars = MAX_OUTPUT_CHARS): string {
  const cleaned = output
    .replace(/[\ue200-\ue2ff]?cite[\ue200-\ue2ff]?(?:turn\d+[a-z]+\d+[\ue200-\ue2ff]?)+/g, "")
    .replace(/[\ue200-\ue2ff]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}\n…(结果已截断)` : cleaned;
}

/**
 * Codex 联网搜索客户端：封装请求组装、重试与结果清理。
 */
export class CodexWebSearch {
  constructor(private readonly auth: CodexAuth) {}

  /** 磁盘上此刻是否存在已同步且未过期的 access token（runtime 据此决定是否给模型挂搜索工具）。 */
  usable(): Promise<boolean> {
    return this.auth.usable();
  }

  /**
   * 执行一次搜索。
   * @param request 搜索词、可选的时间范围与服务提问
   * @returns 清理并截断后的纯文本结果
   * @throws 凭证缺失/过期、网络错误重试耗尽、响应非 2xx 或无文本结果时抛错
   */
  async search(request: WebSearchRequest): Promise<string> {
    // 取凭证：临近过期或已过期时会重读磁盘（见 codex-auth.ts）。
    const credential = await this.auth.get();
    // 搜索条件按接口协议放进 commands.search_query。
    const query: Record<string, unknown> = { q: request.query };
    // recency 只在给了正数天数时下发；接口要整数天。
    if (request.recencyDays && request.recencyDays > 0) query.recency = Math.floor(request.recencyDays);

    // 请求体：模型与各项上限来自 config.search。
    const body: Record<string, unknown> = {
      id: randomUUID(),
      model: config.search.model,
      commands: { search_query: [query], response_length: "medium" },
      settings: {
        search_context_size: config.search.contextSize,
        allowed_callers: ["direct"],
        external_web_access: true,
      },
      max_output_tokens: config.search.maxOutputTokens,
    };
    // 带上聊天提问能让接口把结果聚焦到真正要回答的问题上。
    if (request.question) {
      body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: request.question }] }];
    }

    // 重试循环：仅网络错误与 429/5xx 重试（退避 1s、2s），其余情况直接失败。
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(SEARCH_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credential.access}`,
            "chatgpt-account-id": credential.accountId,
            "content-type": "application/json",
            originator: "qqbot",
            "user-agent": "qqbot/0.1",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.search.timeoutMs),
        });
      } catch (error) {
        // fetch 本身抛错（网络/超时）才走这里。
        if (attempt < MAX_RETRIES) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new Error(`Codex 搜索网络错误: ${(error as Error).message}`);
      }

      if (response.ok) {
        // 2xx 时接口约定 output 是文本；不是字符串说明响应形态变了。
        const payload = (await response.json()) as { output?: unknown };
        if (typeof payload.output !== "string") throw new Error("Codex 搜索没有返回文本结果");
        return cleanSearchOutput(payload.output);
      }
      // 限流与服务端故障值得重试；4xx 等其余状态立即失败。
      if (attempt < MAX_RETRIES && (response.status === 429 || response.status >= 500)) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      // 响应体可能回显 Authorization 头：把 token 打码、只留前 500 字符放进错误信息。
      const text = (await response.text().catch(() => "")).replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
      throw new Error(`Codex 搜索失败 (${response.status}): ${text.slice(0, 500)}`);
    }
  }
}

/** 等待 ms 毫秒，用于重试退避。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
