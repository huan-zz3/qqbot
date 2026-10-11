/**
 * learn-gating.test.ts —— ChatRuntime 批量记忆整理的触发门槛测试。
 *
 * 规则：只有 bot 最近说过话的会话（engagedWindow 内），未整理消息攒够
 * MEMORY_LEARN_BATCH 条才触发整理；bot 从没参与过的会话攒再多也不学。
 *
 * 注意：env 必须在动态 import 之前设置（config.ts 在 import 时读取）；
 * 延迟整理（MEMORY_LEARN_DELAY_MS）设成超大值，让测试期间只可能触发
 * 「攒够条数立即整理」这一条路径，排除定时器干扰断言。
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 以下 env 都必须在动态 import ChatRuntime 之前设置：config.ts import 时即固化。
process.env.BOT_NAME = "小猫";
process.env.BOT_GROUPS = "500,600";
process.env.DEEPSEEK_API_KEY = "test-key";
// 防抖调小到 10ms，让每个批次很快进入判断。
process.env.GATE_GROUP_DEBOUNCE_MS = "10";
process.env.GATE_DIRECT_DEBOUNCE_MS = "10";
process.env.NAPCAT_SEND_INTERVAL_MS = "0";
// 攒够 3 条未整理消息就批量整理记忆（本测试的核心门槛）。
process.env.MEMORY_LEARN_BATCH = "3";
// 延迟整理设为超大值：排除「回复后等对话停下再整理」这条路径的干扰。
process.env.MEMORY_LEARN_DELAY_MS = "100000";
process.env.LOG_LEVEL = "silent";

// 动态引入被测模块（env 已生效）。
const { ChatRuntime } = await import("../src/chat/runtime.js");
const { MemoryStore } = await import("../src/chat/memory.js");
// 从 ChatRuntime 的构造参数类型取出依赖形状（tests 不做类型检查，仅作书写别名）。
type Deps = ConstructorParameters<typeof ChatRuntime>[0];

// 消息 ID 自增计数器，模拟协议端分配。
let nextId = 1;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// 构造一条群聊消息事件：正文放在最后，extra 用来插入 @ 等消息段。
const message = (groupId: number, text: string, extra: Record<string, unknown>[] = []) => ({
  post_type: "message" as const,
  message_type: "group" as const,
  message_id: nextId++,
  user_id: 7,
  group_id: groupId,
  self_id: 100,
  time: Math.floor(Date.now() / 1000),
  message: [...extra, { type: "text", data: { text } }] as { type: string; data: Record<string, unknown> }[],
  sender: { user_id: 7, nickname: "张三" },
});

/**
 * 批量整理只发生在 bot 最近参与过的会话：
 * - 群 600 里 bot 从不发言，累积 4 条消息也绝不触发整理；
 * - 群 500 里 bot 先被 @ 触发一条回复（算「参与」），随后攒够 3 条未整理消息即整理一次。
 */
test("batch learning only happens where the bot recently took part", async () => {
  // mock DeepSeek（runtime 生成回复时调用）：任何请求都返回固定文本「嗯」。
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "嗯" } }] }), { status: 200 })) as typeof fetch;
  // 记录每次记忆整理时看到的会话首行（场景行含群号），用于断言整理了哪个会话。
  const learned: string[] = [];
  // 假提取器：把 user 提示词第一行（如「场景：QQ群「500」」）记下来，返回空 people。
  const memory = new MemoryStore(join(tmpdir(), `qqbot-gate-${process.pid}.json`), async (_system, user) => {
    learned.push(user.split("\n")[0]!);
    return { people: [] };
  });
  // 最小 NapCat 客户端桩：发送返回自增 ID；callAction 一律成功（群名/群名片查询不会真发生）。
  const client = {
    selfId: 100,
    sendMessage: async () => nextId++,
    sendForward: async () => nextId++,
    callAction: async () => ({ status: "ok" as const, retcode: 0, data: {} }),
  } as unknown as Deps["client"];
  // 假 decider：文本含「@小猫」给 0.9（高于阈值触发回复），否则 0。
  const decider = async (state: unknown) => {
    const text = (state as { new_messages: { text: string }[] }).new_messages[0]!.text;
    return { should_reply: text.includes("@小猫") ? 0.9 : 0 };
  };
  // 组装运行时：不带搜索/表情包，注入假记忆与假判定。
  const runtime = new ChatRuntime({ client, decider, search: undefined, stickers: undefined, memory });

  // 群 600（白名单内）：连发 4 条闲聊，bot 全程不发言。
  for (let i = 0; i < 4; i++) {
    runtime.handle(message(600, `闲聊${i}`));
    await wait(30);
  }
  await wait(50);
  // 即使 4 条超过 learnBatch=3 也没整理过：bot 没参与过的会话不批量学习。
  assert.deepEqual(learned, []);

  // 群 500：@ 100（bot）触发一次回复，bot 在此会话「参与」了对话。
  runtime.handle(message(500, "在吗", [{ type: "at", data: { qq: "100" } }]));
  await wait(100);
  // 随后再攒 3 条消息，达到 learnBatch=3 → 触发批量整理。
  for (let i = 0; i < 3; i++) {
    runtime.handle(message(500, `继续${i}`));
    await wait(30);
  }
  await wait(50);
  // 恰好整理一次。
  assert.equal(learned.length, 1);
  // 整理的会话场景行里能看到群号 500。
  assert.match(learned[0]!, /500/);
});
