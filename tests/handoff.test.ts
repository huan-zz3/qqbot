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
