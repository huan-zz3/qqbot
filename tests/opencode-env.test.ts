/**
 * opencode-env.test.ts —— src/opencode/env.js 的 childEnv() 测试。
 *
 * 覆盖（这是「systemd 环境干净 → opencode 直连出网超时」那个 bug 的回归防线）：
 * - 传入代理地址 → 注入 http_proxy/https_proxy/all_proxy（大小写都写），并覆盖已有值；
 * - no_proxy/NO_PROXY 总是覆盖本机地址（127.0.0.1/localhost/::1），并保留原有条目；
 * - 代理地址留空 → 不注入任何代理变量（维持直连），但本机排除仍在。
 *
 * childEnv 的入参是 URL 字符串（默认取 config，但可显式传），所以无需 env 注入即可直测。
 * 为让「留空不注入」的断言不受运行环境自带的 http_proxy 影响，先清掉本进程的代理变量。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

for (const key of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
  delete process.env[key];
}

const { childEnv } = await import("../src/opencode/env.js");

// 代理地址按需注入，且大小写两组变量都写。
test("childEnv injects http/https/all proxy (both cases) when a proxy is set", () => {
  const env = childEnv("http://127.0.0.1:7890");
  assert.equal(env.http_proxy, "http://127.0.0.1:7890");
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.https_proxy, "http://127.0.0.1:7890");
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.all_proxy, "http://127.0.0.1:7890");
  assert.equal(env.ALL_PROXY, "http://127.0.0.1:7890");
});

// no_proxy/NO_PROXY 覆盖本机地址，并保留原有条目。
test("childEnv always excludes local hosts from the proxy and keeps existing entries", () => {
  process.env.NO_PROXY = "example.com";
  delete process.env.no_proxy;
  try {
    const env = childEnv("http://127.0.0.1:7890");
    const hosts = String(env.no_proxy).split(",").map((item) => item.trim());
    for (const host of ["127.0.0.1", "localhost", "::1", "example.com"]) {
      assert.ok(hosts.includes(host), `no_proxy should include ${host}`);
    }
    assert.equal(env.NO_PROXY, env.no_proxy);
  } finally {
    delete process.env.NO_PROXY;
  }
});

// 没配代理时不注入任何代理变量（维持直连），本机排除仍在。
test("childEnv adds no proxy variables when the proxy url is empty", () => {
  delete process.env.no_proxy;
  delete process.env.NO_PROXY;
  const env = childEnv("");
  for (const key of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
    assert.equal(env[key], undefined, `${key} should not be set`);
  }
  const hosts = String(env.no_proxy).split(",").map((item) => item.trim());
  assert.ok(hosts.includes("127.0.0.1"));
  assert.ok(hosts.includes("localhost"));
  assert.ok(hosts.includes("::1"));
});
