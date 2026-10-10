/**
 * moderation.test.ts —— 群管理模块（src/moderation/moderation.ts）测试。
 *
 * 覆盖两部分：
 * 1. selectActions()：三个操作（撤回 recall / 禁言 ban / 回复 reply）各自只看自己的
 *    分数与阈值，独立触发、互不影响；
 * 2. Moderation.handle() 的完整流程：命中后执行对应 OneBot 动作并 @ 对方发固定文本，
 *    以及电源开关、群白名单、管理员/群主豁免、jev 失败、1401 权限失效后重查身份、
 *    机器人自身群角色（member/admin）等边界。
 *
 * 注意：config.ts 在 import 时就把 process.env 读进 config 常量（先设置、后动态 import）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// 全部在动态 import 之前设置：import 之后 config 已定型，再改 env 不再生效。
process.env.BOT_NAME = "小猫";
process.env.LOG_LEVEL = "silent";
process.env.MODERATION_ENABLED = "true";
process.env.MODERATION_GROUPS = "500";
process.env.MODERATION_CONTEXT_MESSAGES = "3";
process.env.MODERATION_RECALL_PROMPT = "这条消息是否应该撤回？";
process.env.MODERATION_RECALL_THRESHOLD = "0.85";
process.env.MODERATION_RECALL_TEXT = "已撤回";
process.env.MODERATION_BAN_PROMPT = "这条消息是否应该禁言？";
process.env.MODERATION_BAN_THRESHOLD = "0.9";
process.env.MODERATION_BAN_TEXT = "已禁言";
process.env.MODERATION_BAN_SECONDS = "600";
process.env.MODERATION_REPLY_PROMPT = "这条消息是否需要提醒？";
process.env.MODERATION_REPLY_THRESHOLD = "0.8";
process.env.MODERATION_REPLY_TEXT = "请注意言辞";

// 动态 import：config.ts 在此刻读取上面设置好的 env；静态 import 会被提升到赋值之前。
const { Moderation, selectActions } = await import("../src/moderation/moderation.js");

// selectActions 的输入：三项操作定义，阈值与 env 配置一致（prompt 非空才参与判断）。
const OPS = [
  { name: "recall", prompt: "r", threshold: 0.85, text: "撤回" },
  { name: "ban", prompt: "b", threshold: 0.9, text: "禁言" },
  { name: "reply", prompt: "x", threshold: 0.8, text: "回复" },
];

// Moderation.handle 内部是 fire-and-forget（void this.process），测试用等待让异步流程跑完。
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// 全局递增的消息 ID：保证每条测试消息的 message_id 唯一，便于断言撤回的是哪条。
let nextId = 1;

// 构造一条 OneBot 群消息事件：默认发送者 7、群 500（测试里都是白名单/启用值）。
// role 用于模拟发送者的群身份（admin/owner 会被豁免），groupId 用于测试白名单边界。
function groupMessage(text: string, options: { role?: string; groupId?: number } = {}) {
  const userId = 7;
  return {
    post_type: "message" as const,
    message_type: "group" as const,
    message_id: nextId++,
    user_id: userId,
    group_id: options.groupId ?? 500,
    self_id: 100,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: "text", data: { text } }],
    sender: { user_id: userId, nickname: "张三", role: options.role },
  };
}

// 组装被测 Moderation 所需的假 client，并暴露记录供断言：
// - actions 记录所有 callAction 调用（撤回/禁言/查身份）；
// - sent 记录 sendMessage 发出的固定文本；
// - get_group_member_info 返回机器人自己的群角色（默认 admin，可传 role 改为 member）；
// - setBanFails 控制 set_group_ban 是否抛 1401（权限不足）错误。
function setup(options: { role?: string } = {}) {
  const role = options.role ?? "admin";
  const actions: { action: string; params: Record<string, unknown> }[] = [];
  const sent: { target: unknown; message: unknown[] }[] = [];
  let banFails = false;
  const callAction = async (action: string, params: Record<string, unknown> = {}) => {
    actions.push({ action, params });
    if (action === "get_group_member_info") return { status: "ok" as const, retcode: 0, data: { role } };
    if (action === "set_group_ban" && banFails) {
      throw Object.assign(new Error("action set_group_ban 失败: retcode=1401"), { retcode: 1401 });
    }
    return { status: "ok" as const, retcode: 0, data: {} };
  };
  const client = {
    selfId: 100,
    sendMessage: async (target: unknown, message: unknown[]) => {
      sent.push({ target, message });
      return nextId++;
    },
    callAction,
    deleteMsg: (messageId: number) => callAction("delete_msg", { message_id: messageId }),
    setGroupBan: (groupId: number, userId: number, duration: number) =>
      callAction("set_group_ban", { group_id: groupId, user_id: userId, duration }),
  };
  return { client, actions, sent, setBanFails: (value: boolean) => (banFails = value) };
}

// 最小依赖对象：power.on 模拟 /启动 /停止 开关，judge 模拟 jev 打分函数。
const deps = (client: unknown, judge: unknown, on = true) => ({ client, judge, power: { on } });
// 固定回复的消息段为 [at 对方, 空格文本, 固定文本]，故固定文本在第 3 个（下标 2）段。
const replyText = (message: unknown[]) => (message as { data: { text?: string } }[])[2]!.data.text;

// 纯函数测试：每项只比自己的分数与阈值，达标即入选、互不干扰；
// 边界：全不达标返回空数组；一条消息可同时命中多项。
test("selectActions fires every op over its own threshold, independently", () => {
  const names = (scores: Record<string, number>) => selectActions(scores, OPS).map((op) => op.name);
  assert.deepEqual(names({ recall: 0.9, ban: 0.95, reply: 0.9 }), ["recall", "ban", "reply"]);
  assert.deepEqual(names({ recall: 0.1, ban: 0.95, reply: 0.9 }), ["ban", "reply"]);
  assert.deepEqual(names({ recall: 0.9, ban: 0.1, reply: 0.1 }), ["recall"]);
  assert.deepEqual(names({ recall: 0.1, ban: 0.1, reply: 0.9 }), ["reply"]);
  assert.deepEqual(names({ recall: 0.1, ban: 0.1, reply: 0.1 }), []);
});

// 一次判断三方全部达标：撤回、禁言各执行一次动作，并按 recall → ban → reply 的顺序
// 各发一条自己的固定文本（顺序由源码里操作定义的顺序决定）。
test("multiple ops fire independently and each sends its own reply", async () => {
  const { client, actions, sent } = setup();
  const judge = async () => ({ recall: 0.9, ban: 0.95, reply: 0.9 });
  const moderation = new Moderation(deps(client, judge));
  moderation.handle(groupMessage("广告消息"));
  await wait(100);
  assert.equal(actions.filter((item) => item.action === "delete_msg").length, 1);
  assert.equal(actions.filter((item) => item.action === "set_group_ban").length, 1);
  assert.deepEqual(
    sent.map((item) => replyText(item.message)),
    ["已撤回", "已禁言", "请注意言辞"],
  );
});

// 边界：只有撤回达标（0.9 ≥ 0.85），禁言/回复分数低于阈值不触发。
// 期望：delete_msg 撤回的正是触发消息；随后 @ 发送者（qq=7）发固定文本「已撤回」。
test("recall: message deleted then sender mentioned", async () => {
  const { client, actions, sent } = setup();
  const judge = async () => ({ recall: 0.9, ban: 0.1, reply: 0.1 });
  const moderation = new Moderation(deps(client, judge));
  const msg = groupMessage("广告消息");
  moderation.handle(msg);
  await wait(50);
  assert.equal(actions.find((item) => item.action === "delete_msg")?.params.message_id, msg.message_id);
  assert.deepEqual(sent[0]!.target, { groupId: 500 });
  assert.deepEqual(sent[0]!.message, [
    { type: "at", data: { qq: "7" } },
    { type: "text", data: { text: " " } },
    { type: "text", data: { text: "已撤回" } },
  ]);
});

// 只有禁言达标：期望 set_group_ban 的参数为群 500 / 用户 7 / 时长 600 秒
// （600 来自 MODERATION_BAN_SECONDS），随后发固定文本「已禁言」。
test("ban: set_group_ban with the configured seconds then sender mentioned", async () => {
  const { client, actions, sent } = setup();
  const judge = async () => ({ recall: 0.1, ban: 0.95, reply: 0.1 });
  const moderation = new Moderation(deps(client, judge));
  moderation.handle(groupMessage("广告消息"));
  await wait(50);
  assert.deepEqual(actions.find((item) => item.action === "set_group_ban")?.params, {
    group_id: 500,
    user_id: 7,
    duration: 600,
  });
  assert.equal(replyText(sent[0]!.message), "已禁言");
});

// 只有回复达标：不得产生任何撤回或禁言动作，只 @ 发送者发固定文本「请注意言辞」。
test("reply: only the fixed reply is sent", async () => {
  const { client, actions, sent } = setup();
  const judge = async () => ({ recall: 0.1, ban: 0.1, reply: 0.9 });
  const moderation = new Moderation(deps(client, judge));
  moderation.handle(groupMessage("提醒一下"));
  await wait(50);
  assert.equal(actions.filter((item) => item.action === "delete_msg").length, 0);
  assert.equal(actions.filter((item) => item.action === "set_group_ban").length, 0);
  assert.equal(replyText(sent[0]!.message), "请注意言辞");
});

// 边界：电源开关关闭（模拟管理员 /停止）时，即使分数全高、群也在白名单内也一律不动。
test("power off: nothing happens", async () => {
  const { client, actions, sent } = setup();
  const judge = async () => ({ recall: 0.9 });
  const moderation = new Moderation(deps(client, judge, false));
  moderation.handle(groupMessage("广告消息"));
  await wait(50);
  assert.equal(actions.length, 0);
  assert.equal(sent.length, 0);
});

// 边界：消息来自未列入 MODERATION_GROUPS 的群（999）时，连 jev 都不会调用。
test("groups outside the list are ignored", async () => {
  const { client, actions, sent } = setup();
  let judged = 0;
  const judge = async () => {
    judged++;
    return { recall: 0.9 };
  };
  const moderation = new Moderation(deps(client, judge));
  moderation.handle(groupMessage("广告消息", { groupId: 999 }));
  await wait(50);
  assert.equal(judged, 0);
  assert.equal(actions.length, 0);
  assert.equal(sent.length, 0);
});

// 边界：发送者本身是群管理员/群主时豁免——不交给 jev 判断，也不产生任何动作
// （owner 与 admin 同路处理，这里用 admin 覆盖）。
test("admin/owner senders are not judged", async () => {
  const { client, actions, sent } = setup();
  let judged = 0;
  const judge = async () => {
    judged++;
    return { recall: 0.9 };
  };
  const moderation = new Moderation(deps(client, judge));
  moderation.handle(groupMessage("广告消息", { role: "admin" }));
  await wait(50);
  assert.equal(judged, 0);
  assert.equal(actions.length, 0);
  assert.equal(sent.length, 0);
});

// 边界：jev 抛错时整个流程静默放弃——无撤回、无固定文本，也不向外抛异常。
test("a jev failure takes no action and does not crash", async () => {
  const { client, actions, sent } = setup();
  const judge = async () => {
    throw new Error("boom");
  };
  const moderation = new Moderation(deps(client, judge));
  moderation.handle(groupMessage("广告消息"));
  await wait(50);
  assert.equal(actions.filter((item) => item.action === "delete_msg").length, 0);
  assert.equal(sent.length, 0);
});

// 边界：禁言动作因权限（retcode 1401）失败——不谎报已处理、不发固定文本；
// 同时丢弃缓存的机器人角色，使下一条消息重新调 get_group_member_info 确认身份。
test("a 1401 ban failure sends no reply and forces a role recheck", async () => {
  const { client, actions, sent, setBanFails } = setup();
  const judge = async () => ({ recall: 0.1, ban: 0.95, reply: 0.1 });
  const moderation = new Moderation(deps(client, judge));
  const roleCalls = () => actions.filter((item) => item.action === "get_group_member_info").length;

  setBanFails(true);
  moderation.handle(groupMessage("广告消息"));
  await wait(50);
  assert.equal(sent.length, 0);
  // 第一条消息只查了一次身份
  assert.equal(roleCalls(), 1);

  moderation.handle(groupMessage("又来了"));
  await wait(50);
  assert.equal(sent.length, 0);
  // 1401 后缓存被清，第二条消息重新查一次身份
  assert.equal(roleCalls(), 2);
});

// 边界：机器人自身在群里的角色决定群管理是否生效——
// member（非管理员）时静默跳过；admin 时正常撤回并回复。
test("bot role gates moderation: member does nothing, admin proceeds", async () => {
  const judge = async () => ({ recall: 0.9, ban: 0.1, reply: 0.1 });

  const member = setup({ role: "member" });
  const memberModeration = new Moderation(deps(member.client, judge));
  memberModeration.handle(groupMessage("广告消息"));
  await wait(50);
  assert.equal(member.sent.length, 0);
  assert.equal(member.actions.filter((item) => item.action === "delete_msg").length, 0);

  const admin = setup({ role: "admin" });
  const adminModeration = new Moderation(deps(admin.client, judge));
  adminModeration.handle(groupMessage("广告消息"));
  await wait(50);
  assert.equal(admin.sent.length, 1);
  assert.equal(admin.actions.filter((item) => item.action === "delete_msg").length, 1);
});

// handoff：命中任一操作即用该消息的 message_id 标记，供聊天运行时跳过对应批次的 AI 回复。
test("a triggered op marks the message id via handoff", async () => {
  const marked: number[] = [];
  const handoff = { mark: (id: number) => marked.push(id), handled: () => false };
  const { client } = setup();
  const judge = async () => ({ recall: 0.9, ban: 0.1, reply: 0.1 });
  const moderation = new Moderation({ ...deps(client, judge), handoff });
  const msg = groupMessage("广告消息");
  moderation.handle(msg);
  await wait(50);
  assert.deepEqual(marked, [msg.message_id]);
});

// handoff：三项都没命中（分数全低于阈值）时不标记，聊天照常走 AI 回复。
test("no triggered op leaves the message unmarked", async () => {
  const marked: number[] = [];
  const handoff = { mark: (id: number) => marked.push(id), handled: () => false };
  const { client } = setup();
  const judge = async () => ({ recall: 0.1, ban: 0.1, reply: 0.1 });
  const moderation = new Moderation({ ...deps(client, judge), handoff });
  moderation.handle(groupMessage("普通消息"));
  await wait(50);
  assert.deepEqual(marked, []);
});

// handoff：电源开关关闭时不判断也不标记。
test("power off does not mark the message", async () => {
  const marked: number[] = [];
  const handoff = { mark: (id: number) => marked.push(id), handled: () => false };
  const { client } = setup();
  const judge = async () => ({ recall: 0.9 });
  const moderation = new Moderation({ ...deps(client, judge, false), handoff });
  moderation.handle(groupMessage("广告消息"));
  await wait(50);
  assert.deepEqual(marked, []);
});
