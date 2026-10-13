/**
 * context.test.ts —— 上下文窗口拆分（模型窗口 vs decider 窗口）的集成测试。
 *
 * 用很小的窗口（共享/逐账号各 2 条）驱动真实 ChatRuntime：
 * 让某发言者较早的消息落在共享窗口之外，验证
 *   - 模型窗口（transcript）因「逐发言账号保证」带上了它；
 *   - decider 窗口（earlier_messages）同样因逐账号保证带上了它。
 *
 * 注意：config.ts 在 import 时读取 process.env，必须先设置环境变量再动态 import。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.BOT_NAME = "小猫";
process.env.BOT_GROUPS = "600";
process.env.DEEPSEEK_API_KEY = "test-key";
// 防抖调短，让每个批次尽快跑完。
process.env.GATE_GROUP_DEBOUNCE_MS = "30";
process.env.NAPCAT_SEND_INTERVAL_MS = "0";
process.env.LOG_LEVEL = "silent";
// 关键：共享窗口都设为 2、逐账号保证设为 2，便于制造「共享窗口外」的发言人旧消息。
process.env.HISTORY_CONTEXT_MESSAGES = "2";
process.env.HISTORY_USER_CONTEXT_MESSAGES = "2";
process.env.DECIDER_CONTEXT_MESSAGES = "2";
process.env.DECIDER_USER_CONTEXT_MESSAGES = "2";

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

test("both windows include a speaker's older messages via per-speaker guarantee", async () => {
  // decider 捕获每个批次的 state；只有含 a3 的那批让模型回复。
  const states: { earlier_messages: { text: string }[]; new_messages: { text: string }[] }[] = [];
  const decider: Deps["decider"] = async (state) => {
    const snapshot = state as unknown as { earlier_messages: { text: string }[]; new_messages: { text: string }[] };
    states.push(snapshot);
    return { should_reply: snapshot.new_messages.some((m) => m.text.includes("a3")) ? 0.9 : 0.1, addressed: 0 };
  };

  const prompts: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    prompts.push(body.messages.at(-1).content);
    return new Response(JSON.stringify({ choices: [{ message: { content: "好" } }] }), { status: 200 });
  }) as typeof fetch;

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

  // 恰好三次判定（三批）。
  assert.equal(states.length, 3);
  // 模型窗口（只回复过一次，故只有一条 transcript）：带上了 a2。
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /a2/);
  // decider 窗口：earlier_messages 含共享的 2 条（b1、b2），并因逐账号保证带上了 a2。
  const earlier = states[2]!.earlier_messages.map((m) => m.text);
  assert.deepEqual(earlier, ["a2", "b1", "b2"]);
});
