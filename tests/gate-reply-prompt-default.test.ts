/**
 * gate-reply-prompt-default.test.ts —— 未配置回复提示词时 should_reply 文案保持原样。
 *
 * config.ts 在 import 时读环境变量，且 ESM 模块缓存使其无法在同一进程内重新配置；
 * 因此「未配置」这条默认路径单独开一个文件：本文件不设任何 GATE_REPLY_* 变量，
 * 断言三个追加位都为空、文案与内置逐字一致，守住「不配置 = 零变化」。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// 不设 GATE_REPLY_QUESTION_PROMPT / _TRUE_PROMPT / _FALSE_PROMPT。
const { buildQuestions } = await import("../src/chat/gate.js");

test("no reply prompts: should_reply keeps the built-in text", () => {
  const should = (buildQuestions("小猫") as any).should_reply;
  assert.equal(
    should.instructions,
    "Should 小猫, a member of this QQ chat, send a message now in response to new_messages?",
  );
  assert.equal(
    should.criteria.true,
    "new_messages call for a response from 小猫, or 小猫 has something worth adding. Being @mentioned or replied to (at_bot, replies_to_bot) makes this more likely.",
  );
  assert.equal(
    should.criteria.false,
    "new_messages do not need anything from 小猫: the exchange is between others, it is winding down, or a message from 小猫 would add nothing.",
  );
});
