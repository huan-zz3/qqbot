/**
 * deepseek.ts —— 回复模型 deepseek-flash 的底层调用封装：聊天补全（含工具循环）、JSON 输出。
 *
 * 关键概念：
 * - 回复只用 deepseek-flash 一个模型（DEEPSEEK_MODEL 硬编码），不做模型切换或降级；
 *   图像识别是另一个独立后端（src/llm/vision.ts），与本模块互不引用；
 * - 工具循环 chatWithTools：模型可多轮调用工具，直到给出纯文本为止；工具按「组」各自
 *   计数，每组最多提供自己上限的轮数（SEARCH_MAX_TOOL_ROUNDS / OPENCODE_MAX_TOOL_ROUNDS）；
 *   某组用满只撤该组，全部组用满才不再挂工具，迫使模型收尾作答；
 * - DeepSeek 的坑：挂了工具时，前序 assistant 回合的 reasoning_content 必须原样回传，
 *   否则接口会以 400 拒绝请求（见 chatWithTools 中 assistant 消息的构造）；
 * - JSON 模式 completeJson：提示词本身必须提到 JSON；模型偶尔输出畸形 JSON，失败重试一次。
 *
 * 依赖 config.deepseek（apiKey、baseUrl、超时、thinking、maxTokens、temperature）。
 */
import { config } from "../config.js";
import { logger } from "../logger.js";
import { dumpPrompt } from "../prompt-dump.js";

/** 硬编码的模型名：全项目唯一使用的模型，不提供其它模型或降级路径。 */
export const DEEPSEEK_MODEL = "deepseek-flash";

/**
 * 工具额度用尽那一轮追加给模型的收尾指令（user 消息）。
 * 目的：让模型明确知道工具已不可用，只能纯文本作答，避免它把工具调用语法
 * （function_calls/invoke/parameter 或 <|DSML|> 标记）当作普通文本写出、进而被当消息发出去。
 */
const TOOL_QUOTA_NOTICE =
  "工具调用次数已用尽，本轮起不再提供任何工具。请不要再输出任何工具调用，包括 function_calls、" +
  "invoke、parameter 等标签或 <|DSML|> 之类的特殊标记；直接用文字回答。";

/**
 * 某一工具组额度用尽时追加的收尾提示（user 消息）。
 * 目的：告知模型该组工具本轮起不可用，避免它继续尝试调用已撤下的工具。
 */
function groupExhaustedNotice(label: string): string {
  return `${label}的调用次数已用尽，本轮起不再提供该工具；请不要再输出对它的调用，可以改用其它工具或用文字回答。`;
}

/** 模型请求调用工具的动作（OpenAI 兼容格式）；arguments 是 JSON 字符串，需先解析。 */
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/**
 * 发给 /chat/completions 的消息联合类型（OpenAI 兼容）。
 * - tool 消息通过 tool_call_id 与对应 assistant 消息的 tool_calls 一一对应；
 * - assistant 的 reasoning_content 在挂了工具时必须原样回传（见 chatWithTools）。
 */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
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

/**
 * 工具组：一组共享同一轮数预算的工具。不同组各自独立计轮——某组用满只撤该组，
 * 不影响其它组。搜索后端暴露的全部 MCP 工具归为一组，opencode 工具自成一组。
 * - name：日志用短名；
 * - label：逐组耗尽提示里的中文名；
 * - maxRounds：该组最多被调用几轮（非正表示不提供该组）。
 */
export type ToolGroup = {
  name: string;
  label: string;
  tools: Tool[];
  maxRounds: number;
};

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

  // 调试落盘：目录未配置时为空操作，失败不影响请求。
  dumpPrompt("llm", body);

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
 * 运行工具循环，直到模型给出文本回复。工具按「组」各自独立计轮。
 *
 * 每轮先把「未用满上限」的组里的工具挂给模型；模型返回 tool_calls 时并行执行、按原顺序回填，
 * 并把本轮命中的组各计一轮，再进入下一轮。模型不再调用工具时返回文本。
 *
 * 额度提示：
 * - 未全部用尽时，某组刚用满会追加一条 user 提示，告知该组工具本轮起不可用；
 * - 全部用尽时，追加一条 user 收尾指令明确要求纯文本作答。收尾轮为真正的最后一轮：
 *   若模型仍返回 tool_calls，不再执行，直接取其文本内容收尾。
 *
 * 终止性：每个未收尾的轮次至少使一个可用组的计数 +1（命中可执行调用），总轮数受各组上限之和约束。
 *
 * 注意：挂了工具时，DeepSeek 要求每个前序 assistant 回合的 reasoning_content 原样回传，
 * 否则会 400，因此 assistant 消息会保留该字段。
 *
 * @param initial 初始对话消息
 * @param groups 本次可用的工具组（各组独立计轮）；缺省/空表示不挂工具
 * @returns 模型最终的文本回复（trim 后，可能为空串）
 */
