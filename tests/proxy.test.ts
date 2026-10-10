/**
 * proxy.test.ts —— src/proxy.js 的 installProxy() 测试。
 *
 * 覆盖：
 * - 传空字符串 → 不启用（返回 false），全局 dispatcher 保持不变（直连）；
 * - 传代理地址 → 启用（返回 true），全局 dispatcher 被换成 ProxyAgent。
 *
 * installProxy 的入参是 URL 字符串（不读 config），所以无需 env 注入，直接调用。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getGlobalDispatcher, ProxyAgent } from "undici";
import { installProxy } from "../src/proxy.js";

// 先测 no-op：确认空 URL 不会改动全局 dispatcher。
test("empty url is a no-op (keeps the default dispatcher)", () => {
  const before = getGlobalDispatcher();
  assert.equal(installProxy(""), false);
  assert.equal(getGlobalDispatcher(), before);
});

// 再测启用：非空 URL 会把全局 dispatcher 换成 ProxyAgent。
test("non-empty url installs a global ProxyAgent dispatcher", () => {
  assert.equal(installProxy("http://127.0.0.1:7890"), true);
  assert.ok(getGlobalDispatcher() instanceof ProxyAgent);
});
