/**
 * power.test.ts —— 管理员电源开关（src/chat/power.ts 的 PowerSwitch +
 * src/chat/runtime.ts 的指令处理）集成测试。
 *
 * 覆盖：管理员私聊 /停止、/启动 的回复文本与状态切换；停止后群聊/私聊消息一律不判断
 * 不回复（但指令本身仍会被处理）；重复指令给出「已是…」提示；状态持久化到 state.json
 * 且新实例 load 后保持；非管理员无法切换；启动后恢复正常判断。
 *
 * 注意：config.ts 在 import 时读取 process.env，必须先设环境变量再动态 import。
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 白名单群 500、无白名单私聊用户、管理员为 42；import 后 config 已定型。
process.env.BOT_NAME = "小猫";
process.env.BOT_GROUPS = "500";
process.env.BOT_PRIVATE_USERS = "";
process.env.BOT_ADMIN_USERS = "42";
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.GATE_GROUP_DEBOUNCE_MS = "10";
process.env.GATE_DIRECT_DEBOUNCE_MS = "10";
process.env.NAPCAT_SEND_INTERVAL_MS = "0";
process.env.LOG_LEVEL = "silent";

// 动态 import：让上面的 env 先于 config.ts 读取（静态 import 会被提升到赋值之前）。
const { ChatRuntime } = await import("../src/chat/runtime.js");
const { PowerSwitch } = await import("../src/chat/power.js");
type Deps = ConstructorParameters<typeof ChatRuntime>[0];

let nextId = 1;
// handle 内部是 fire-and-forget，等待让指令/判断的异步流程跑完。
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// 构造消息事件：type 区分群/私聊（私聊无 group_id）。
const message = (type: "group" | "private", userId: number, text: string) => ({
  post_type: "message" as const,
  message_type: type,
  message_id: nextId++,
  user_id: userId,
  group_id: type === "group" ? 500 : undefined,
  self_id: 100,
  time: Math.floor(Date.now() / 1000),
  message: [{ type: "text", data: { text } }],
  sender: { user_id: userId, nickname: "张三" },
});

// 主流程：fetch 桩固定返回「在」；client 记录发出的消息；decider 统计被判断次数。
// 断言点：
// 1) 管理员 42 私聊 /停止 → power.on=false 且收到停止文案；
// 2) 停止期间群聊/私聊消息都不调用 decider（judged=0）；
// 3) 再次 /停止 → 「已经是停止状态」；
// 4) 用同一 state.json 新建 PowerSwitch 并 load → 状态持久化为 false；
// 5) 非管理员 7 发 /启动 无效（且 7 不在私聊白名单，消息会被直接丢弃），
//    管理员发普通文本也不会误触发；
// 6) 管理员 /启动 → on=true、回复已启动，随后群聊消息恢复正常判断（judged=1）。
test("admin /停止 and /启动 in private chat pause and resume the bot, across restarts", async () => {
  // fetch 桩：拦截 deepseek 请求并固定返回「在」，测试不触网。
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "在" } }] }), { status: 200 })) as typeof fetch;
  const sent: { target: unknown; text: unknown }[] = [];
  let judged = 0;
  const client = {
    selfId: 100,
    sendMessage: async (target: unknown, message: { data: { text?: string } }[]) => {
      sent.push({ target, text: message[0]!.data.text });
      return nextId++;
    },
    sendForward: async () => nextId++,
    callAction: async () => ({ status: "ok" as const, retcode: 0, data: {} }),
  } as unknown as Deps["client"];
  const decider = async () => {
    judged++;
    return { should_reply: 0.9 };
  };
  // 每个测试用独立临时目录里的 state.json，避免相互污染。
  const file = join(await mkdtemp(join(tmpdir(), "qqbot-power-")), "state.json");
  const power = new PowerSwitch(file);
  await power.load();
  const runtime = new ChatRuntime({ client, decider, search: undefined, stickers: undefined, memory: undefined, power });

  runtime.handle(message("private", 42, "/停止"));
  await wait(50);
  assert.equal(power.on, false);
  assert.deepEqual(sent.at(-1), { target: { userId: 42 }, text: "小猫 已停止，群聊和私聊都不再回复，发 /启动 恢复" });

  // 停止后：群聊与私聊消息都不进入 decider 判断，也不产生回复。
  runtime.handle(message("group", 7, "有人吗"));
  runtime.handle(message("private", 42, "在吗"));
  await wait(100);
  assert.equal(judged, 0);

  // 重复停止给出「已经是停止状态」而不是再次切换。
  runtime.handle(message("private", 42, "/停止"));
  await wait(50);
  assert.equal(sent.at(-1)!.text, "小猫 已经是停止状态");

  // 持久化：新实例从同一 state.json 读到关闭状态。
  const reloaded = new PowerSwitch(file);
  await reloaded.load();
  assert.equal(reloaded.on, false);

  // 非管理员 7 的 /启动 无效（7 不在私聊白名单，消息本身就被丢弃）；
  // 管理员的普通文本也不会被当成启动指令。
  runtime.handle(message("private", 7, "/启动"));
  runtime.handle(message("private", 42, "toString"));
  await wait(50);
  assert.equal(power.on, false);

  runtime.handle(message("private", 42, "/启动"));
  await wait(50);
  assert.equal(power.on, true);
  assert.equal(sent.at(-1)!.text, "小猫 已启动");

  // 恢复后群聊消息重新进入判断。
  runtime.handle(message("group", 7, "有人吗"));
  await wait(100);
  assert.equal(judged, 1);
});
