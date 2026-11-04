import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_BATCH_ITEMS,
  batchBudgetMs,
  batchMaxTotalChars,
  clampMaxBytes,
  clampPshTimeoutMs,
  formatBatch,
  planBatch,
} from "../src/agent-client/batch.js";
import {
  TOOL_DEFINITIONS,
  handleToolCall,
  isToolName,
  type ToolReply,
} from "../src/agent-client/tools.js";

const LIMITS = { pshTimeoutMs: 30_000, maxOutputChars: 20_000 };

test("clampPshTimeoutMs：钳到 [1000, pshTimeoutMs]，非法值按上限", () => {
  assert.equal(clampPshTimeoutMs(1, 30_000), 1000);
  assert.equal(clampPshTimeoutMs(0, 30_000), 1000);
  assert.equal(clampPshTimeoutMs(-5, 30_000), 1000);
  assert.equal(clampPshTimeoutMs(5_000, 30_000), 5_000);
  assert.equal(clampPshTimeoutMs(90_000, 30_000), 30_000);
  assert.equal(clampPshTimeoutMs("nope", 30_000), 30_000);
  assert.equal(clampPshTimeoutMs(undefined, 30_000), 30_000);
  // pshTimeoutMs 配得比下界还小：下界优先，不能造出 0ms 的超时。
  assert.equal(clampPshTimeoutMs(500, 200), 1000);
});

test("clampMaxBytes：钳到 [1024, max(4×maxOutputChars, 64KiB)]", () => {
  // maxOutputChars 很小：64KiB 兜底。
  assert.equal(clampMaxBytes(1, 1_000), 1024);
  assert.equal(clampMaxBytes(1_000_000, 1_000), 65_536);
  // 正常配置：4× 上限。
  assert.equal(clampMaxBytes(1_000_000, 100_000), 400_000);
  assert.equal(clampMaxBytes(5_000, 100_000), 5_000);
  assert.equal(clampMaxBytes(undefined, 100_000), 262_144);
  assert.equal(clampMaxBytes("nope", 100_000), 262_144);
});

test("batchBudgetMs / batchMaxTotalChars：全部从调用参数派生", () => {
  assert.equal(batchBudgetMs(60_000), 59_000);
  assert.equal(batchBudgetMs(500), 1000);
  assert.equal(batchMaxTotalChars(20_000), 80_000);
  assert.equal(batchMaxTotalChars(1_000_000), 4_000_000);
});

test("planBatch：items 非数组 / 空 / 超上限一律整批拒绝", () => {
  assert.deepEqual(planBatch(undefined, LIMITS), { ok: false, error: "items 必须是数组" });
  assert.deepEqual(planBatch({}, LIMITS), { ok: false, error: "items 必须是数组" });
  assert.deepEqual(planBatch([], LIMITS), { ok: false, error: "items 不能为空" });

  const tooMany = Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => ({ type: "psh", command: "x" }));
  const rejected = planBatch(tooMany, LIMITS);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.error, /最多 16 项/);

  const exact = Array.from({ length: MAX_BATCH_ITEMS }, () => ({ type: "psh", command: "x" }));
  const accepted = planBatch(exact, LIMITS);
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal(accepted.dispatch.length, MAX_BATCH_ITEMS);
});

