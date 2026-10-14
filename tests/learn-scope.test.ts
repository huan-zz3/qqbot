/**
 * learn-scope.test.ts —— ChatRuntime 记忆整理「范围与触发」测试。
 *
 * 规则：记忆只在 bot 实际发出回复后整理，且范围仅限触发该次回复的那批消息；
 * 延迟窗（MEMORY_LEARN_DELAY_MS）内的多次回复合并成一次整理；/停止 清空待整理批。
 *
 * 注意：env 必须在动态 import 之前设置（config.ts 在 import 时读取）。
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 以下 env 都必须在动态 import ChatRuntime 之前设置：config.ts import 时即固化。
process.env.BOT_NAME = "小猫";
process.env.BOT_GROUPS = "500,600";
process.env.BOT_ADMIN_USERS = "1";
process.env.DEEPSEEK_API_KEY = "test-key";
// 防抖调小到 10ms，让每个批次很快进入判断。
process.env.GATE_GROUP_DEBOUNCE_MS = "10";
process.env.GATE_DIRECT_DEBOUNCE_MS = "10";
process.env.NAPCAT_SEND_INTERVAL_MS = "0";
// 回复后 300ms 再整理：窗口够宽以便验证「多次回复合并为一次」。
process.env.MEMORY_LEARN_DELAY_MS = "300";
process.env.LOG_LEVEL = "silent";

// 动态引入被测模块（env 已生效）。
const { ChatRuntime } = await import("../src/chat/runtime.js");
const { MemoryStore } = await import("../src/chat/memory.js");
// 从 ChatRuntime 的构造参数类型取出依赖形状（tests 不做类型检查，仅作书写别名）。
type Deps = ConstructorParameters<typeof ChatRuntime>[0];

// 消息 ID 自增计数器，模拟协议端分配。
let nextId = 1;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// 轮询等待条件成立（最多 timeoutMs），避免依赖固定睡眠造成的时序抖动。
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) await wait(20);
}
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

// 管理员私聊指令事件（默认 /停止）。
const adminMessage = (text: string) => ({
  post_type: "message" as const,
  message_type: "private" as const,
  message_id: nextId++,
  user_id: 1,
  group_id: undefined,
  self_id: 100,
  time: Math.floor(Date.now() / 1000),
  message: [{ type: "text", data: { text } }] as { type: string; data: Record<string, unknown> }[],
  sender: { user_id: 1, nickname: "admin" },
});

/**
 * 组装运行时：假 decider（@小猫 才回复）、假 client（动作一律成功）、
 * 以及记录提示词的假记忆提取器（把 user 提示词推进 learned，返回给定 answer）。
 * @param answer 假提取器返回的 JSON。
 * @param learned 收集每次整理时的 user 提示词，供断言整理了哪些内容。
 * @param withPower 是否注入假电源开关（/停止 用例需要）。
 */
function setup(answer: unknown, learned: string[], withPower = false) {
  // 假 DeepSeek：任何请求都返回固定文本「嗯」。
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "嗯" } }] }), { status: 200 })) as typeof fetch;
  const memory = new MemoryStore(join(tmpdir(), `qqbot-scope-${process.pid}-${nextId}.json`), async (_system, user) => {
    learned.push(user);
    return answer;
  });
  // 记录发送的消息目标，供「回复已发出」的判定使用。
  const sent: { target: unknown; message: unknown[] }[] = [];
  // 最小 NapCat 客户端桩：发送返回自增 ID；callAction 一律成功（群名/群名片查询不会真发生）。
  const client = {
    selfId: 100,
    sendMessage: async (target: unknown, message: unknown[]) => {
      sent.push({ target, message });
      return nextId++;
    },
    sendForward: async () => nextId++,
    callAction: async () => ({ status: "ok" as const, retcode: 0, data: {} }),
  } as unknown as Deps["client"];
  // 假 decider：本批任一消息含「@小猫」给 0.9（触发回复），否则 0。
  const decider = async (state: unknown) => {
    const msgs = (state as { new_messages: { text: string }[] }).new_messages;
    return { should_reply: msgs.some((m) => m.text.includes("@小猫")) ? 0.9 : 0 };
  };
  // 假电源开关：仅在需要 /停止 的用例里注入。
  const power = withPower
    ? ({ on: true, load: async () => undefined, set: async () => undefined } as unknown as Deps["power"])
    : undefined;
  const runtime = new ChatRuntime({ client, decider, search: undefined, stickers: undefined, memory, power });
  return { runtime, memory, sent };
}

