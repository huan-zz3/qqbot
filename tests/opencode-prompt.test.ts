/**
 * opencode-prompt.test.ts —— src/opencode/prompt.js 的 composePrompt() 测试。
 *
 * 覆盖（对应「用户自定义文本拼进送进 acp 的 prompt，空段不得产生多余空行」这个隐患）：
 * - 无前置/后置时结果等于正文本身（向后兼容，不看是否配置）；
 * - 只有前置 / 只有后置时的拼接；
 * - 前置 + 正文 + 后置的顺序与空行分隔；
 * - 空白段整段消失，不产生多余空行；
 * - 全空返回空串。
 *
 * 纯函数，不依赖 ACP SDK。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { composePrompt } = await import("../src/opencode/prompt.js");

test("no prefix/suffix yields the body unchanged", () => {
  assert.equal(composePrompt("", "任务正文", ""), "任务正文");
});

test("prefix-only and suffix-only", () => {
  assert.equal(composePrompt("先用中文", "任务正文", ""), "先用中文\n\n任务正文");
  assert.equal(composePrompt("", "任务正文", "回答尽量简短"), "任务正文\n\n回答尽量简短");
});

test("prefix + body + suffix in order, separated by a blank line", () => {
  assert.equal(
    composePrompt("前置", "任务正文", "后置"),
    "前置\n\n任务正文\n\n后置",
  );
});

test("whitespace-only segments disappear without extra blank lines", () => {
  assert.equal(composePrompt("   ", "任务正文", "\n\t"), "任务正文");
  assert.equal(composePrompt("前置", "任务正文", "   "), "前置\n\n任务正文");
});

test("all-empty yields an empty string", () => {
  assert.equal(composePrompt("", "  ", "\n"), "");
});