test("planBatch：非法项就地失败，其余照跑且保序", () => {
  const plan = planBatch(
    [
      { type: "psh", command: "Get-Process" },
      {},
      { type: "bogus" },
      { type: 7 },
      { type: "psh" },
      { type: "psh", command: "   " },
      { type: "read" },
      { type: "read", path: "C:\\a.log" },
    ],
    LIMITS,
  );
  assert.ok(plan.ok);
  if (!plan.ok) return;

  assert.equal(plan.total, 8);
  assert.deepEqual(
    plan.failures.map((failure) => failure.index),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    plan.dispatch.map((entry) => entry.index),
    [0, 7],
  );
  const [psh, read] = plan.dispatch.map((entry) => entry.item);
  assert.deepEqual(psh, {
    type: "psh",
    command: "Get-Process",
    timeout_ms: 30_000,
  });
  // 线协议里批量的 psh 项只有三个字段：多带的字段客户端会静默丢弃。
  assert.deepEqual(Object.keys(psh).sort(), ["command", "timeout_ms", "type"]);
  assert.deepEqual(read, { type: "read", path: "C:\\a.log", max_bytes: 80_000 });

  const messages = plan.failures.map((failure) => failure.error);
  assert.ok(messages.includes("缺少 type，应为 psh 或 read"));
  assert.ok(messages.includes("未知指令类型：bogus，应为 psh 或 read"));
  assert.ok(messages.includes("未知指令类型：7，应为 psh 或 read"));
  assert.ok(messages.includes("psh 缺少 command"));
  assert.ok(messages.includes("read 缺少 path"));
});

test("planBatch：逐项钳位沿用单条规则", () => {
  const plan = planBatch(
    [
      { type: "psh", command: "a", timeout_ms: 1 },
      { type: "psh", command: "b", timeout_ms: 999_999 },
      { type: "psh", command: "c", timeout_ms: "x" },
      { type: "read", path: "d", max_bytes: 1 },
      { type: "read", path: "e", max_bytes: 10_000_000 },
    ],
    { pshTimeoutMs: 45_000, maxOutputChars: 100_000 },
  );
  assert.ok(plan.ok);
  if (!plan.ok) return;
  const items = plan.dispatch.map((entry) => entry.item);
  assert.deepEqual(items[0], { type: "psh", command: "a", timeout_ms: 1000 });
  assert.deepEqual(items[1], { type: "psh", command: "b", timeout_ms: 45_000 });
  assert.deepEqual(items[2], { type: "psh", command: "c", timeout_ms: 45_000 });
  assert.deepEqual(items[3], { type: "read", path: "d", max_bytes: 1024 });
  assert.deepEqual(items[4], { type: "read", path: "e", max_bytes: 400_000 });
});

test("formatBatch：头部带 [i/N]、命令压成一行并截 60 字符", () => {
  const text = formatBatch(
    [
      { tool: "run_psh", target: "Get-\nProcess   -Name x", body: "exit=0" },
      { tool: "read_file", target: "C:\\a.log", body: "body" },
      { tool: "run_psh", target: "x".repeat(100), body: "exit=1" },
    ],
    10_000,
  );
  const lines = text.split("\n");
  assert.equal(lines[0], "[1/3] run_psh  Get- Process -Name x");
  assert.equal(lines[1], "exit=0");
  assert.equal(lines[2], "[2/3] read_file  C:\\a.log");
  assert.equal(lines[3], "body");

  const header = lines[4];
  assert.ok(header);
  const target = header.slice("[3/3] run_psh  ".length);
  assert.equal(target.length, 60);
  assert.ok(target.endsWith("…"));
});

test("formatBatch：未超上限时原样返回，不追加说明", () => {
  const text = formatBatch(
    [
      { tool: "run_psh", target: "a", body: "1" },
      { tool: "run_psh", target: "b", body: "2" },
    ],
    10_000,
  );
  assert.equal(text, "[1/2] run_psh  a\n1\n[2/2] run_psh  b\n2");
  assert.ok(!text.includes("未展示"));
});

test("formatBatch：超上限时只在项边界切，并注明从第几项起未展示", () => {
  const text = formatBatch(
    [
      { tool: "run_psh", target: "a", body: "A".repeat(100) },
      { tool: "run_psh", target: "b", body: "B".repeat(100) },
      { tool: "run_psh", target: "c", body: "C".repeat(100) },
    ],
    250,
  );
  const lines = text.split("\n");
  assert.equal(lines[0], "[1/3] run_psh  a");
  assert.equal(lines[1], "A".repeat(100));
  assert.match(lines[2] ?? "", /^（第 2 项起未展示：整批输出超过上限 250 字符）$/);
  assert.ok(!text.includes("B".repeat(100)));
  assert.ok(!text.includes("C".repeat(100)));
  // 切在项边界：保留的第一项正文完整，没有半条。
  assert.ok(text.includes("A".repeat(100)));
});

