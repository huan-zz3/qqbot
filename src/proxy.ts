/**
 * proxy.ts —— 把 .env 里配置的 PROXY_URL 应用到全局出网。
 *
 * Node 内置 fetch（undici）不会自动读取 *_proxy 环境变量，必须显式安装 dispatcher。
 * 在进程启动最早期调用一次 installProxy()，本项目所有 fetch（deepseek、Codex 搜索、
 * 图片下载）以及 jev SDK（内部用 globalThis.fetch）都会走同一个代理。
 * PROXY_URL 留空则不安装，保持直连。
 */
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { logger } from "./logger.js";

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
