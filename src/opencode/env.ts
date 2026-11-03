/**
 * env.ts —— 构造 opencode 子进程的环境变量（纯函数，不依赖 ACP SDK，便于单测）。
 *
 * 为什么需要它：bot 自身的出网靠 undici 的 ProxyAgent（见 proxy.ts），只作用于本进程；
 * opencode 是独立子进程，拿不到那个 dispatcher，必须靠环境变量走代理。若父进程环境里
 * 没有 http_proxy（例如 systemd 起的服务环境是干净的），opencode 会直连 models.dev、
 * 模型 provider、远程 MCP 等外部地址，在只能经代理出网的机器上表现为超时/证书错误，
 * 任务永远跑不完（见 childEnv 的使用方 agent.ts）。
 *
 * 同时确保 no_proxy/NO_PROXY 覆盖本机地址：OpenCode 的 ACP 会用一个本机 HTTP 私有服务
 * 做内部通信，这些请求若被代理转发会失败（表现为 “Internal error: Internal service
 * failure”）。显式排除本机即可，不影响出网仍走代理。
 */
import { config } from "../config.js";
import { proxyEnv } from "../proxy.js";

/**
 * 只读加固：每个 opencode 子进程都注入这段配置，把「写/命令/联网」类工具直接摘掉。
 * 实测（探针 F）：deny 生效时不弹权限询问，直接不挂对应工具，且不影响模型/provider 解析。
 * 这是把不可信压缩包内容交给 opencode 分析的前提；`execute`（Code Mode，能跑 JS + fetch，
 * 是外传通道）也必须 deny。
 */
const READONLY_PERMISSIONS = [
  { action: "edit", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "deny" },
  { action: "execute", resource: "*", effect: "deny" },
  { action: "webfetch", resource: "*", effect: "deny" },
  { action: "websearch", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
];

// 无配对码时的配置：只读加固。**必须**与引入配对码之前逐字节一致（既有行为不变）。
const READONLY_CONFIG = JSON.stringify({ permissions: READONLY_PERMISSIONS });

/**
 * 带配对码时的配置：只读加固原样保留，额外挂上转发到本机 MCP server 的远程 server。
 *
 * `codemode: false` 是显式设置而非必需项：探针实测，`execute` 被 deny 时即使 `codemode: true`，
 * opencode 也会把 MCP 工具退回原生直挂（所以只读加固本身已能兜住）；只有 `execute` 未被 deny 时
 * `codemode` 才决定走向（此时 `true` 会让模型只看到 `execute` 一个入口）。
 * 仍显式写 false，是为了不依赖「execute 被 deny」这条隐式兜底——将来若放开 execute，这里不会跟着失效。
 * `timeout.execution` 必须大于服务端一次调用的超时（callTimeoutMs），否则本层先超时。
 */
function pairedConfig(pairing: string): string {
  return JSON.stringify({
    permissions: READONLY_PERMISSIONS,
    mcp: {
      servers: {
        agent: {
          type: "remote",
          url: `http://127.0.0.1:${config.agentClient.mcpPort}/mcp`,
          headers: { "X-Pair-Code": pairing },
          codemode: false,
          timeout: { catalog: 15000, execution: config.agentClient.callTimeoutMs + 5000 },
        },
      },
    },
  });
}

/**
 * 基于当前环境构造子进程环境：合并 no_proxy 覆盖本机地址，并在配了代理时显式注入代理变量；
 * 同时注入只读加固配置（覆盖用户已有的 OPENCODE_CONFIG_CONTENT，只读是硬要求）。
 *
 * @param proxyUrl 代理地址；默认取 config.proxy.url，留空则维持直连（仍会排除本机）。
 * @param pairing 群友客户端的配对码；非空时在只读加固之上叠加远程 MCP server（不覆盖 deny）。
 * @returns 供 spawn 使用的环境变量对象。
 */
export function childEnv(proxyUrl: string = config.proxy.url, pairing?: string): NodeJS.ProcessEnv {
  // 代理与本机排除复用 proxyEnv（与 cron-exec 等其它子进程同一份逻辑）。
  const env: NodeJS.ProcessEnv = { ...process.env, ...proxyEnv(proxyUrl) };
  // 只读加固：覆盖式注入，确保 opencode 子进程拿不到写/命令/联网类工具。
  env.OPENCODE_CONFIG_CONTENT = pairing ? pairedConfig(pairing) : READONLY_CONFIG;
  return env;
}
