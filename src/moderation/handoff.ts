/**
 * handoff.ts —— 群管理 → 聊天运行时的单向信号。
 *
 * 群管理命中一条消息后调用 mark() 记下它的 message_id；聊天运行时在生成 AI 回复前
 * 调 handled() 查询，命中则跳过该批回复。两个模块除此之外互不影响，只共享这一个只读信号。
 *
 * 记录只放内存、带 TTL：消息判定与回复判断相隔防抖时长（数秒），过期项自动失效，
 * 避免 Map 无限增长。
 */

/** 一条记录在多久后自动失效（毫秒）：远大于群聊防抖上限即可。 */
const TTL_MS = 60_000;

/** 群管理处理过的消息集合，按 message_id 记录并带 TTL。 */
export class ModerationHandoff {
  private readonly handledAt = new Map<number, number>();

  /** 标记一条消息已被群管理处理。 */
  mark(messageId: number, now = Date.now()): void {
    this.handledAt.set(messageId, now);
    // 顺带清理过期项，避免长期运行下 Map 只增不减。
    for (const [id, at] of this.handledAt) {
      if (now - at > TTL_MS) this.handledAt.delete(id);
    }
  }

  /** 该消息是否在 TTL 内被群管理处理过；过期视为未处理。 */
  handled(messageId: number, now = Date.now()): boolean {
    const at = this.handledAt.get(messageId);
    if (at === undefined) return false;
    if (now - at > TTL_MS) {
      this.handledAt.delete(messageId);
      return false;
    }
    return true;
  }
}
