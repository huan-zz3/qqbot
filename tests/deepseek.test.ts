/**
 * deepseek.test.ts —— src/llm/deepseek.js 的工具循环与 JSON 模式测试。
 *
 * 覆盖：
 * - chatWithTools：执行工具并把结果回填给模型，返回最终文本；请求体 model 固定
 *   deepseek-flash、默认温度 1.1；前序 assistant 回合的 reasoning_content
 *   必须原样回传（DeepSeek 挂工具时的硬性要求，否则接口 400）；
 * - 工具按组各自独立计轮：某组用满只撤该组并注入「该组不可用」提示，各组都用满才注入
 *   「纯文本作答」收尾指令；收尾轮若模型仍返回 tool_calls，不再执行，直接取其文本内容收尾；
 * - 工具参数不是合法 JSON 时，把错误文本作为工具结果交回模型而非抛错；
 * - completeJson：解析失败重试一次，两次都失败才抛错；JSON 调用不提交 temperature。
 *
 * 说明：globalThis.fetch 全部 mock，不触网；env 必须在动态 import 之前设置。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// 必须在 import deepseek.js 之前设置（config.ts 在 import 时读取）。
process.env.DEEPSEEK_API_KEY = "test-key";

// 动态引入被测模块（env 已生效）。
const { chatWithTools, completeJson, DEEPSEEK_MODEL } = await import("../src/llm/deepseek.js");

// 请求体形状：仅声明本测试断言用到的字段（tests 不做类型检查）。
type Body = { model: string; messages: any[]; tools?: unknown[]; thinking: { type: string }; temperature?: number };

// 用一串预设响应 mock fetch，并按顺序捕获每次请求的 JSON body 供断言。
function mockFetch(responses: unknown[]): Body[] {
  const bodies: Body[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Body);
    // 每个请求按顺序弹出一个预设响应。
    const next = responses.shift();
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return bodies;
}

// 构造一个搜索工具：handler 记录 query 并返回固定结果，用于观察工具循环。
const searchTool = (log: string[]) => ({
  definition: {
    type: "function" as const,
    function: { name: "search", description: "search", parameters: { type: "object", properties: {} } },
  },
  handler: async (args: Record<string, unknown>) => {
    log.push(String(args.query));
    return "结果: 42";
  },
});

// 构造一个工具组：默认组名 search、展示名「联网搜索」，便于单独断言各组独立计轮。
const groupOf = (tools: unknown[], maxRounds: number, name = "search") => ({
  name,
  label: name === "search" ? "联网搜索" : name,
  tools,
  maxRounds,
});

/**
 * 完整工具循环：第一轮模型返回 reasoning_content + search 工具调用，
 * 第二轮给出最终文本。断言：
 * - 返回文本来自第二轮，handler 收到解析后的 query；
 * - 请求体 model 恒为 deepseek-flash、默认 temperature 1.1；
 * - 第二次请求里 assistant 回合的 reasoning_content 与 tool_calls 原样回传，
 *   工具结果以对应 tool_call_id 的 tool 消息回填
 *   （reasoning_content 不回传会被 DeepSeek 以 400 拒绝）。
 */
test("runs tools and passes reasoning_content back", async () => {
  // 预设两轮响应：先工具调用，再最终答复。
  const bodies = mockFetch([
    {
      choices: [
        {
          message: {
            content: "",
            reasoning_content: "需要查一下",
            tool_calls: [{ id: "c1", type: "function", function: { name: "search", arguments: '{"query":"答案"}' } }],
          },
        },
      ],
    },
    { choices: [{ message: { content: "答案是42", reasoning_content: "查到了" } }] },
  ]);
  // 记录工具 handler 实际收到的查询词。
  const log: string[] = [];
  const text = await chatWithTools([{ role: "user", content: "问题" }], [groupOf([searchTool(log)], 2)]);

  // 最终返回第二轮的文本。
  assert.equal(text, "答案是42");
  // handler 收到了解析后的 query 参数。
  assert.deepEqual(log, ["答案"]);
  // 请求体使用导出的模型常量。
  assert.equal(bodies[0]!.model, DEEPSEEK_MODEL);
  // 常量值就是字面量 deepseek-flash（全项目唯一模型）。
  assert.equal(bodies[0]!.model, "deepseek-flash");
  // 工具循环使用默认采样温度 1.1。
  assert.equal(bodies[0]!.temperature, 1.1);
  // 第二次请求的完整消息序列。
  const second = bodies[1]!.messages;
  assert.equal(second[1].role, "assistant");
  // assistant 回合的 reasoning_content 原样回传。
  assert.equal(second[1].reasoning_content, "需要查一下");
  // tool_calls 的 id 也原样保留。
  assert.equal(second[1].tool_calls[0].id, "c1");
  // 工具结果以 role=tool、匹配的 tool_call_id 回填。
  assert.deepEqual(second[2], { role: "tool", tool_call_id: "c1", content: "结果: 42" });
});