test("formatBatch：第一项都放不下时只留说明", () => {
  const text = formatBatch(
    [{ tool: "run_psh", target: "a", body: "A".repeat(200) }],
    50,
  );
  assert.match(text, /^（第 1 项起未展示：整批输出超过上限 50 字符）$/);
});

/** 假 invoker：记录下发参数，按调用返回预设回包。 */
function fakeInvoke(reply: ToolReply): {
  invoke: (tool: string, args: Record<string, unknown>) => Promise<ToolReply>;
  calls: { tool: string; args: Record<string, unknown> }[];
} {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    invoke: async (tool, args) => {
      calls.push({ tool, args });
      return reply;
    },
  };
}

test("handleToolCall：run_batch 已注册，schema 是宽松对象", () => {
  assert.ok(isToolName("run_batch"));
  assert.ok(isToolName("run_psh"));
  assert.ok(!isToolName("run_batchh"));
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "run_batch");
  assert.ok(definition);
  const schema = definition.inputSchema as {
    additionalProperties?: boolean;
    properties?: { items?: { minItems?: number; maxItems?: number } };
  };
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties?.items?.minItems, 1);
  assert.equal(schema.properties?.items?.maxItems, MAX_BATCH_ITEMS);
  // 不用 oneOf：逐项校验由服务端做。
  assert.equal("oneOf" in definition.inputSchema, false);
});

test("handleToolCall：items 非法/全部结构非法时 isError=true 且不下发", async () => {
  const notArray = fakeInvoke({ ok: true, result: {} });
  const notArrayOutcome = await handleToolCall("run_batch", { items: "x" }, notArray.invoke, LIMITS);
  assert.equal(notArrayOutcome.isError, true);
  assert.equal(notArrayOutcome.text, "items 必须是数组");
  assert.equal(notArray.calls.length, 0);

  const allInvalid = fakeInvoke({ ok: true, result: {} });
  const allInvalidOutcome = await handleToolCall(
    "run_batch",
    { items: [{ type: "bogus" }, { type: "psh" }] },
    allInvalid.invoke,
    LIMITS,
  );
  assert.equal(allInvalidOutcome.isError, true);
  assert.ok(allInvalidOutcome.text.includes("[1/2] run_batch  bogus"));
  assert.ok(allInvalidOutcome.text.includes("失败：未知指令类型：bogus，应为 psh 或 read"));
  assert.ok(allInvalidOutcome.text.includes("失败：psh 缺少 command"));
  assert.equal(allInvalid.calls.length, 0);
});

test("handleToolCall：整批超时/码不可兑付时 isError=true", async () => {
  const { invoke } = fakeInvoke({ ok: false, error: "调用超时：客户端在 60 秒内没有返回结果" });
  const outcome = await handleToolCall(
    "run_batch",
    { items: [{ type: "psh", command: "x" }] },
    invoke,
    LIMITS,
  );
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, "调用超时：客户端在 60 秒内没有返回结果");
});