export async function chatWithTools(initial: ChatMessage[], groups: ToolGroup[] = []): Promise<string> {
  // 复制一份，避免在循环中改动调用方传入的数组。
  const messages = [...initial];
  // 所有组内工具按函数名索引，供 runTool 派发。
  const byName = new Map(groups.flatMap((group) => group.tools).map((tool) => [tool.definition.function.name, tool]));
  // 是否「曾经挂过工具」（有工具且上限为正）：决定全部用尽时是否注入纯文本收尾指令。
  const hadTools = groups.some((group) => group.tools.length > 0 && group.maxRounds > 0);
  // 逐组运行时状态：已用轮数 + 是否已发过该组耗尽的提示。
  const state = groups.map((group) => ({ group, used: 0, noticed: false }));
  // 全部用尽的收尾指令只注入一次。
  let finalNoticeSent = false;

  // 无轮次上限，靠逐组计数推进循环终止。
  for (;;) {
    // 可提供组：未用满上限且确实有工具。
    const available = state.filter((s) => s.used < s.group.maxRounds && s.group.tools.length > 0);
    // 全部组都用满（或本来就没挂工具）。
    const allExhausted = available.length === 0;

    if (allExhausted) {
      // 曾经挂过工具才注入收尾指令；本来就没工具的普通调用无需干预。
      if (!finalNoticeSent && hadTools) {
        finalNoticeSent = true;
        messages.push({ role: "user", content: TOOL_QUOTA_NOTICE });
        logger.info(
          `[deepseek] 全部工具组额度用尽（${describeState(state)}），要求模型纯文本作答`,
        );
      }
    } else {
      // 逐组提示：某组刚用满、尚未提示过，注入一条「该组不可用」的提示。
      for (const s of state) {
        if (s.used >= s.group.maxRounds && s.group.tools.length > 0 && s.group.maxRounds > 0 && !s.noticed) {
          s.noticed = true;
          messages.push({ role: "user", content: groupExhaustedNotice(s.group.label) });
          logger.info(`[deepseek] ${s.group.name} 工具组额度用尽（${s.used}/${s.group.maxRounds}），不再提供该组工具`);
        }
      }
    }

    const offerTools = available.flatMap((s) => s.group.tools.map((tool) => tool.definition));
    const result = await complete(messages, offerTools, { temperature: config.deepseek.temperature });
    const message = result.choices?.[0]?.message;
    // choices / message 缺失说明响应异常。
    if (!message) throw new Error("DeepSeek 返回为空");
    // 每轮记录可用组、finish_reason 与 token 用量，便于调参和排查。
    logger.debug(
      `[deepseek] available=[${describeState(available)}] finish=${result.choices?.[0]?.finish_reason} usage=${JSON.stringify(result.usage)}`,
    );

    const calls = message.tool_calls ?? [];
    // 没有工具调用即本轮结束，返回文本。
    if (calls.length === 0) return message.content?.trim() ?? "";

    // 全部组已用尽：忽略模型返回的工具调用（额度已尽），直接取其文本内容收尾。
    if (allExhausted) {
      logger.warn(`[deepseek] 全部工具组额度已用尽，忽略模型返回的 ${calls.length} 个工具调用`);
      return message.content?.trim() ?? "";
    }

    // 可执行调用 = 命中可提供组的调用；其余（已用尽组、未注册工具）本轮不真正执行。
    const availableNames = new Set(
      available.flatMap((s) => s.group.tools.map((tool) => tool.definition.function.name)),
    );
    const executable = calls.filter((call) => availableNames.has(call.function.name));
    // 本轮没有任何可执行调用：无法推进任何组的计数，直接收尾以保证循环终止。
    if (executable.length === 0) {
      logger.warn(
        `[deepseek] 本轮工具调用均不属于可用工具组，直接收尾：${calls.map((call) => call.function.name).join(", ")}`,
      );
      return message.content?.trim() ?? "";
    }

    const assistant: ChatMessage = { role: "assistant", content: message.content ?? "" };
    // reasoning_content 必须原样保留：挂了工具时 DeepSeek 会校验前序回合的该字段。
    if (message.reasoning_content) assistant.reasoning_content = message.reasoning_content;
    assistant.tool_calls = calls;
    messages.push(assistant);
    // 并行执行本轮全部调用：可执行的真正派发，其余返回「不可用」文本以保持 assistant/tool 配对完整。
    const results = await Promise.all(
      calls.map((call) => {
        if (availableNames.has(call.function.name)) return runTool(byName, call);
        logger.warn(`[deepseek] 忽略对不可用工具 ${call.function.name} 的调用（已用尽或未提供）`);
        return Promise.resolve(`${call.function.name} 本轮不可用（该工具的额度已用尽或未提供）`);
      }),
    );
    // Promise.all 保序，results 与 calls 一一对应；按原顺序回填 tool 消息。
    calls.forEach((call, index) => messages.push({ role: "tool", tool_call_id: call.id, content: results[index]! }));

    // 本轮命中的可提供组各计一轮。
    const usedNames = new Set(executable.map((call) => call.function.name));
    for (const s of available) {
      if (s.group.tools.some((tool) => usedNames.has(tool.definition.function.name))) s.used += 1;
    }
  }
}

/** 把一组运行时状态拼成 `name used/max` 列表，供日志展示。 */
function describeState(state: Array<{ group: ToolGroup; used: number }>): string {
  if (state.length === 0) return "";
  return state.map((s) => `${s.group.name} ${s.used}/${s.group.maxRounds}`).join(", ");
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
