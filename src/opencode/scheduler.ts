/**
 * scheduler.ts —— OpenCode 任务的调度：同一会话串行 + 全局并发上限（纯逻辑，可单测）。
 *
 * 语义（两个正交约束）：
 * - 会话内串行：同一个 key（会话键，群号 / 私聊用户号）的任务按提交顺序依次执行，绝不同时跑；
 *   上一个任务无论成功或失败，下一个都能继续（失败不阻断同 key 后续）。
 * - 全局上限：所有 key 合计，实际运行的任务数不超过 maxConcurrency；超出的进入全局 FIFO 等待队列。
 *
 * 任务先排队等「同 key 前一个」结束，再争抢全局槽位；等前一个的期间**不占用**全局槽位。
 * 排队时间不计入任务的超时——计时由调用方在真正开始后自行启动（见 agent.ts）。
 */
export class TaskScheduler {
  // 每个 key 一条链：链尾 settle 后下一个才能开始。只用于串行，不关心结果。
  private readonly queues = new Map<string, Promise<unknown>>();
  // 全局槽位等待者，FIFO；唤醒即代表获得槽位（running 不变，由释放方移交）。
  private readonly waiters: Array<() => void> = [];
  // 当前实际运行中的任务数。
  private running = 0;

  constructor(private readonly maxConcurrency: number) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error(`并发上限必须为正整数（收到 ${maxConcurrency}）`);
    }
  }

  /** 当前运行中的任务数（供日志与测试观察）。 */
  get active(): number {
    return this.running;
  }

  /** 当前等待全局槽位的任务数（供日志与测试观察）。 */
  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * 按 key 排队执行一次任务。
   * @param key 会话键；为空直接拒绝（不允许默认落到共享队列，否则会静默把不同会话并到一起）。
   * @param task 任务本体；其结果或错误原样返回给调用方。
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    if (!key) return Promise.reject(new Error("OpenCode 调度需要非空的会话键"));
    const prev = this.queues.get(key) ?? Promise.resolve();
    const result = prev.then(async () => {
      await this.acquire();
      try {
        return await task();
      } finally {
        this.release();
      }
    });
    // 链尾只标记「是否结束」，吞掉结果与错误，避免影响后续任务与未处理的拒绝。
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, settled);
    // 该 key 已排空时清理记录，避免长期运行下 Map 无界增长。
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return result;
  }

  /** 占一个全局槽位；满则进等待队列，等到释放方移交才继续。 */
  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** 释放槽位：有等待者就移交给队首（运行数不变），否则运行数减一。 */
  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.running--;
  }
}
