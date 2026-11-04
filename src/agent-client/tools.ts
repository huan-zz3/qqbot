/**
 * agent-client 暴露给 opencode 的 MCP 工具：schema 与结果格式化。
 *
 * 这里不碰 socket：真正的「发帧 → 等回包」由 server.ts 的 invoker 完成，
 * 本模块只负责拼请求、把客户端回包转成模型可读的 MCP content，并按服务端上限二次截断。
 * 二次截断的意义：客户端下发的 stdout 可能仍有几十 MB，不能让整段进 opencode 的上下文。
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import {
  type BatchEntry,
  type BatchItem,
  type BatchLimits,
  MAX_BATCH_ITEMS,
  batchMaxTotalChars,
  formatBatch,
  planBatch,
} from "./batch.js";

/** 工具名：单条两个 + 批量一个，越少越好，模型没有选择成本。 */
export type ToolName = "run_psh" | "read_file" | "run_batch";

/** 客户端回包（与线协议 `{id, ok, result|error}` 对应；id 由 server 配对后剥离）。 */
export type ToolReply = { ok: true; result: unknown } | { ok: false; error: string };

/** server.ts 提供的转发函数：把一次工具调用送到某条已配对的 TCP 连接。 */
export type ToolInvoker = (tool: ToolName, args: Record<string, unknown>) => Promise<ToolReply>;

/** 一次工具调用的最终结果：text 给模型，isError 让 MCP 标记失败。 */
export type ToolOutcome = { text: string; isError: boolean };

/** MCP `tools/list` 的返回项形状；inputSchema 是纯 JSON Schema，不走 zod。 */
export type ToolDefinition = Pick<Tool, "name" | "description" | "inputSchema">;

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "run_psh",
    description:
      "在群友的 Windows 电脑上执行一条 PowerShell 命令，返回退出码、标准输出与标准错误。用于查看进程、服务、事件日志、系统信息等。命令是真实执行的，只读排查为主。",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的 PowerShell 命令（会以 powershell -NoProfile -NonInteractive -Command 执行）",
        },
        timeout_ms: {
          type: "number",
          description: "可选。客户端本地执行的超时毫秒数；不填则用客户端内置默认值",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description:
      "读取群友 Windows 电脑上的一个文件（文本）。日志文件优先用它，不要用 run_psh 拼路径去读。默认最多读 256 KiB。",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径，例如 C:\\Users\\me\\AppData\\Local\\app\\logs\\a.log",
        },
        max_bytes: {
          type: "number",
          description: "可选。最多读取的字节数，不填则用客户端内置默认值（256 KiB）",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "run_batch",
    description: `一次在群友的 Windows 电脑上执行多条 PowerShell 命令、读取多个文件；最多 ${MAX_BATCH_ITEMS} 条。需要多条时全部放进这一次调用，按数组顺序串行执行。`,
    // 用宽松对象而不是 oneOf：模型与客户端都不擅长 oneOf，逐项必填由服务端校验。
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: MAX_BATCH_ITEMS,
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["psh", "read"] },
              command: { type: "string" },
              timeout_ms: { type: "number" },
              path: { type: "string" },
              max_bytes: { type: "number" },
            },
            required: ["type"],
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
];

/** 严格判断工具名，挡掉模型拼错的名字而不是把它发给客户端。 */
export function isToolName(name: string): name is ToolName {
  return name === "run_psh" || name === "read_file" || name === "run_batch";
}

