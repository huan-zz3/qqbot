/**
 * schedule.test.ts —— 定时群发（src/schedule/scheduler.ts 的 ScheduledMessenger）单元测试。
 *
 * 直接调用 fire()（脱离 cron 到点），用假 client / 假 power 验证：
 * - 正常：对每个配置群各发一条固定文本；
 * - 开关关闭：不发送；
 * - 单群发送失败：其余群仍继续发送；
 * - cron 非法：构造即抛错（index.ts 据此启动退出）。
 *
 * 注意：logger 经 config 读取 LOG_LEVEL，需先设 env 再动态 import。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.LOG_LEVEL = "silent";

const { ScheduledMessenger } = await import("../src/schedule/scheduler.js");
const { PowerSwitch } = await import("../src/chat/power.js");
type Deps = ConstructorParameters<typeof ScheduledMessenger>[0];

// 假 client：记录每次发送；failGroups 里的群抛错，模拟单群失败。
const makeClient = (failGroups: number[] = []) => {
  const sent: { groupId: number; text: string }[] = [];
  const client = {
    sendMessage: async (target: { groupId: number }, message: { data: { text?: string } }[]) => {
      if (failGroups.includes(target.groupId)) throw new Error("boom");
      sent.push({ groupId: target.groupId, text: message[0]!.data.text! });
      return 1;
    },
  } as unknown as Deps["client"];
  return { client, sent };
};

// 假 power：只用到 on 这个 getter。
const fakePower = (on: boolean) => ({ on }) as PowerSwitch;

// 默认 cron/groups/text，允许用 deps 覆盖。
const make = (deps: Partial<Deps> & Pick<Deps, "client" | "power">) =>
  new ScheduledMessenger({ cron: "0 0 * * *", groups: [111, 222], text: "早上好", ...deps });

test("fire sends the fixed text to every configured group", async () => {
  const { client, sent } = makeClient();
  const messenger = make({ client, power: fakePower(true) });
  await messenger.fire();
  assert.deepEqual(sent, [
    { groupId: 111, text: "早上好" },
    { groupId: 222, text: "早上好" },
  ]);
  messenger.dispose();
});

test("fire skips sending when the power switch is off", async () => {
  const { client, sent } = makeClient();
  const messenger = make({ client, power: fakePower(false) });
  await messenger.fire();
  assert.equal(sent.length, 0);
  messenger.dispose();
});

test("a failing group does not stop the remaining groups", async () => {
  const { client, sent } = makeClient([111]);
  const messenger = make({ client, power: fakePower(true) });
  await messenger.fire();
  assert.deepEqual(sent, [{ groupId: 222, text: "早上好" }]);
  messenger.dispose();
});

test("an invalid cron expression throws at construction", () => {
  const { client } = makeClient();
  assert.throws(() => make({ client, power: fakePower(true), cron: "not a cron" }));
});
