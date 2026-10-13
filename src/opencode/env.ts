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

/** 永远不经过代理的本机地址。 */
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1"];

/**
 * 只读加固：每个 opencode 子进程都注入这段配置，把「写/命令/联网」类工具直接摘掉。
 * 实测（探针 F）：deny 生效时不弹权限询问，直接不挂对应工具，且不影响模型/provider 解析。
 * 这是把不可信压缩包内容交给 opencode 分析的前提；`execute`（Code Mode，能跑 JS + fetch，
 * 是外传通道）也必须 deny。
 */
const READONLY_CONFIG = JSON.stringify({
  permissions: [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
    { action: "execute", resource: "*", effect: "deny" },
    { action: "webfetch", resource: "*", effect: "deny" },
    { action: "websearch", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  ],
});

/**
 * 基于当前环境构造子进程环境：合并 no_proxy 覆盖本机地址，并在配了代理时显式注入代理变量；
 * 同时注入只读加固配置（覆盖用户已有的 OPENCODE_CONFIG_CONTENT，只读是硬要求）。
 *
 * @param proxyUrl 代理地址；默认取 config.proxy.url，留空则维持直连（仍会排除本机）。
 * @returns 供 spawn 使用的环境变量对象。
 */
export function childEnv(proxyUrl: string = config.proxy.url): NodeJS.ProcessEnv {
  const existing = process.env.no_proxy ?? process.env.NO_PROXY ?? "";
  const entries = new Set(existing.split(",").map((item) => item.trim()).filter(Boolean));
  for (const host of LOCAL_HOSTS) entries.add(host);
  const merged = [...entries].join(",");
  const env: NodeJS.ProcessEnv = { ...process.env, no_proxy: merged, NO_PROXY: merged };
  // 配了代理则显式注入（大小写都写，兼容只看其中一种的 HTTP 客户端）；留空则维持直连。
  const proxy = proxyUrl.trim();
  if (proxy) {
    env.http_proxy = env.HTTP_PROXY = proxy;
    env.https_proxy = env.HTTPS_PROXY = proxy;
    env.all_proxy = env.ALL_PROXY = proxy;
  }
  // 只读加固：覆盖式注入，确保 opencode 子进程拿不到写/命令/联网类工具。
  env.OPENCODE_CONFIG_CONTENT = READONLY_CONFIG;
  return env;
}
