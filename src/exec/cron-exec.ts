/**
 * cron-exec.ts —— 定时执行本地 shell 命令（多条）：每条一个 cron，到点在本机执行，只写日志。
 *
 * 与聊天运行时完全无关的旁路：不发消息、不进会话历史/记忆；也**不受 /启动 /停止 约束**
 * （系统级任务，与 bot 是否参与聊天无关）。时区固定 Asia/Shanghai，复用 scheduler 的 createCronJob。
 *
 * 约束/坑：
 * - 构造时即为每条命令创建 CronJob，cron 表达式非法会在此时抛错，交由 index.ts 统一校验退出；
 *   抛出的错误带上原始编号（EXEC_<n>），便于点名到具体哪条。
 * - run() 与 cron 解耦，可直接调用，便于测试；命令异常一律在内部捕获并记日志，不向上抛。
 * - 每条命令有重叠守卫：上一次仍在执行则本次到点跳过并记日志，避免长命令堆叠。
 */
import { exec } from "node:child_process";

import type { CronJob } from "cron";

import { logger } from "../logger.js";
import { proxyEnv } from "../proxy.js";
import { createCronJob } from "../schedule/scheduler.js";

/** 一条定时命令：index 为原始编号（EXEC_<index>），仅用于日志/报错定位。 */
export type ExecCommand = {
  index: number;
  cron: string;
  shell: string;
};

/** 定时执行命令的依赖：由 index.ts 组装注入。 */
export type CronExecutorDeps = {
  jobs: ExecCommand[];
  timeoutMs: number; // 单条命令执行超时，超时终止子进程
  maxOutputChars: number; // 日志里每条命令输出的截断上限
};

/**
 * 定时命令执行器：持有若干 cron 任务，到点在本机执行对应 shell 命令。
 * 生命周期：start() 启动，dispose() 停止（供优雅退出调用）。
 */
export class CronExecutor {
  private readonly jobs: CronJob[] = [];
  // 正在执行的命令编号集合，用于重叠守卫。
  private readonly running = new Set<number>();

  /** @param deps 依赖；构造后固定不变。任一 cron 非法时抛出（错误点名 EXEC_<n>）。 */
  constructor(private readonly deps: CronExecutorDeps) {
    for (const command of deps.jobs) {
      try {
        this.jobs.push(createCronJob(command.cron, () => void this.run(command), `exec_${command.index}`));
      } catch (error) {
        throw new Error(`EXEC_${command.index}_CRON 非法：${(error as Error).message}`);
      }
    }
  }

  /** 启动全部定时；到点触发 run()。 */
  start(): void {
    for (const job of this.jobs) job.start();
  }

  /** 停止全部定时（幂等）；进程退出时调用。 */
  dispose(): void {
    for (const job of this.jobs) void job.stop();
  }

  /**
   * 执行一条命令：重叠则跳过；否则经 /bin/sh 执行并把结果写日志。
   * 由 cron 到点调用，也直接暴露给测试。任何失败都只记日志，不抛出。
   */
  async run(command: ExecCommand): Promise<void> {
    if (this.running.has(command.index)) {
      logger.warn(`[exec] EXEC_${command.index} 上一次仍在执行，跳过本次（cron ${command.cron}）`);
      return;
    }
    this.running.add(command.index);
    logger.info(`[exec] EXEC_${command.index} 开始执行（cron ${command.cron}）：${command.shell}`);
    try {
      const result = await this.spawn(command.shell);
      this.logResult(command, result);
    } finally {
      this.running.delete(command.index);
    }
  }

  /** 执行 shell 命令并收集结果；不抛出，把 exec 的错误归一成结构化结果。 */
  private spawn(shell: string): Promise<ExecResult> {
    return new Promise((resolve) => {
      // 显式注入代理环境变量：bot 进程的代理是 undici dispatcher（不写 process.env），
      // 子进程直接继承会是「无代理」环境，出网命令（如 git pull）会直连超时。
      const env = { ...process.env, ...proxyEnv() };
      exec(shell, { timeout: this.deps.timeoutMs, env }, (error, stdout, stderr) => {
        const message = error?.message ?? "";
        const code = error?.code;
        // 输出超过 exec 的 maxBuffer：子进程被杀，错误文案里含 maxBuffer。
        const overflowed = message.includes("maxBuffer");
        resolve({
          stdout,
          stderr,
          failed: Boolean(error),
          // killed 为 true 表示是本次执行主动杀掉（超时或输出过大），而非命令自身退出码。
          killed: Boolean(error?.killed),
          overflowed,
          signal: error?.signal ?? null,
          code: typeof code === "number" ? code : null,
        });
      });
    });
  }

  /** 按结果分别记日志：成功 / 超时 / 输出过大 / 非零退出或信号终止。 */
  private logResult(command: ExecCommand, result: ExecResult): void {
    const output = this.formatOutput(result.stdout, result.stderr);
    const tag = `EXEC_${command.index}`;
    if (!result.failed) {
      logger.info(`[exec] ${tag} 执行成功${output}`);
      return;
    }
    if (result.overflowed) {
      logger.warn(`[exec] ${tag} 失败：输出过大，已被截断${output}`);
      return;
    }
    if (result.killed) {
      logger.warn(`[exec] ${tag} 失败：超时 >${this.deps.timeoutMs}ms，已终止${output}`);
      return;
    }
    logger.warn(`[exec] ${tag} 失败：exit=${result.code ?? "无"} signal=${result.signal ?? "无"}${output}`);
  }

  /** 拼接 stdout/stderr（各自截断、只留有内容的部分），前面带换行，无则为空串。 */
  private formatOutput(stdout: string, stderr: string): string {
    const parts: string[] = [];
    const out = this.truncate(stdout);
    const err = this.truncate(stderr);
    if (out) parts.push(`stdout: ${out}`);
    if (err) parts.push(`stderr: ${err}`);
    return parts.length > 0 ? "\n" + parts.join("\n") : "";
  }

  /** 截断输出到 maxOutputChars；截断时标注原始字符数，避免日志与实际不一致而误判。 */
  private truncate(text: string): string {
    const trimmed = text.replace(/\s+$/, "");
    const max = this.deps.maxOutputChars;
    if (trimmed.length <= max) return trimmed;
    return `${trimmed.slice(0, max)}……（截断，共 ${trimmed.length} 字符）`;
  }
}

/** 一次执行的归一化结果。 */
type ExecResult = {
  stdout: string;
  stderr: string;
  failed: boolean;
  killed: boolean;
  overflowed: boolean;
  signal: NodeJS.Signals | null;
  code: number | null;
};
