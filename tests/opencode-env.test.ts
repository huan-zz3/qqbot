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

// 配对码配置的端口与调用超时在 config.ts import 时就固化，必须在此之前设置。
// （NODE_TEST_CONTEXT 下 config.ts 不读 .env，这里显式给值以验证注入用的是 config 而不是写死常量。）
process.env.AGENT_CLIENT_MCP_PORT = "7802";
process.env.AGENT_CLIENT_CALL_TIMEOUT_MS = "90000";

const { childEnv } = await import("../src/opencode/env.js");
const { config } = await import("../src/config.js");

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

// 只读加固：无论代理如何，都注入 OPENCODE_CONFIG_CONTENT 且把写/命令/联网类工具 deny。
test("childEnv always injects the read-only OPENCODE_CONFIG_CONTENT deny policy", () => {
  const env = childEnv("http://127.0.0.1:7890");
  const parsed = JSON.parse(String(env.OPENCODE_CONFIG_CONTENT)) as {
    permissions: Array<{ action: string; effect: string }>;
  };
  const denied = parsed.permissions.filter((item) => item.effect === "deny").map((item) => item.action);
  for (const action of ["edit", "shell", "execute", "webfetch", "websearch", "subagent"]) {
    assert.ok(denied.includes(action), `${action} should be denied`);
  }
});

// 无配对码时必须是逐字节固定的六条 deny：防止有人误删/改写只读加固（回归防线）。
test("childEnv without a pairing code emits exactly the six deny rules", () => {
  const env = childEnv(undefined, undefined);
  const expected = {
    permissions: [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "execute", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "deny" },
      { action: "websearch", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
    ],
  };
  assert.equal(env.OPENCODE_CONFIG_CONTENT, JSON.stringify(expected));
});

// 带配对码时：六条 deny 原样保留，并叠加指向本机 MCP 的远程 server（端口/超时取自 config）。
test("childEnv with a pairing code adds the agent MCP server without dropping the deny rules", () => {
  const env = childEnv(undefined, "12345678");
  const parsed = JSON.parse(String(env.OPENCODE_CONFIG_CONTENT)) as {
    permissions: Array<{ action: string; resource: string; effect: string }>;
    mcp: {
      servers: {
        agent: {
          type: string;
          url: string;
          headers: Record<string, string>;
          codemode: boolean;
          timeout: { execution: number };
        };
      };
    };
  };

  assert.deepEqual(parsed.permissions, [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
    { action: "execute", resource: "*", effect: "deny" },
    { action: "webfetch", resource: "*", effect: "deny" },
    { action: "websearch", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  ]);

  const agent = parsed.mcp.servers.agent;
  assert.equal(agent.type, "remote");
  assert.ok(agent.url.startsWith("http://127.0.0.1:"), `unexpected url: ${agent.url}`);
  assert.ok(agent.url.endsWith("/mcp"), `unexpected url: ${agent.url}`);
  assert.equal(agent.url, `http://127.0.0.1:${config.agentClient.mcpPort}/mcp`);
  assert.equal(agent.headers["X-Pair-Code"], "12345678");
  assert.equal(agent.codemode, false);
  assert.equal(agent.timeout.execution, config.agentClient.callTimeoutMs + 5000);
});