/**
 * bot 从未回复的会话不整理记忆：群 600 连发 4 条闲聊（decider 一律说不回），
 * 等待超过整理延迟后假提取器一次都没被调用。
 */
test("no reply means no memory learning", async () => {
  const learned: string[] = [];
  const { runtime } = setup({ people: [] }, learned);
  for (let i = 0; i < 4; i++) {
    runtime.handle(message(600, `闲聊${i}`));
    await wait(40);
  }
  await wait(400);
  assert.deepEqual(learned, []);
});

/**
 * 只整理触发回复的那一批：先发一条不 @ 的闲聊（不回复、不进学习），
 * 再发一条 @小猫 触发回复。整理提示词只含触发批的内容。
 */
test("only the reply-triggering batch is learned", async () => {
  const learned: string[] = [];
  const { runtime } = setup({ people: [] }, learned);
  runtime.handle(message(500, "闲聊0"));
  await wait(60);
  runtime.handle(message(500, "@小猫 在吗"));
  await waitFor(() => learned.length >= 1);
  assert.equal(learned.length, 1);
  assert.match(learned[0]!, /在吗/);
  assert.doesNotMatch(learned[0]!, /闲聊0/);
});

/**
 * 延迟窗内的多次回复合并为一次整理：两条 @小猫 分别触发回复，
 * 到点只调用一次提取器，且两批内容都在。
 */
test("replies within the delay window merge into one learn", async () => {
  const learned: string[] = [];
  const { runtime, sent } = setup({ people: [] }, learned);
  runtime.handle(message(500, "@小猫 第一次"));
  await wait(60);
  runtime.handle(message(500, "@小猫 第二次"));
  // 等两次回复都发出，再给足一个整理延迟，确认只整理一次。
  await waitFor(() => sent.length >= 2);
  await wait(500);
  assert.equal(learned.length, 1);
  assert.match(learned[0]!, /第一次/);
  assert.match(learned[0]!, /第二次/);
});

/**
 * 端到端白名单：提取器为触发批发言者（7）与未发言者（8）都返回事实，
 * 只有真正发言的 7 被写入，8 不留任何痕迹。
 */
test("only speakers in the reply batch are updated", async () => {
  const learned: string[] = [];
  const { runtime, memory } = setup(
    {
      people: [
        { user_id: 7, facts: ["喜欢猫"] },
        { user_id: 8, facts: ["编的"] },
      ],
    },
    learned,
  );
  runtime.handle(message(500, "@小猫 你好"));
  await waitFor(() => learned.length >= 1);
  assert.equal(learned.length, 1);
  assert.deepEqual(memory.get(7)!.group, ["喜欢猫"]);
  assert.equal(memory.get(8), undefined);
});

/**
 * /停止 清空待整理批：回复已排队待整理后，管理员私聊 /停止，
 * 到点不再整理（假提取器一次都没被调用）。
 */
test("stopping clears the pending learn batch", async () => {
  const learned: string[] = [];
  const { runtime, sent } = setup({ people: [] }, learned, true);
  runtime.handle(message(500, "@小猫 在吗"));
  // 等回复真正发出（此刻待整理批已排队），再 /停止 清空它。
  await waitFor(() => sent.length >= 1);
  runtime.handle(adminMessage("/停止"));
  await wait(500);
  assert.deepEqual(learned, []);
});