test("handleToolCall：部分失败 isError=false，回包按原始索引合并保序", async () => {
  const { invoke, calls } = fakeInvoke({
    ok: true,
    result: {
      items: [
        { ok: true, result: { exit: 0, stdout: "proc" } },
        { ok: true, result: { text: "log", bytes: 3, encoding: "utf-8" } },
        { ok: false, error: "未执行（批次预算耗尽）" },
      ],
    },
  });
  const outcome = await handleToolCall(
    "run_batch",
    {
      items: [
        { type: "psh", command: "Get-Process" },
        { type: "read", path: "C:\\a.log" },
        { type: "bogus" },
        { type: "psh", command: "Get-Service" },
      ],
    },
    invoke,
    LIMITS,
  );
  assert.equal(outcome.isError, false);

  // 只下发合法项（3 条合法 → 回包 3 项），非法项不下发。
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.tool, "run_batch");
  const sent = calls[0]?.args.items as unknown[];
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[0], {
    type: "psh",
    command: "Get-Process",
    timeout_ms: 30_000,
  });
  // 防止以后又往 psh 项里塞客户端不认的字段（客户端会静默丢弃）。
  assert.deepEqual(Object.keys(sent[0] as object).sort(), ["command", "timeout_ms", "type"]);

  const lines = outcome.text.split("\n");
  assert.equal(lines[0], "[1/4] run_psh  Get-Process");
  assert.ok(outcome.text.includes("[2/4] read_file  C:\\a.log"));
  assert.ok(outcome.text.includes("log\n（共 3 字节）"));
  assert.ok(outcome.text.includes("[3/4] run_batch  bogus"));
  assert.ok(outcome.text.includes("失败：未知指令类型：bogus，应为 psh 或 read"));
  assert.ok(outcome.text.includes("[4/4] run_psh  Get-Service"));
  assert.ok(outcome.text.includes("失败：未执行（批次预算耗尽）"));
  // 原始顺序：非法项夹在中间，不能把后面的结果前移。
  assert.ok(
    outcome.text.indexOf("[3/4] run_batch  bogus") < outcome.text.indexOf("[4/4] run_psh  Get-Service"),
  );
});

test("handleToolCall：客户端全部项失败但确实执行过，isError=false", async () => {
  const { invoke } = fakeInvoke({
    ok: true,
    result: {
      items: [
        { ok: false, error: "文件不存在：C:\\a.log" },
        { ok: false, error: "未展示（整批输出超限）" },
      ],
    },
  });
  const outcome = await handleToolCall(
    "run_batch",
    { items: [{ type: "read", path: "C:\\a.log" }, { type: "psh", command: "x" }] },
    invoke,
    LIMITS,
  );
  assert.equal(outcome.isError, false);
  assert.ok(outcome.text.includes("[1/2] read_file  C:\\a.log"));
  assert.ok(outcome.text.includes("失败：文件不存在：C:\\a.log"));
  assert.ok(outcome.text.includes("失败：未展示（整批输出超限）"));
});

test("handleToolCall：回包缺 items 或项数不足时不静默丢项", async () => {
  const missing = fakeInvoke({ ok: true, result: {} });
  const missingOutcome = await handleToolCall(
    "run_batch",
    { items: [{ type: "psh", command: "x" }] },
    missing.invoke,
    LIMITS,
  );
  assert.equal(missingOutcome.isError, true);
  assert.equal(missingOutcome.text, "客户端回包缺少 items");

  const short = fakeInvoke({ ok: true, result: { items: [] } });
  const shortOutcome = await handleToolCall(
    "run_batch",
    { items: [{ type: "psh", command: "x" }] },
    short.invoke,
    LIMITS,
  );
  assert.equal(shortOutcome.isError, false);
  assert.ok(shortOutcome.text.includes("失败：客户端回包缺少该项结果"));
});

test("handleToolCall：整批聚合也按 max_total_chars 截断并写明上限", async () => {
  const body = "A".repeat(100);
  const { invoke } = fakeInvoke({
    ok: true,
    result: {
      items: [
        { ok: true, result: { exit: 0, stdout: body } },
        { ok: true, result: { exit: 0, stdout: body } },
        { ok: true, result: { exit: 0, stdout: body } },
      ],
    },
  });
  const limits = { pshTimeoutMs: 30_000, maxOutputChars: 30 };
  const outcome = await handleToolCall(
    "run_batch",
    {
      items: [
        { type: "psh", command: "a" },
        { type: "psh", command: "b" },
        { type: "psh", command: "c" },
      ],
    },
    invoke,
    limits,
  );
  // 整批上限 4×30 = 120：每项按单条上限截断后，仍会触发整批截断说明。
  assert.ok(outcome.text.includes("（已截断，原始"));
  assert.match(outcome.text, /（第 \d+ 项起未展示：整批输出超过上限 120 字符）$/);
  assert.ok(outcome.text.includes("[1/3] run_psh  a"));
});
