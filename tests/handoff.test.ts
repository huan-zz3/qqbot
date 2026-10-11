/**
 * handoff.test.ts —— 群管理 → 聊天运行时信号（src/moderation/handoff.ts）单元测试。
 *
 * 覆盖 mark/handled 基本行为与 TTL 过期；handoff.ts 不读 config，无需先设 env。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ModerationHandoff } from "../src/moderation/handoff.js";

// 标记后 handled 命中该 id，其他 id 不受影响。
test("mark then handled reflects the recorded message", () => {
  const handoff = new ModerationHandoff();
  assert.equal(handoff.handled(1), false);
  handoff.mark(1);
  assert.equal(handoff.handled(1), true);
  assert.equal(handoff.handled(2), false);
});

// 超过 TTL 的记录自动失效：TTL 内仍命中，越界即视为未处理。
test("entries expire after the TTL", () => {
  const handoff = new ModerationHandoff();
  handoff.mark(1, 1000);
  assert.equal(handoff.handled(1, 1000 + 59_000), true);
  assert.equal(handoff.handled(1, 1000 + 60_001), false);
});

// 等待会一直挂起，直到 begin 过的消息 settle 后才返回。
test("wait resolves once every begun judgement settles", async () => {
  const handoff = new ModerationHandoff();
  handoff.begin(1);
  handoff.begin(2);
  let done = false;
  const waiting = handoff.wait([1, 2]).then((ok) => {
    done = ok;
  });
  // 只 settle 一个，仍应挂起。
  handoff.settle(1);
  await Promise.resolve();
  assert.equal(done, false);
  handoff.settle(2);
  await waiting;
  assert.equal(done, true);
});

// 没有在判定的消息（未 begin）不产生等待，立即返回 true。
test("wait returns immediately when nothing is being judged", async () => {
  const handoff = new ModerationHandoff();
  assert.equal(await handoff.wait([7, 8]), true);
  // settle 未 begin 的 id 无副作用。
  handoff.settle(7);
  assert.equal(await handoff.wait([7]), true);
});

// 判定迟迟不结束时不无限等待：超时返回 false（调用方据此记日志放行）。
test("wait gives up after the timeout", async () => {
  const handoff = new ModerationHandoff();
  handoff.begin(1);
  assert.equal(await handoff.wait([1], 20), false);
});
