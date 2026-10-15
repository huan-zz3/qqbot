/**
 * gate-reply-prompt-default.test.ts —— 未配置回复提示词时 should_reply 的透传契约。
 *
 * buildQuestions 已不含任何内置文案：should_reply 的正文 / true / false 完全等于
 * GATE_REPLY_QUESTION_PROMPT / _TRUE_PROMPT / _FALSE_PROMPT，未配置即空字符串。
 * 「非空」由 index.ts 在 decider 可用时启动校验保证，不在 buildQuestions 层兜底。
 *
 * config.ts 在 import 时读环境变量，且 ESM 模块缓存使其无法在同一进程内重新配置；
 * 因此「未配置」这条路径单独开一个文件：本文件不设任何 GATE_REPLY_* 变量。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// 不设 GATE_REPLY_QUESTION_PROMPT / _TRUE_PROMPT / _FALSE_PROMPT。
const { buildQuestions } = await import("../src/chat/gate.js");

test("no reply prompts: should_reply slots are empty strings", () => {
  const should = (buildQuestions("小猫") as any).should_reply;
  assert.equal(should.instructions, "");
  assert.equal(should.criteria.true, "");
  assert.equal(should.criteria.false, "");
});
