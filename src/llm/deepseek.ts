/**
 * deepseek.ts —— deepseek-flash 的底层调用封装：聊天补全（含工具循环）、JSON 输出、识图。
 *
 * 关键概念：
 * - 全项目只使用 deepseek-flash 一个模型（DEEPSEEK_MODEL 硬编码），不做模型切换或降级；
 * - 工具循环 chatWithTools：模型可多轮调用工具，直到给出纯文本为止；工具最多提供
 *   DEEPSEEK_MAX_TOOL_ROUNDS 轮，之后不再挂工具，迫使模型收尾作答；
 * - DeepSeek 的坑：挂了工具时，前序 assistant 回合的 reasoning_content 必须原样回传，
 *   否则接口会以 400 拒绝请求（见 chatWithTools 中 assistant 消息的构造）；
 * - JSON 模式 completeJson：提示词本身必须提到 JSON；模型偶尔输出畸形 JSON，失败重试一次；
 * - 识图 describeImage：deepseek-flash 只接受 user 消息中的图片（ContentPart）。
 *
 * 依赖 config.deepseek（apiKey、baseUrl、超时、thinking、maxTokens、temperature）。
 */
import { config } from "../config.js";
import { logger } from "../logger.js";

/** 硬编码的模型名：全项目唯一使用的模型，不提供其它模型或降级路径。 */
export const DEEPSEEK_MODEL = "deepseek-flash";

/** 模型请求调用工具的动作（OpenAI 兼容格式）；arguments 是 JSON 字符串，需先解析。 */
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/** 多模态消息的内容块：文本，或图片 URL（此项目里是 data URL）。 */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/**
 * 发给 /chat/completions 的消息联合类型（OpenAI 兼容）。
 * - tool 消息通过 tool_call_id 与对应 assistant 消息的 tool_calls 一一对应；
 * - assistant 的 reasoning_content 在挂了工具时必须原样回传（见 chatWithTools）。
 */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; reasoning_content?: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** 工具定义：函数名、给模型看的描述、参数的 JSON Schema。 */
export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/**
 * 工具执行函数：接收已解析的参数对象，返回给模型的字符串结果。
 * 约定：实现方（runTool）保证它不抛出——异常会被转成字符串交给模型自行纠错。
 */
export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

/** 工具 = 给模型的定义 + 本地执行函数。 */
export type Tool = { definition: ToolDefinition; handler: ToolHandler };

/** /chat/completions 原始响应中本模块用到的字段，其余忽略。 */
type CompletionResponse = {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string; tool_calls?: ToolCall[] };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
};

/** complete() 的可选参数：输出上限、是否 JSON 模式、采样温度。 */
type CompleteOptions = { maxTokens?: number; json?: boolean; temperature?: number };

/**
 * 发起一次非流式的 /chat/completions 请求并返回原始响应。
 * 只负责拼装请求与基础错误处理（非 2xx 抛错并带上截断的响应体），不解析业务语义、不重试。
 *
 * @param messages 完整对话上下文
 * @param tools 本轮提供给模型的工具定义；空数组表示不挂工具
 * @param options maxTokens 默认取 config.deepseek.maxTokens；未传 temperature 时不提交该字段
 * @returns 原始响应（由调用方读取 choices / usage）
 */
