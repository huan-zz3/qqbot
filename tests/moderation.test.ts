import assert from "node:assert/strict";
import { test } from "node:test";

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

const { Moderation, selectActions } = await import("../src/moderation/moderation.js");

const OPS = [
  { name: "recall", prompt: "r", threshold: 0.85, text: "撤回" },
  { name: "ban", prompt: "b", threshold: 0.9, text: "禁言" },
  { name: "reply", prompt: "x", threshold: 0.8, text: "回复" },
];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let nextId = 1;

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

const deps = (client: unknown, judge: unknown, on = true) => ({ client, judge, power: { on } });
const replyText = (message: unknown[]) => (message as { data: { text?: string } }[])[2]!.data.text;

test("selectActions fires every op over its own threshold, independently", () => {
  const names = (scores: Record<string, number>) => selectActions(scores, OPS).map((op) => op.name);
  assert.deepEqual(names({ recall: 0.9, ban: 0.95, reply: 0.9 }), ["recall", "ban", "reply"]);
  assert.deepEqual(names({ recall: 0.1, ban: 0.95, reply: 0.9 }), ["ban", "reply"]);
  assert.deepEqual(names({ recall: 0.9, ban: 0.1, reply: 0.1 }), ["recall"]);
  assert.deepEqual(names({ recall: 0.1, ban: 0.1, reply: 0.9 }), ["reply"]);
  assert.deepEqual(names({ recall: 0.1, ban: 0.1, reply: 0.1 }), []);
});

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

test("power off: nothing happens", async () => {
  const { client, actions, sent } = setup();
  const judge = async () => ({ recall: 0.9 });
  const moderation = new Moderation(deps(client, judge, false));
  moderation.handle(groupMessage("广告消息"));
  await wait(50);
  assert.equal(actions.length, 0);
  assert.equal(sent.length, 0);
});

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

test("a 1401 ban failure sends no reply and forces a role recheck", async () => {
  const { client, actions, sent, setBanFails } = setup();
  const judge = async () => ({ recall: 0.1, ban: 0.95, reply: 0.1 });
  const moderation = new Moderation(deps(client, judge));
  const roleCalls = () => actions.filter((item) => item.action === "get_group_member_info").length;

  setBanFails(true);
  moderation.handle(groupMessage("广告消息"));
  await wait(50);
  assert.equal(sent.length, 0);
  assert.equal(roleCalls(), 1);

  moderation.handle(groupMessage("又来了"));
  await wait(50);
  assert.equal(sent.length, 0);
  assert.equal(roleCalls(), 2);
});

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
