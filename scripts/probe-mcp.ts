/**
 * probe-mcp.ts —— 验证 opencode V2 `codemode` 与 MCP 工具权限行为的探针，不是生产代码。
 * 结论见 `docs/superpowers/specs/2026-11-03-agent-client-design.md` 的对应段落。
 * 保留它是因为结论只能靠实测复现，不是可以凭文档推断的。
 * 实测 opencode V2 里 remote MCP 工具是否以原生工具名出现、默认权限是否 allow。
 *
 * 三轮模式（PROBE_MODE=A|B|C）：
 *   A: codemode=false + 六条 deny（本次实现的目标配置）
 *   B: codemode=true  + 六条 deny（对照：预期 execute 被 deny）
 *   C: codemode=false + 六条 allow（对照：区分 codemode 还是权限导致）
 *   D: codemode=true  + 六条 allow（补充对照：真正验证 codemode 是否生效）
 *
 * 自包含，不 import src/（config.ts 会在 import 时固化 env）。
 * 运行：pnpm exec tsx scripts/probe-mcp.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const MODE = (process.env.PROBE_MODE ?? "A").toUpperCase();
const PORT = 7911;
const TOOL_NAME = "run_psh";
const HARD_TIMEOUT_MS = 90_000;
const PAIR_CODE = "12345678";

const DENY = ["edit", "shell", "execute", "webfetch", "websearch", "subagent"];
const permissions = ["C", "D"].includes(MODE)
  ? DENY.map((action) => ({ action, resource: "*", effect: "allow" }))
  : DENY.map((action) => ({ action, resource: "*", effect: "deny" }));
const codemode = ["B", "D"].includes(MODE);

const config = {
  permissions,
  mcp: {
    servers: {
      agent: {
        type: "remote",
        url: `http://127.0.0.1:${PORT}/mcp`,
        headers: { "X-Pair-Code": PAIR_CODE },
        codemode,
        timeout: { catalog: 15000, execution: 95000 },
      },
    },
  },
};

type Observed = {
  mode: string;
  codemode: boolean;
  pairCodes: string[];
  rawMethods: string[];
  toolsListCount: number;
  listedTools: string[];
  toolCallCount: number;
  toolCalls: Array<{ command: unknown; pairCode: string | undefined }>;
  sessionToolCalls: Array<{ name: string | null; title: string; status: string }>;
  permissionRequests: Array<{ name: string | null; title: string; optionKinds: string[] }>;
  agentText: string;
  stopReason: string | null;
  error: string | null;
  stderrTail: string;
};

const obs: Observed = {
  mode: MODE,
  codemode,
  pairCodes: [],
  rawMethods: [],
  toolsListCount: 0,
  listedTools: [],
  toolCallCount: 0,
  toolCalls: [],
  sessionToolCalls: [],
  permissionRequests: [],
  agentText: "",
  stopReason: null,
  error: null,
  stderrTail: "",
};

function log(...args: unknown[]): void {
  console.log(...args);
}

/** 读请求体（JSON）。 */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

/** 建一个 stateless MCP server（每个 POST 请求一个新实例）。 */
function buildMcpServer(): Server {
  const server = new Server({ name: "probe-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: TOOL_NAME,
          description: "执行一条 PowerShell 命令并返回结果",
          inputSchema: {
            type: "object",
            properties: { command: { type: "string", description: "要执行的命令" } },
            required: ["command"],
          },
        },
      ],
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as { command?: unknown };
    log(`[mcp] >>> tools/call ${request.params.name} command=${JSON.stringify(args.command)}`);
    return { content: [{ type: "text", text: `PROBE_OK:${String(args.command ?? "")}` }] };
  });
  return server;
}

const httpServer = createServer(async (req, res) => {
  const pairCode = req.headers["x-pair-code"];
  const pairCodeStr = Array.isArray(pairCode) ? pairCode[0] : pairCode;
  if (pairCodeStr) {
    obs.pairCodes.push(pairCodeStr);
    log(`[mcp] HTTP ${req.method} ${req.url} x-pair-code=${pairCodeStr}`);
  } else {
    log(`[mcp] HTTP ${req.method} ${req.url} (无 x-pair-code)`);
  }

  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch (error) {
    res.writeHead(400).end(String(error));
    return;
  }

  const message = body as { method?: string; id?: unknown } | undefined;
  if (message?.method) {
    obs.rawMethods.push(message.method);
    log(`[mcp] JSON-RPC method=${message.method}`);
    if (message.method === "tools/list") obs.toolsListCount++;
    if (message.method === "tools/call") {
      obs.toolCallCount++;
      const params = (message as { params?: { name?: string; arguments?: { command?: unknown } } }).params;
      obs.toolCalls.push({ command: params?.arguments?.command, pairCode: pairCodeStr });
      log(`[mcp] tools/call name=${params?.name} command=${JSON.stringify(params?.arguments?.command)}`);
    }
    if (message.method === "notifications/initialized") {
      // 通知无 id；给出 202 即可，交给 transport 处理也行。
    }
  }

  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    log(`[mcp] handleRequest 失败: ${(error as Error).message}`);
    if (!res.headersSent) res.writeHead(500).end(String(error));
  }
});