async function complete(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  { maxTokens = config.deepseek.maxTokens, json = false, temperature }: CompleteOptions = {},
): Promise<CompletionResponse> {
  // thinking 由 DEEPSEEK_THINKING 控制；开启时模型会产生 reasoning_content。
  const body: Record<string, unknown> = {
    model: DEEPSEEK_MODEL,
    messages,
    max_tokens: maxTokens,
    thinking: { type: config.deepseek.thinking ? "enabled" : "disabled" },
    stream: false,
  };
  // 可选字段按需提交，避免给服务端发送无意义的默认值。
  if (tools.length > 0) body.tools = tools;
  if (json) body.response_format = { type: "json_object" };
  if (temperature !== undefined) body.temperature = temperature;

  // 去掉 baseUrl 末尾斜杠，避免拼出双斜杠路径。
  const response = await fetch(`${config.deepseek.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.deepseek.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    // 请求级超时：超时中止请求并抛错。
    signal: AbortSignal.timeout(config.deepseek.timeoutMs),
  });
  if (!response.ok) {
    // 响应体截断到 500 字符，便于在错误信息里定位服务端问题。
    const text = await response.text().catch(() => "");
    throw new Error(`DeepSeek 请求失败 (${response.status}): ${text.slice(0, 500)}`);
  }
  return (await response.json()) as CompletionResponse;
}

/**
 * 运行工具循环，直到模型给出文本回复。
 * 每轮携带可用工具调用模型；模型返回 tool_calls 时并行执行、把结果按原顺序作为 tool 消息回填，
 * 再进入下一轮；模型不再调用工具（或达到 maxToolRounds 后不再提供工具）时，返回其回复文本。
 *
 * 注意：挂了工具时，DeepSeek 要求每个前序 assistant 回合的 reasoning_content 原样回传，
 * 否则会 400，因此 assistant 消息会保留该字段。
 *
 * @param initial 初始对话消息
 * @param tools 本次可用的工具（定义 + 处理器）
 * @returns 模型最终的文本回复（trim 后，可能为空串）
 */
export async function chatWithTools(initial: ChatMessage[], tools: Tool[]): Promise<string> {
  // 复制一份，避免在循环中改动调用方传入的数组。
  const messages = [...initial];
  // 按函数名索引工具，供 runTool 派发。
  const byName = new Map(tools.map((tool) => [tool.definition.function.name, tool]));

  for (let round = 0; ; round++) {
    // 超过 maxToolRounds 后不再提供工具，迫使模型收尾给出文本。
    const offerTools = round < config.deepseek.maxToolRounds ? tools.map((tool) => tool.definition) : [];
    const result = await complete(messages, offerTools, { temperature: config.deepseek.temperature });
    const message = result.choices?.[0]?.message;
    // choices / message 缺失说明响应异常。
    if (!message) throw new Error("DeepSeek 返回为空");
    // 每轮记录 finish_reason 与 token 用量，便于调参和排查。
    logger.debug(
      `[deepseek] round=${round} finish=${result.choices?.[0]?.finish_reason} usage=${JSON.stringify(result.usage)}`,
    );

    const calls = message.tool_calls ?? [];
    const assistant: ChatMessage = { role: "assistant", content: message.content ?? "" };
    // reasoning_content 必须原样保留：挂了工具时 DeepSeek 会校验前序回合的该字段。
    if (message.reasoning_content) assistant.reasoning_content = message.reasoning_content;
    // 没有工具调用即本轮结束，返回文本。
    if (calls.length === 0) return message.content?.trim() ?? "";

    assistant.tool_calls = calls;
    messages.push(assistant);
    // 并行执行本轮的全部工具调用。
    const results = await Promise.all(calls.map((call) => runTool(byName, call)));
    // Promise.all 保序，results 与 calls 一一对应；按原顺序回填 tool 消息。
    calls.forEach((call, index) => messages.push({ role: "tool", tool_call_id: call.id, content: results[index]! }));
  }
}

/**
 * JSON 模式补全：提示词本身必须提到 JSON；模型偶尔输出畸形 JSON，解析失败重试一次。
 *
 * @param system 系统提示词
 * @param user 用户提示词
 * @param maxTokens 输出上限，默认 2000
 * @returns 解析后的 JSON 值（具体形状由提示词约定）
 */
export async function completeJson(system: string, user: string, maxTokens = 2000): Promise<unknown> {
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  for (let attempt = 0; ; attempt++) {
    const result = await complete(messages, [], { maxTokens, json: true });
    try {
      return JSON.parse(result.choices?.[0]?.message?.content ?? "");
    } catch (error) {
      // 重试一次仍解析失败，把解析错误抛给调用方。
      if (attempt >= 1) throw error;
      logger.debug("[deepseek] JSON 解析失败，重试");
    }
  }
}

/**
 * 识图：把图片（data URL）与指令一起发给模型，返回描述文本。
 * deepseek-flash 只接受 user 消息中的图片；此场景不挂工具。
 *
 * @param dataUrl 图片的 data URL
 * @param instruction 识图指令
 * @returns 模型输出文本（trim 后）；无内容时为空字符串
 */
export async function describeImage(dataUrl: string, instruction: string): Promise<string> {
  const result = await complete(
    [
      {
        role: "user",
        // 图片在前、指令文本在后。
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: instruction },
        ],
      },
    ],
    [],
    { maxTokens: 300 },
  );
  return result.choices?.[0]?.message?.content?.trim() ?? "";
}

/**
 * 执行一次工具调用：按名派发、解析 JSON 参数，并把一切异常转成字符串结果返回给模型。
 * 未知工具、参数非法、处理器抛错都不会中断工具循环——模型会看到错误文本并自行纠正。
 */
async function runTool(byName: Map<string, Tool>, call: ToolCall): Promise<string> {
  const tool = byName.get(call.function.name);
  // 未注册的工具名直接反馈给模型。
  if (!tool) return `未知工具: ${call.function.name}`;
  let args: Record<string, unknown>;
  try {
    // arguments 是 JSON 字符串；为空时按空对象处理。
    args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return "工具参数不是合法 JSON";
  }
  try {
    logger.info(`[tool] ${call.function.name} ${JSON.stringify(args)}`);
    return await tool.handler(args);
  } catch (error) {
    // 处理器抛错时只记 warn，错误文本作为工具结果交给模型。
    logger.warn(`[tool] ${call.function.name} 失败:`, (error as Error).message);
    return `工具调用失败: ${(error as Error).message}`;
  }
}
