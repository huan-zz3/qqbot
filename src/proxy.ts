/**
 * proxy.ts —— 把 .env 里配置的 PROXY_URL 应用到全局出网。
 *
 * Node 内置 fetch（undici）不会自动读取 *_proxy 环境变量，必须显式安装 dispatcher。
 * 在进程启动最早期调用一次 installProxy()，本项目所有 fetch（deepseek、MCP 搜索、
 * 图片下载）以及 decider（内部用 globalThis.fetch）都会走同一个代理。
 * PROXY_URL 留空则不安装，保持直连。
 */
import { ProxyAgent, setGlobalDispatcher } from "undici";

import { config } from "./config.js";
import { logger } from "./logger.js";

/** 永远不经过代理的本机地址。 */
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1"];

/**
 * 按给定 URL 安装全局代理：url 非空时设为全局 dispatcher，返回是否启用。
 * url 非法时 ProxyAgent 会抛错——让启动直接失败，避免「配了却没走代理」被静默忽略。
 */
export function installProxy(url: string): boolean {
  if (!url) return false;
  setGlobalDispatcher(new ProxyAgent(url));
  logger.info(`网络代理已启用：${url}`);
  return true;
}

/** 把本机地址并入 no_proxy（保留原有条目），返回合并后的逗号串。 */
export function mergeNoProxy(existing: string = process.env.no_proxy ?? process.env.NO_PROXY ?? ""): string {
  const entries = new Set(existing.split(",").map((item) => item.trim()).filter(Boolean));
  for (const host of LOCAL_HOSTS) entries.add(host);
  return [...entries].join(",");
}

/**
 * 为子进程构造代理环境变量增量：PROXY_URL 非空时注入 http/https/all_proxy（大小写都写），
 * 并始终把本机地址并入 no_proxy/NO_PROXY。
 *
 * 为什么需要它：bot 自身的出网靠本模块的 undici dispatcher，只作用于本进程、且**不写回
 * process.env**；而 systemd 起的服务环境里没有 *_proxy，子进程继承到的就是「无代理」环境，
 * 会表现为直连外网超时（见 cron-exec.ts、opencode/env.ts）。故凡是要出网的子进程都须补上。
 *
 * @param proxyUrl 代理地址；默认取 config.proxy.url，留空则维持直连（仍会排除本机）。
 * @returns 供 spawn/exec 合并进子进程 env 的对象。
 */
export function proxyEnv(proxyUrl: string = config.proxy.url): NodeJS.ProcessEnv {
  const merged = mergeNoProxy();
  const env: NodeJS.ProcessEnv = { no_proxy: merged, NO_PROXY: merged };
  const proxy = proxyUrl.trim();
  if (proxy) {
    env.http_proxy = env.HTTP_PROXY = proxy;
    env.https_proxy = env.HTTPS_PROXY = proxy;
    env.all_proxy = env.ALL_PROXY = proxy;
  }
  return env;
}