/**
 * 工具组轮数上限：该组 maxRounds=2，前两轮照常提供工具；
 * 第三轮请求体不再携带 tools，迫使模型收尾给出文本「好」。
 */
test("stops offering tools after the round limit", async () => {
  // 一个永远要求调用工具的响应。
  const call = {
    choices: [
      { message: { content: "", tool_calls: [{ id: "c", type: "function", function: { name: "search", arguments: "{}" } }] } },
    ],
  };
  // 预设 3 轮响应：工具调用、工具调用、最终文本。
  const bodies = mockFetch([call, call, { choices: [{ message: { content: "好" } }] }]);
  const text = await chatWithTools([{ role: "user", content: "q" }], [groupOf([searchTool([])], 2)]);
  assert.equal(text, "好");
  // 一共发了 3 次请求。
  assert.equal(bodies.length, 3);
  // 前两轮请求体里带 tools。
  assert.ok(bodies[0]!.tools && bodies[1]!.tools);
  // 超过上限后不再提供工具，迫使模型收尾。
  assert.equal(bodies[2]!.tools, undefined);
  // 收尾轮额外注入一条 user 收尾指令（明确要求纯文本作答）。
  assert.equal(bodies[2]!.messages.at(-1).role, "user");
  assert.match(bodies[2]!.messages.at(-1).content, /工具调用次数已用尽/);
});

/**
 * 收尾轮模型不守规矩、仍返回 tool_calls 时：不再执行（额度已用尽），
 * 直接取其文本内容收尾，保证循环终止、工具 handler 不被多调。
 */
test("ignores tool calls returned after the round limit", async () => {
  // 一个永远要求调用工具的响应（收尾轮也带上一段文本）。
  const call = {
    choices: [
      { message: { content: "还想调", tool_calls: [{ id: "c", type: "function", function: { name: "search", arguments: "{}" } }] } },
    ],
  };
  const bodies = mockFetch([call, call, call]);
  const log: string[] = [];
  const text = await chatWithTools([{ role: "user", content: "q" }], [groupOf([searchTool(log)], 2)]);
  // 收尾轮的文本内容被采用。
  assert.equal(text, "还想调");
  // 总共 3 次请求；前两轮执行了工具，收尾轮的调用被忽略。
  assert.equal(bodies.length, 3);
  assert.equal(log.length, 2);
});

/**
 * 工具参数是畸形 JSON（"{oops"）时不抛错：
 * 错误文案「工具参数不是合法 JSON」作为工具结果回填，模型随后给出「ok」。
 */
test("bad tool arguments are reported to the model instead of throwing", async () => {
  // 第一轮返回 arguments 无法解析为 JSON 的工具调用。
  const bodies = mockFetch([
    { choices: [{ message: { content: null, tool_calls: [{ id: "x", type: "function", function: { name: "search", arguments: "{oops" } }] } }] },
    { choices: [{ message: { content: "ok" } }] },
  ]);
  // 参数非法不中断循环，最终仍拿到文本回复。
  assert.equal(await chatWithTools([{ role: "user", content: "q" }], [groupOf([searchTool([])], 2)]), "ok");
  // 回填给模型的最后一条消息是错误提示。
  assert.equal(bodies[1]!.messages.at(-1).content, "工具参数不是合法 JSON");
});

// 构造一个指定名字的工具：handler 记录被调用并返回固定结果，用于观察两组独立计轮。
const namedTool = (name: string, log: string[]) => ({
  definition: {
    type: "function" as const,
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  },
  handler: async () => {
    log.push(name);
    return `结果: ${name}`;
  },
});

/**
 * 两组各自独立计轮：搜索组 maxRounds=1、opencode 组 maxRounds=1。
 * - 第 1 轮两组都挂上，模型只调搜索 → 搜索用满；
 * - 第 2 轮只挂 opencode（搜索被撤），并注入「联网搜索不可用」提示；
 * - 第 3 轮两组都用满，注入「纯文本作答」收尾指令、不再挂工具。
 */
