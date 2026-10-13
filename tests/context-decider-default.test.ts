/**
 * context-decider-default.test.ts —— 未配置 DECIDER_USER_CONTEXT_MESSAGES 时 decider 窗口保持原样。
 *
 * config.ts 在 import 时读环境变量，且 ESM 模块缓存使其无法在同一进程内重新配置；
 * 因此「默认 0 = 与拆分前逐条一致」这条路径单独开一个文件：本文件不设
 * DECIDER_USER_CONTEXT_MESSAGES，断言 decider 的 earlier_messages 只看共享窗口、
 * 不带本批发言者落在共享窗口外的旧消息（守住「不配置 = 零变化」）。
 *
 * 注意：config.ts 在 import 时读取 process.env，必须先设置环境变量再动态 import。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.BOT_NAME = "小猫";
process.env.BOT_GROUPS = "600";
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.GATE_GROUP_DEBOUNCE_MS = "30";
process.env.NAPCAT_SEND_INTERVAL_MS = "0";
process.env.LOG_LEVEL = "silent";
// 共享窗口设为 2；不设 DECIDER_USER_CONTEXT_MESSAGES（默认 0）。
process.env.HISTORY_CONTEXT_MESSAGES = "2";
process.env.HISTORY_USER_CONTEXT_MESSAGES = "2";
process.env.DECIDER_CONTEXT_MESSAGES = "2";

const { ChatRuntime } = await import("../src/chat/runtime.js");
type Deps = ConstructorParameters<typeof ChatRuntime>[0];

const SELF = 100;
let nextId = 1;

// 群 600 里的一条消息；默认发送者 7。
function message(userId: number, text: string) {
  return {
    post_type: "message" as const,
    message_type: "group" as const,
    message_id: nextId++,
    user_id: userId,
    group_id: 600,
    self_id: SELF,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: "text", data: { text } }],
    sender: { user_id: userId, nickname: String(userId), card: "" },
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("without DECIDER_USER_CONTEXT_MESSAGES the decider window excludes a speaker's older messages", async () => {
  const states: { earlier_messages: { text: string }[]; new_messages: { text: string }[] }[] = [];
  // 一律判定不回复：本用例只关心 decider 窗口内容，不触发模型生成。
  const decider: Deps["decider"] = async (state) => {
    states.push(state as unknown as (typeof states)[number]);
    return { should_reply: 0.1, addressed: 0 };
  };

  const client = {
    selfId: SELF,
    sendMessage: async () => nextId++,
    sendForward: async () => nextId++,
    callAction: async () => ({ status: "ok" as const, retcode: 0, data: { group_name: "测试群" } }),
  } as unknown as Deps["client"];

  const runtime = new ChatRuntime({ client, decider, stickers: undefined, memory: undefined });

  // 三批：A(a1,a2) → B(b1,b2) → A(a3)+B(b3)。后两批把 a1、a2 挤出共享窗口。
  runtime.handle(message(7, "a1"));
  runtime.handle(message(7, "a2"));
  await wait(100);
  runtime.handle(message(8, "b1"));
  runtime.handle(message(8, "b2"));
  await wait(100);
  runtime.handle(message(7, "a3"));
  runtime.handle(message(8, "b3"));
  await wait(200);

  assert.equal(states.length, 3);
  // decider 窗口只看共享的 2 条（b1、b2），不含 a2。
  const earlier = states[2]!.earlier_messages.map((m) => m.text);
  assert.deepEqual(earlier, ["b1", "b2"]);
});
