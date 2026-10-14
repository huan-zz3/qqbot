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
import { installProxy, mergeNoProxy, proxyEnv } from "../src/proxy.js";

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

// 代理地址非空：注入 http/https/all_proxy（大小写都写）。
test("proxyEnv injects http/https/all proxy (both cases) when a proxy is set", () => {
  const env = proxyEnv("http://127.0.0.1:7890");
  for (const key of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
    assert.equal(env[key], "http://127.0.0.1:7890", `${key} should be the proxy url`);
  }
});

// 代理地址留空：不注入任何代理变量（维持直连），但本机排除仍在。
test("proxyEnv adds no proxy variables when the proxy url is empty", () => {
  const env = proxyEnv("");
  for (const key of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
    assert.equal(env[key], undefined, `${key} should not be set`);
  }
  const hosts = String(env.no_proxy).split(",").map((item) => item.trim());
  for (const host of ["127.0.0.1", "localhost", "::1"]) assert.ok(hosts.includes(host));
});

// mergeNoProxy：覆盖本机地址并保留原有条目。
test("mergeNoProxy always excludes local hosts and keeps existing entries", () => {
  const hosts = mergeNoProxy("example.com, 10.0.0.1").split(",").map((item) => item.trim());
  for (const host of ["127.0.0.1", "localhost", "::1", "example.com", "10.0.0.1"]) {
    assert.ok(hosts.includes(host), `no_proxy should include ${host}`);
  }
});