test("counts tool rounds per group independently", async () => {
  const calls = [
    { choices: [{ message: { content: "", tool_calls: [{ id: "s", type: "function", function: { name: "search", arguments: "{}" } }] } }] },
    { choices: [{ message: { content: "", tool_calls: [{ id: "o", type: "function", function: { name: "opencode", arguments: "{}" } }] } }] },
    { choices: [{ message: { content: "好" } }] },
  ];
  const bodies = mockFetch(calls);
  const text = await chatWithTools([{ role: "user", content: "q" }], [
    groupOf([namedTool("search", [])], 1),
    groupOf([namedTool("opencode", [])], 1, "opencode"),
  ]);
  assert.equal(text, "好");
  assert.equal(bodies.length, 3);
  // 第 1 轮两组都挂。
  const first = (bodies[0]!.tools as any[]).map((t) => t.function.name);
  assert.deepEqual(first.sort(), ["opencode", "search"]);
  // 第 2 轮搜索已撤，只剩 opencode，并注入该组不可用提示。
  const second = (bodies[1]!.tools as any[]).map((t) => t.function.name);
  assert.deepEqual(second, ["opencode"]);
  assert.match(bodies[1]!.messages.at(-1).content, /联网搜索的调用次数已用尽/);
  // 第 3 轮两组都用满：不再挂工具，注入纯文本收尾指令。
  assert.equal(bodies[2]!.tools, undefined);
  assert.match(bodies[2]!.messages.at(-1).content, /工具调用次数已用尽/);
});

/**
 * 同一轮同时调用两组时，两组计数各 +1：两组 maxRounds 均为 1，
 * 第 1 轮一次调用两组，第 2 轮即全部用满、不再挂工具。
 */
test("a round calling both groups advances both counters", async () => {
  const both = {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            { id: "s", type: "function", function: { name: "search", arguments: "{}" } },
            { id: "o", type: "function", function: { name: "opencode", arguments: "{}" } },
          ],
        },
      },
    ],
  };
  const bodies = mockFetch([both, { choices: [{ message: { content: "好" } }] }]);
  const log: string[] = [];
  const text = await chatWithTools([{ role: "user", content: "q" }], [
    groupOf([namedTool("search", log)], 1),
    groupOf([namedTool("opencode", log)], 1, "opencode"),
  ]);
  assert.equal(text, "好");
  // 两组各执行一次。
  assert.deepEqual(log.sort(), ["opencode", "search"]);
  // 第 2 轮两组都已用满：不再挂工具。
  assert.equal(bodies[1]!.tools, undefined);
});

/**
 * 调用已用尽组的工具：不真正执行（handler 不再被调），且因本轮没有可执行调用，
 * 直接取文本收尾以保证循环终止。
 */
test("does not execute calls to an exhausted group and finalizes", async () => {
  const callSearch = {
    choices: [{ message: { content: "", tool_calls: [{ id: "s", type: "function", function: { name: "search", arguments: "{}" } }] } }],
  };
  // 第 2 轮模型无视提示、仍调用已用尽的搜索，并带上一段文本。
  const callSearchAgain = {
    choices: [{ message: { content: "算了", tool_calls: [{ id: "s2", type: "function", function: { name: "search", arguments: "{}" } }] } }],
  };
  const bodies = mockFetch([callSearch, callSearchAgain]);
  const log: string[] = [];
  const text = await chatWithTools([{ role: "user", content: "q" }], [
    groupOf([namedTool("search", log)], 1),
    groupOf([namedTool("opencode", log)], 1, "opencode"),
  ]);
  // 已用尽组的调用被忽略，直接取其文本收尾。
  assert.equal(text, "算了");
  assert.equal(bodies.length, 2);
  // handler 只在第 1 轮被调用一次。
  assert.deepEqual(log, ["search"]);
});

/**
 * completeJson 的失败重试与参数约定：
 * - 第一次输出畸形 JSON，重试一次后成功（共 2 次请求），返回解析结果；
 * - JSON 模式不提交 temperature 字段；
 * - 连续两次都解析失败时把解析错误抛给调用方。
 */
test("JSON extraction retries once on malformed output and uses default temperature", async () => {
  // 第一次畸形（缺逗号）、第二次合法。
  const bodies = mockFetch([
    { choices: [{ message: { content: '{"people":[{"user_id":1 "facts":[]}]}' } }] },
    { choices: [{ message: { content: '{"people":[]}' } }] },
  ]);
  // 重试后返回解析结果。
  assert.deepEqual(await completeJson("sys json", "user"), { people: [] });
  // 一共请求了两次：失败 + 重试。
  assert.equal(bodies.length, 2);
  // JSON 调用不提交 temperature。
  assert.equal(bodies[0]!.temperature, undefined);

  // 两次都畸形 → 最终 reject。
  mockFetch([{ choices: [{ message: { content: "{bad" } }] }, { choices: [{ message: { content: "{bad" } }] }]);
  await assert.rejects(completeJson("sys json", "user"));
});
