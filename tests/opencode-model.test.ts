/**
 * opencode-model.test.ts —— src/opencode/model.js 的 resolveModelValue() 测试。
 *
 * 覆盖（对应「opencode acp 不指定模型 → 用了又贵又不受控的默认模型」这个隐患）：
 * - 留空 → 返回 undefined（沿用 opencode 默认），不校验；
 * - 命中 id/category 为 model 的配置项且值在可选列表内 → 返回该值；
 * - 选项分组（options 里还是 options）时能摊平；
 * - 值不在可选列表内 → 抛错（大小写/模型名写错要被发现，不静默回退）；
 * - 会话根本没有 model 配置项却配了模型 → 抛错；
 * - 没有可选项列表时不校验，原样返回。
 *
 * 纯函数，不依赖 ACP SDK。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { resolveModelValue } = await import("../src/opencode/model.js");

const option = (over: object) => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "opencode-go/claude-haiku-5-5",
  options: [
    { value: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { value: "deepseek/deepseek-flash", name: "DeepSeek V4.1 Flash" },
  ],
  ...over,
});

test("empty desired means: keep opencode default", () => {
  assert.equal(resolveModelValue([option({})], ""), undefined);
  assert.equal(resolveModelValue([option({})], "   "), undefined);
});

test("returns the model value when it is among the options", () => {
  assert.equal(resolveModelValue([option({})], "deepseek/deepseek-flash"), "deepseek/deepseek-flash");
});

test("finds the option by category when the id differs", () => {
  const byCategory = option({ id: "some-id" });
  assert.equal(resolveModelValue([byCategory], "deepseek/deepseek-flash"), "deepseek/deepseek-flash");
});

test("flattens grouped select options", () => {
  const grouped = option({
    options: [
      { options: [{ value: "deepseek/deepseek-flash" }, { value: "deepseek/deepseek-v4-pro" }] },
    ],
  });
  assert.equal(resolveModelValue([grouped], "deepseek/deepseek-flash"), "deepseek/deepseek-flash");
});

test("throws when the value is not selectable (e.g. wrong provider case)", () => {
  assert.throws(
    () => resolveModelValue([option({})], "DeepSeek/deepseek-v4-pro"),
    /不在可选模型内/,
  );
});

test("throws when the session exposes no model option", () => {
  assert.throws(() => resolveModelValue([], "deepseek/deepseek-flash"), /没有提供 model 配置项/);
});

test("does not validate when the option has no selectable list", () => {
  const noList = option({ options: null });
  assert.equal(resolveModelValue([noList], "anything/goes"), "anything/goes");
});
