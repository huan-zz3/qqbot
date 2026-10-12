/**
 * welcome.ts —— 入群欢迎：新成员入群时 @ 其发送一条固定文本。
 *
 * 独立旁路：不走 decider，也不写会话历史/长期记忆，与群管理互不相关。
 * 触发条件（依次短路）：功能已启用、电源开关开启、群在 WELCOME_GROUPS 内、入群者不是机器人自己。
 * 受 /启动 /停止 约束；发送失败只记 warn，不重试、不向上抛。
 *
 * 约束/坑：
 * - 群范围来自 WELCOME_GROUPS（独立于 MODERATION_GROUPS）。
 * - 启用时的缺项校验在 index.ts 启动阶段完成，本模块不再兜底。
 * - handle 为 fire-and-forget，单个事件异常不影响后续事件。
 */
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { NapcatClient } from "../napcat/client.js";
import { textSegment } from "../napcat/message.js";
import type { GroupIncreaseEvent, Segment } from "../napcat/types.js";

/** 依赖注入：只列出本模块用到的客户端能力，外加可选的电源开关。 */
export type WelcomeDeps = {
  client: Pick<NapcatClient, "selfId" | "sendMessage">;
  // 管理员 /启动 /停止 的开关；关闭时跳过。
  power?: { readonly on: boolean };
};

/** 入群欢迎主体：监听入群通知并 @ 新成员发送固定文本。 */
export class Welcome {
  constructor(private readonly deps: WelcomeDeps) {}

  /** 事件入口：同步返回，实际发送在后台异步进行，不阻塞 WebSocket 回调。 */
  handle(event: GroupIncreaseEvent): void {
    void this.send(event);
  }

  private async send(event: GroupIncreaseEvent): Promise<void> {
    // 总开关：未启用直接跳过。
    if (!config.welcome.enabled) return;
    // 管理员 /停止 期间挂起。
    if (this.deps.power && !this.deps.power.on) {
      logger.info("[welcome] 开关已关闭，跳过入群欢迎");
      return;
    }
    const groupId = event.group_id;
    // 只欢迎白名单内的群。
    if (!config.welcome.groups.has(groupId)) return;
    const selfId = this.deps.client.selfId ?? event.self_id;
    // 机器人自己被拉进群时不 @ 自己。
    if (event.user_id === selfId) {
      logger.debug(`[welcome] 群 ${groupId} 入群者为机器人自己，跳过`);
      return;
    }
    // @ 成员 + 空格 + 固定文本，保证 @ 与正文之间有间隔。
    const segments: Segment[] = [
      { type: "at", data: { qq: String(event.user_id) } },
      textSegment(" "),
      textSegment(config.welcome.text),
    ];
    try {
      await this.deps.client.sendMessage({ groupId }, segments);
      logger.info(`[welcome] 群 ${groupId} 已欢迎新成员 ${event.user_id}：${config.welcome.text}`);
    } catch (error) {
      logger.warn(`[welcome] 群 ${groupId} 欢迎新成员 ${event.user_id} 失败: ${(error as Error).message}`);
    }
  }
}
