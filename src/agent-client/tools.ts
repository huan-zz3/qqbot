/**
 * agent-client 暴露给 opencode 的两个 MCP 工具：schema 与结果格式化。
 *
 * 这里不碰 socket：真正的「发帧 → 等回包」由 server.ts 的 invoker 完成，
 * 本模块只负责拼请求、把客户端回包转成模型可读的 MCP content，并按服务端上限二次截断。
 * 二次截断的意义：客户端下发的 stdout 可能仍有几十 MB，不能让整段进 opencode 的上下文。
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** 工具名固定两个：越少越好，模型没有选择成本。 */
export type ToolName = "run_psh" | "read_file";

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
];

/** 严格判断工具名，挡掉模型拼错的名字而不是把它发给客户端。 */
export function isToolName(name: string): name is ToolName {
  return name === "run_psh" || name === "read_file";
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

/**
 * 执行一次工具调用：转发 → 等回包 → 格式化 → 二次截断。
 * 工具名非法或回包形状不对都转成 isError 文本，让模型看到原因而不是收到协议异常。
 */
export async function handleToolCall(
  name: string,
  rawArgs: unknown,
  invoke: ToolInvoker,
  maxOutputChars: number,
): Promise<ToolOutcome> {
  if (!isToolName(name)) {
    return { text: `未知工具：${name}`, isError: true };
  }
  let reply: ToolReply;
  try {
    reply = await invoke(name, asRecord(rawArgs));
  } catch (error) {
    // 转发层抛错（超时/连接断开）已经带原因，原样交给模型；不伪装成「没有输出」。
    return { text: `调用失败：${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
  const outcome = name === "run_psh" ? formatPsh(reply) : formatReadFile(reply);
  return { text: truncateText(outcome.text, maxOutputChars), isError: outcome.isError };
}
