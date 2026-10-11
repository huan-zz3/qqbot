/**
 * scheduler.ts —— 定时群发：按一条 cron 向指定群各发一条固定文本（纯文本）。
 *
 * 与聊天运行时完全无关的旁路发送通道：不走 decider / DeepSeek，也不写入会话历史或长期记忆。
 * 时区固定为 Asia/Shanghai（不开放配置）。受 /启动 /停止 电源开关约束：关闭时到点跳过。
 *
 * 约束/坑：
 * - 构造时即用 cron 库创建 CronJob，cron 表达式非法会在此时抛错，交由 index.ts 统一校验。
 * - fire() 与 cron 解耦，可直接调用，便于测试；逐个群独立 try/catch，单群失败不影响其余群。
 * - 发送复用 NapcatClient.sendMessage，天然继承其串行化与 NAPCAT_SEND_INTERVAL_MS 节流。
 */
import { CronJob } from "cron";

import type { PowerSwitch } from "../chat/power.js";
import { logger } from "../logger.js";
import type { NapcatClient } from "../napcat/client.js";
import { textSegment } from "../napcat/message.js";

// 定时群发固定时区；用户按北京时间写 cron。
const TIMEZONE = "Asia/Shanghai";

/** 定时群发的依赖：由 index.ts 组装注入。 */
export type ScheduledMessengerDeps = {
  client: Pick<NapcatClient, "sendMessage">; // 只用到发送能力
  power: PowerSwitch; // /启动 /停止 开关；关闭时到点跳过
  groups: number[]; // 目标群号
  cron: string; // cron 表达式
  text: string; // 固定文本
};

/**
 * 定时群发器：持有一个 cron 定时任务，到点向多个群发送同一条固定文本。
 * 生命周期：start() 启动，dispose() 停止（供优雅退出调用）。
 */
export class ScheduledMessenger {
  private readonly job: CronJob;

  /** @param deps 依赖；构造后固定不变。cron 表达式非法时抛出。 */
  constructor(private readonly deps: ScheduledMessengerDeps) {
    this.job = CronJob.from({
      cronTime: deps.cron,
      onTick: () => void this.fire(),
      // 由 start() 显式启动，便于 index.ts 在装配完成后再开。
      start: false,
      timeZone: TIMEZONE,
      // cron 回调内部异常兜底记录，避免未处理的 Promise 拒绝。
      errorHandler: (error) => logger.error(`[schedule] 定时任务异常: ${(error as Error).message}`),
    });
  }

  /** 启动定时；到点触发 fire()。 */
  start(): void {
    this.job.start();
  }

  /** 停止定时（幂等）；进程退出时调用。 */
  dispose(): void {
    void this.job.stop();
  }

  /**
   * 执行一次群发：开关关闭则跳过；否则逐群发送固定文本，单群失败只记日志。
   * 由 cron 到点调用，也直接暴露给测试。
   */
  async fire(): Promise<void> {
    if (!this.deps.power.on) {
      logger.info("[schedule] 开关已关闭，跳过本次定时群发");
      return;
    }
    logger.info(`[schedule] 触发定时群发 -> 群 ${this.deps.groups.join(",")}`);
    const segments = [textSegment(this.deps.text)];
    for (const groupId of this.deps.groups) {
      try {
        await this.deps.client.sendMessage({ groupId }, segments);
        logger.info(`[schedule] 已发送到群 ${groupId}：${this.deps.text}`);
      } catch (error) {
        logger.warn(`[schedule] 发送到群 ${groupId} 失败: ${(error as Error).message}`);
      }
    }
  }
}