function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const proxy = process.env.PROXY_URL || process.env.https_proxy || process.env.http_proxy;
  if (proxy) {
    env.http_proxy = proxy;
    env.https_proxy = proxy;
    env.all_proxy = proxy;
  }
  const noProxy = new Set(
    `${env.no_proxy ?? env.NO_PROXY ?? ""},127.0.0.1,localhost,::1`
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  env.no_proxy = [...noProxy].join(",");
  env.NO_PROXY = env.no_proxy;
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  return env;
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
}

async function runProbe(): Promise<void> {
  const command = process.env.OPENCODE_COMMAND || "opencode";
  const startedAt = Date.now();
  log(`[probe] 模式=${MODE} codemode=${codemode} permissions=${permissions[0].effect} 命令=${command}`);

  const child = spawn(command, ["acp"], {
    cwd: process.cwd(),
    env: buildEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-6000);
  });

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );

  let timer: NodeJS.Timeout | undefined;
  const hardTimeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`硬超时 ${HARD_TIMEOUT_MS}ms`)), HARD_TIMEOUT_MS);
  });

  const app = acp
    .client({ name: "probe-client" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      const toolCall = ctx.params.toolCall;
      const optionKinds = ctx.params.options.map((option) => option.kind);
      obs.permissionRequests.push({
        name: toolCall.name ?? null,
        title: toolCall.title ?? "",
        optionKinds,
      });
      log(`[acp] !!! 收到 permission 请求: name=${toolCall.name ?? "-"} title=${toolCall.title ?? "-"} options=${optionKinds.join(",")}`);
      const allow =
        ctx.params.options.find((option) => option.kind === "allow_always") ??
        ctx.params.options.find((option) => option.kind === "allow_once");
      if (!allow) return { outcome: { outcome: "cancelled" as const } };
      return { outcome: { outcome: "selected" as const, optionId: allow.optionId } };
    })
    .onRequest(acp.methods.client.fs.readTextFile, () => {
      throw new Error("probe 未声明 fs 能力");
    })
    .onRequest(acp.methods.client.fs.writeTextFile, () => {
      throw new Error("probe 未声明 fs 能力");
    });

  try {
    await Promise.race([
      app.connectWith(stream, async (ctx) => {
        const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
        log(`[acp] initialize protocol=${init.protocolVersion}`);

        const session = await ctx.buildSession(process.cwd()).start();
        log(`[acp] session=${session.sessionId}`);

        const promptPromise = session.prompt(
          '调用 agent_run_psh 工具，command 参数填 "whoami"，然后把工具返回的文本原样输出。不要使用其它工具。',
        );
        for (;;) {
          const message = await session.nextUpdate();
          if (message.kind === "stop") {
            obs.stopReason = message.response.stopReason;
            log(`[acp] stop reason=${message.response.stopReason}`);
            break;
          }
          const update = message.update;
          const kind = update.sessionUpdate;
          if (kind === "tool_call" || kind === "tool_call_update") {
            const title = ("title" in update && update.title) || "";
            const name = ("name" in update && update.name) || null;
            const status = ("status" in update && update.status) || "";
            obs.sessionToolCalls.push({ name, title: String(title), status: String(status) });
            log(`[acp] ${kind} name=${name ?? "-"} title=${String(title)} status=${String(status)}`);
          } else if (kind === "agent_message_chunk") {
            const content = update.content;
            if (content.type === "text") obs.agentText += content.text;
          } else if (kind === "notice" || kind === "session_info_update") {
            log(`[acp] ${kind} ${JSON.stringify(update).slice(0, 300)}`);
          } else if (kind === "available_commands_update" || kind === "config_option_update") {
            // 只在需要时打印，避免噪声
          } else {
            log(`[acp] update ${kind}`);
          }
        }
        await promptPromise;
        session.dispose();
      }),
      hardTimeout,
    ]);
  } catch (error) {
    obs.error = (error as Error).message;
    log(`[probe] 失败: ${obs.error}`);
  } finally {
    if (timer) clearTimeout(timer);
    killTree(child);
    obs.stderrTail = stderr.slice(-2000);
    log(`[probe] 用时=${Date.now() - startedAt}ms 子进程已杀`);
  }
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => httpServer.listen(PORT, "127.0.0.1", resolve));
  log(`[mcp] 监听 127.0.0.1:${PORT}/mcp`);
  try {
    await runProbe();
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  console.log("\n========== 原始观察 ==========");
  console.log(JSON.stringify(obs, null, 2));
  if (obs.stderrTail) console.log(`\n----- opencode stderr (tail) -----\n${obs.stderrTail}`);
  console.log("\n========== 摘要 ==========");
  console.log(`模式: ${MODE} (codemode=${codemode}, permissions=${permissions[0].effect})`);
  console.log(`x-pair-code 收到的值: ${JSON.stringify([...new Set(obs.pairCodes)])}`);
  console.log(`JSON-RPC methods: ${JSON.stringify([...new Set(obs.rawMethods)])}`);
  console.log(`tools/list 次数: ${obs.toolsListCount}`);
  console.log(`tools/call 次数: ${obs.toolCallCount}`);
  console.log(`permission 请求次数: ${obs.permissionRequests.length}`);
  console.log(`session 工具调用: ${JSON.stringify(obs.sessionToolCalls)}`);
  console.log(`stopReason: ${obs.stopReason}`);
  console.log(`模型最终文本: ${JSON.stringify(obs.agentText.trim())}`);
  if (obs.error) console.log(`错误: ${obs.error}`);

  process.exit(0);
}

void main();