/**
 * 按 maxChars 截断文本，并在末尾注明原始长度。
 * 末尾说明本身可能让结果略超 maxChars，这是有意的：宁可多一行也不能悄悄丢掉被截断的信号。
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n（已截断，原始 ${text.length} 字符）`;
}

/** MCP 参数可能是任意 JSON；非对象一律当空对象处理，具体必填项由客户端校验。 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** run_psh 的结果排版：先给退出码/超时，再分段给 stdout/stderr，避免混在一起看不清。 */
function formatPsh(reply: ToolReply): ToolOutcome {
  // 失败原因由客户端/转发层给出（例如「客户端已断线、正在重连（剩余 N 秒）」），原样交给模型。
  if (!reply.ok) return { text: reply.error, isError: true };
  // 缺字段不能伪装成「命令没输出」：模型会据此误判命令成功。诚实报错。
  if (typeof reply.result !== "object" || reply.result === null) {
    return { text: "客户端回包缺少 result", isError: true };
  }
  const result = asRecord(reply.result);
  if (typeof result.exit !== "number") {
    return { text: "客户端回包缺少 exit", isError: true };
  }
  const exit = result.exit;
  const timedOut = result.timedOut === true;
  const parts = [`exit=${exit}${timedOut ? "（客户端已超时终止）" : ""}`];
  const stdout = textOf(result.stdout);
  const stderr = textOf(result.stderr);
  if (stdout) parts.push(`stdout:\n${stdout}`);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  if (!stdout && !stderr) parts.push("（无输出）");
  // 客户端已按 max_output_chars 截过一次；如实告诉模型，别把缺失当成命令没输出。
  if (result.truncated === true) parts.push("（客户端已按输出上限截断）");
  return { text: parts.join("\n"), isError: false };
}

/** read_file 的结果排版：正文原样返回；截断或非 UTF-8 时补一行说明，避免模型误读编码。 */
function formatReadFile(reply: ToolReply): ToolOutcome {
  // 同 run_psh：失败原因原样返回，不让模型把「断线」误读成「文件为空」。
  if (!reply.ok) return { text: reply.error, isError: true };
  if (typeof reply.result !== "object" || reply.result === null) {
    return { text: "客户端回包缺少 result", isError: true };
  }
  const result = asRecord(reply.result);
  // 真空文件是 text:"" + bytes:0，合法；完全没有 text 字段才是回包坏了。
  if (typeof result.text !== "string") {
    return { text: "客户端回包缺少 text", isError: true };
  }
  const body = result.text;
  const bytes = typeof result.bytes === "number" ? result.bytes : undefined;
  const encoding = textOf(result.encoding) || "unknown";
  const truncated = result.truncated === true;
  const notes: string[] = [];
  if (truncated) notes.push("客户端已按 max_bytes 截断");
  if (encoding !== "utf-8") notes.push(`编码 ${encoding}`);
  if (bytes !== undefined) notes.push(`共 ${bytes} 字节`);
  const text = body || "（文件为空）";
  return { text: notes.length > 0 ? `${text}\n（${notes.join("；")}）` : text, isError: false };
}

/** 批量项在聚合头部的工具名，与单条工具同名，模型才能对得上。 */
function batchToolName(item: BatchItem): string {
  return item.type === "psh" ? "run_psh" : "read_file";
}

function batchTarget(item: BatchItem): string {
  return item.type === "psh" ? item.command : item.path;
}

/** 结构非法的项：尽量从原始参数里还原出工具名与目标，还原不出就留空。 */
function failureHeader(raw: unknown): { tool: string; target: string } {
  const record = asRecord(raw);
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "psh") return { tool: "run_psh", target: textOf(record.command) };
  if (type === "read") return { tool: "read_file", target: textOf(record.path) };
  return { tool: "run_batch", target: type };
}

/** 客户端单项回包：与单条工具同形状，外层多包了一个 ok。 */
function batchReplyOf(value: unknown): ToolReply | undefined {
  const record = asRecord(value);
  if (record.ok === true) return { ok: true, result: record.result };
  if (record.ok === false) {
    return { ok: false, error: typeof record.error === "string" ? record.error : "客户端未给出原因" };
  }
  return undefined;
}

