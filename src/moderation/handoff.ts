/**
 * handoff.ts —— 群管理 ↔ 聊天运行时的协调信号。
 *
 * 两者对同一条消息并发处理：群管理要调 decider（网络往返），聊天运行时要经过防抖后才判断；
 * 谁的判定先出结果本来没有保证。为避免「群管理命中了、聊天却已抢先回复」，这里让聊天运行时
 * 在决定是否说话前，先等本批消息的群管理判定结束，再查命中标记：
 *
 * - begin(messageId)：群管理开始判定某条消息；
 * - settle(messageId)：该条判定结束（无论是否命中）；
 * - wait(messageIds)：聊天运行时等待这批消息的判定全部结束（超时则放弃，避免被卡死）；
 * - mark/handled：群管理命中后标记，聊天运行时据此跳过整批 AI 回复（原有单向信号）。
 *
 * 记录只放内存、带 TTL：过期项自动失效，避免 Map 无限增长。
 */

/** 一条「已命中」记录在多久后自动失效（毫秒）：远大于群聊防抖上限即可。 */
const TTL_MS = 60_000;

/** 等待判定结束的兜底超时（毫秒）：群管理卡住时聊天不再无限等，记日志放行。 */
const WAIT_TIMEOUT_MS = 8000;

/** 可在稍后兑现的完成信号。 */
type Deferred = { promise: Promise<void>; resolve: () => void };

/** 简易延时，用于给等待加兜底超时。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 群管理与聊天运行时之间的协调器。 */
export class ModerationHandoff {
  /** 已命中、需要聊天跳过回复的消息，按 message_id 记录并带 TTL。 */
  private readonly handledAt = new Map<number, number>();
  /** 正在进行中的群管理判定：message_id → 完成信号。 */
  private readonly judging = new Map<number, Deferred>();

  /** 标记一条消息已被群管理处理（命中）。 */
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

  /** 群管理开始判定一条消息；聊天运行时在回复前会等待它结束。重复 begin 无副作用。 */
  begin(messageId: number): void {
    if (this.judging.has(messageId)) return;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.judging.set(messageId, { promise, resolve });
  }

  /** 一条消息的群管理判定结束（无论是否命中）。 */
  settle(messageId: number): void {
    const deferred = this.judging.get(messageId);
    if (!deferred) return;
    this.judging.delete(messageId);
    deferred.resolve();
  }

  /**
   * 等待这批消息的群管理判定全部结束。
   * @returns 是否在超时前全部结束（true 表示都已出结果；false 表示超时）
   */
  async wait(messageIds: readonly number[], timeoutMs = WAIT_TIMEOUT_MS): Promise<boolean> {
    const waits = messageIds
      .map((id) => this.judging.get(id)?.promise)
      .filter((promise): promise is Promise<void> => promise !== undefined);
    if (waits.length === 0) return true;
    let timedOut = false;
    await Promise.race([
      Promise.all(waits),
      sleep(timeoutMs).then(() => {
        timedOut = true;
      }),
    ]);
    return !timedOut;
  }
}
