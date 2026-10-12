/**
 * welcome.test.ts —— 入群欢迎模块（src/welcome/welcome.ts）测试。
 *
 * 覆盖 handle() 的运行期分支：白名单群 + 普通成员入群时 @ 其发固定文本；群不在白名单、
 * 电源开关关闭、入群者为机器人自己时均不发送；发送失败不抛出、不影响后续。
 *
 * 注意：config.ts 在 import 时就把 process.env 读进 config 常量（先设置、后动态 import）。
 * 因启用开关/文本也是 import 期定型，本文件只测运行期可变的分支（启用路径）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// 全部在动态 import 之前设置：import 之后 config 已定型，再改 env 不再生效。
process.env.BOT_NAME = "小猫";
process.env.LOG_LEVEL = "silent";
process.env.WELCOME_ENABLED = "true";
process.env.WELCOME_GROUPS = "500";
process.env.WELCOME_TEXT = "欢迎入群";

// 动态 import：config.ts 在此刻读取上面设置好的 env；静态 import 会被提升到赋值之前。
const { Welcome } = await import("../src/welcome/welcome.js");

// handle 内部是 fire-and-forget（void this.send），测试用等待让异步流程跑完。
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 构造一条 OneBot 入群通知事件：默认新成员 7、群 500（测试里的白名单/启用值）。
function groupIncrease(options: { groupId?: number; userId?: number; selfId?: number } = {}) {
  return {
    post_type: "notice" as const,
    notice_type: "group_increase" as const,
    sub_type: "approve",
    group_id: options.groupId ?? 500,
    user_id: options.userId ?? 7,
    operator_id: 1,
    self_id: options.selfId ?? 100,
    time: Math.floor(Date.now() / 1000),
  };
}

// 组装被测 Welcome 所需的假 client，并暴露记录供断言：
// - sent 记录 sendMessage 发出的目标与消息段；
// - sendFails 控制 sendMessage 是否抛错。
function setup() {
  const sent: { target: unknown; message: unknown[] }[] = [];
  let failSend = false;
  const client = {
    selfId: 100,
    sendMessage: async (target: unknown, message: unknown[]) => {
      if (failSend) throw new Error("send failed");
      sent.push({ target, message });
      return 1;
    },
  };
  return { client, sent, setSendFails: (value: boolean) => (failSend = value) };
}

// 最小依赖对象：power.on 模拟 /启动 /停止 开关。
const deps = (client: unknown, on = true) => ({ client, power: { on } });

// 正常路径：白名单群、普通成员入群 → @ 新成员（qq=7）+ 空格 + 固定文本，目标是该群。
test("a new member in a listed group is mentioned with the fixed text", async () => {
  const { client, sent } = setup();
  new Welcome(deps(client)).handle(groupIncrease());
  await wait(50);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.target, { groupId: 500 });
  assert.deepEqual(sent[0]!.message, [
    { type: "at", data: { qq: "7" } },
    { type: "text", data: { text: " " } },
    { type: "text", data: { text: "欢迎入群" } },
  ]);
});

// 边界：群不在 WELCOME_GROUPS 内时不发送。
test("groups outside the list are ignored", async () => {
  const { client, sent } = setup();
  new Welcome(deps(client)).handle(groupIncrease({ groupId: 999 }));
  await wait(50);
  assert.equal(sent.length, 0);
});

// 边界：电源开关关闭（模拟管理员 /停止）时即使群在白名单内也不发送。
test("power off: nothing is sent", async () => {
  const { client, sent } = setup();
  new Welcome(deps(client, false)).handle(groupIncrease());
  await wait(50);
  assert.equal(sent.length, 0);
});

// 边界：入群者就是机器人自己（被拉进群）时不 @ 自己、不发送。
test("the bot joining by itself is not welcomed", async () => {
  const { client, sent } = setup();
  new Welcome(deps(client)).handle(groupIncrease({ userId: 100 }));
  await wait(50);
  assert.equal(sent.length, 0);
});

// 边界：发送失败只记 warn、不抛出，且不影响后续事件。
test("a send failure does not crash and later events still work", async () => {
  const { client, sent, setSendFails } = setup();
  const welcome = new Welcome(deps(client));
  setSendFails(true);
  welcome.handle(groupIncrease());
  await wait(50);
  assert.equal(sent.length, 0);
  // 恢复后下一条事件照常发送。
  setSendFails(false);
  welcome.handle(groupIncrease({ userId: 8 }));
  await wait(50);
  assert.equal(sent.length, 1);
});