/** 单项正文复用单条排版并按单条上限截断；失败项加「失败：」前缀，免得和正常正文混在一起。 */
function batchBody(reply: ToolReply | undefined, item: BatchItem, maxOutputChars: number): string {
  if (!reply) return "失败：客户端回包缺少该项结果";
  const outcome = item.type === "psh" ? formatPsh(reply) : formatReadFile(reply);
  if (outcome.isError) return `失败：${outcome.text}`;
  return truncateText(outcome.text, maxOutputChars);
}

/**
 * 批量分支：先逐项校验（非法项就地失败、不下发），再一帧发出去，回包按原始索引合并。
 * isError 只表示「一条都没执行」；部分失败仍按正常结果交给模型。
 */
async function handleBatchCall(
  rawArgs: unknown,
  invoke: ToolInvoker,
  limits: BatchLimits,
): Promise<ToolOutcome> {
  const rawItems = asRecord(rawArgs).items;
  const plan = planBatch(rawItems, limits);
  const maxTotalChars = batchMaxTotalChars(limits.maxOutputChars);
  const entries: BatchEntry[] = [];

  if (!plan.ok) return { text: plan.error, isError: true };

  const rawList = Array.isArray(rawItems) ? rawItems : [];
  const plannedFailures = new Map(plan.failures.map((failure) => [failure.index, failure.error]));

  // 全部项都结构非法：没有任何一条可下发，isError 标真。
  if (plan.dispatch.length === 0) {
    for (const failure of plan.failures) {
      entries.push({
        ...failureHeader(rawList[failure.index]),
        body: `失败：${failure.error}`,
      });
    }
    return { text: formatBatch(entries, maxTotalChars), isError: true };
  }

  let reply: ToolReply;
  try {
    reply = await invoke("run_batch", { items: plan.dispatch.map((entry) => entry.item) });
  } catch (error) {
    // 转发层抛错（超时/连接断开）已经带原因，原样交给模型；不伪装成「没有输出」。
    return { text: `调用失败：${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
  // 整批超时/码不可兑付：客户端没有跑任何一条。
  if (!reply.ok) return { text: reply.error, isError: true };

  const resultItems = asRecord(reply.result).items;
  if (!Array.isArray(resultItems)) return { text: "客户端回包缺少 items", isError: true };

  let cursor = 0;
  for (let index = 0; index < plan.total; index++) {
    const failure = plannedFailures.get(index);
    if (failure !== undefined) {
      entries.push({ ...failureHeader(rawList[index]), body: `失败：${failure}` });
      continue;
    }
    const dispatched = plan.dispatch[cursor];
    if (!dispatched) continue;
    const itemReply = batchReplyOf(resultItems[cursor]);
    cursor++;
    entries.push({
      tool: batchToolName(dispatched.item),
      target: batchTarget(dispatched.item),
      body: batchBody(itemReply, dispatched.item, limits.maxOutputChars),
    });
  }

  return { text: formatBatch(entries, maxTotalChars), isError: false };
}

/**
 * 执行一次工具调用：转发 → 等回包 → 格式化 → 二次截断。
 * 工具名非法或回包形状不对都转成 isError 文本，让模型看到原因而不是收到协议异常。
 */
export async function handleToolCall(
  name: string,
  rawArgs: unknown,
  invoke: ToolInvoker,
  limits: BatchLimits,
): Promise<ToolOutcome> {
  if (!isToolName(name)) {
    return { text: `未知工具：${name}`, isError: true };
  }
  if (name === "run_batch") return handleBatchCall(rawArgs, invoke, limits);

  let reply: ToolReply;
  try {
    reply = await invoke(name, asRecord(rawArgs));
  } catch (error) {
    // 转发层抛错（超时/连接断开）已经带原因，原样交给模型；不伪装成「没有输出」。
    return { text: `调用失败：${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
  const outcome = name === "run_psh" ? formatPsh(reply) : formatReadFile(reply);
  return { text: truncateText(outcome.text, limits.maxOutputChars), isError: outcome.isError };
}
