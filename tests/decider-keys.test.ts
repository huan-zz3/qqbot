/**
 * decider-keys.test.ts —— decider 多密钥纯逻辑（src/decider/keys.js）测试。
 *
 * 覆盖：去重保序、移动到队首的提升语义、脱敏不泄露明文。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { maskKey, promote, uniqueKeys } = await import("../src/decider/keys.js");

test("uniqueKeys drops blanks and duplicates, keeps first-seen order", () => {
  assert.deepEqual(uniqueKeys([" a ", "b", "a", "", "  ", "c", "b"]), ["a", "b", "c"]);
  assert.deepEqual(uniqueKeys([]), []);
});

test("promote moves the used key to front, others keep relative order", () => {
  assert.deepEqual(promote(["a", "b", "c"], "c"), ["c", "a", "b"]);
  assert.deepEqual(promote(["a", "b", "c"], "a"), ["a", "b", "c"]);
  // 不在列表中的密钥：原样返回副本，不做改动。
  assert.deepEqual(promote(["a", "b"], "x"), ["a", "b"]);
});

test("promote does not mutate its input", () => {
  const keys = ["a", "b", "c"];
  promote(keys, "c");
  assert.deepEqual(keys, ["a", "b", "c"]);
});

test("maskKey keeps only the last 4 chars and never leaks the full key", () => {
  const masked = maskKey("super-secret-key-abcd");
  assert.equal(masked, "***abcd");
  assert.ok(!masked.includes("secret"));
});
