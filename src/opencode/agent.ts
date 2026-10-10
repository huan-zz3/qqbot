/**
 * agent.ts —— OpenCode ACP 客户端：把一次只读任务交给 `opencode acp` 子进程执行并取回文本。
 *
 * 用途：给模型提供一个「在固定仓库里检索/阅读代码并回答」的工具（见 chat/reply.ts 的 openCodeTool）。
 * 做法：每次调用 spawn 一个 `opencode acp`（JSON-RPC over stdio），走
 *   initialize -> session/new(cwd) -> session/prompt -> 收流式更新 -> stop 的标准流程，
 * 用官方 @agentclientprotocol/sdk 承载协议细节。
 *
 * 关键约束（都是刻意的最小化，不要随意扩）：
 * - 只读：initialize 不声明任何客户端能力（无 fs、无 terminal、无 elicitation），
 *   并且所有 session/request_permission 一律拒绝（decidePermission），因此 agent 无法
 *   执行命令或改动文件；一旦它请求 fs 能力，说明协议理解有误，直接报错而不是无声返回。
 * - 同步：run() 一直等到任务 stop 才返回，超时则取消并杀掉子进程；不保留常驻进程或会话。
 * - 串行：run() 内部排队，同一时刻只跑一个子进程（模型一轮可能并发发起多个工具调用）。
 * - 不静默：任何一步失败都向上抛出（由工具层转成给模型的错误文本），并在此处留日志；
 *   子进程的 stderr 会被收集，失败时随错误信息一起暴露，便于排查。
 *
 * 依赖 config.opencode（command、args、cwd、timeoutMs、maxOutputChars）。
 */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import { logger } from "../logger.js";
import { decidePermission } from "./permission.js";

/** OpenCodeAgent 的构造参数（来自 config.opencode）。 */
export type OpenCodeOptions = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
};

/** 把任务提示压成单行摘要，供日志使用（截断 80 字符）。 */
function summarize(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

/**
 * 子进程环境：继承当前环境，并确保 no_proxy/NO_PROXY 覆盖本机地址。
 * OpenCode 的 ACP 会用一个本机 HTTP 私有服务做内部通信；若父进程设了 http_proxy
 * 却没把 localhost 排除，这些内部请求会被代理转发而失败（表现为
 * “Internal error: Internal service failure”）。显式排除本机即可，不影响出网仍走代理。
 */
function childEnv(): NodeJS.ProcessEnv {
  const existing = process.env.no_proxy ?? process.env.NO_PROXY ?? "";
  const entries = new Set(existing.split(",").map((item) => item.trim()).filter(Boolean));
  for (const host of ["127.0.0.1", "localhost", "::1"]) entries.add(host);
  const merged = [...entries].join(",");
  return { ...process.env, no_proxy: merged, NO_PROXY: merged };
}

/**
 * OpenCode 只读客户端。生命周期内不在内存里保留任何 ACP 状态：
 * 每次 run() 现开一个子进程，结束（正常或异常）即杀掉。
 */
export class OpenCodeAgent {
  // 串行队列：run() 依次排队，保证同一时刻只有一个子进程。
  private queue: Promise<unknown> = Promise.resolve();
  // 当前存活的子进程，供 dispose() 在进程退出时清理。
  private child: ReturnType<typeof spawn> | undefined;

  constructor(private readonly options: OpenCodeOptions) {}

  /**
   * 排队执行一次只读任务。
   * @param prompt 交给 OpenCode 的任务或问题。
   * @returns 任务结束时 OpenCode 的文本答复（可能为空或已截断）；失败时抛出。
   */
  run(prompt: string): Promise<string> {
    // 无论前一次成功或失败，都接着执行（失败不影响后续排队）。
    const next = this.queue.then(
      () => this.execute(prompt),
      () => this.execute(prompt),
    );
    // 队列自身吞掉结果，只作为「上一个是否结束」的标记，避免未处理的拒绝。
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 杀掉当前存活子进程；进程退出时调用，避免留下孤儿。 */
  dispose(): void {
    if (this.child && !this.child.killed) this.child.kill();
    this.child = undefined;
  }

  /**
   * 单次任务的完整流程：spawn -> initialize -> session/new -> prompt -> stop -> 清理。
   * 所有异常都向上抛出，并带上子进程 stderr 片段便于定位。
   */
  private async execute(prompt: string): Promise<string> {
    const { command, args, cwd, timeoutMs, maxOutputChars } = this.options;
    const startedAt = Date.now();
    logger.info(`[opencode] 开始 cwd=${cwd} prompt=${summarize(prompt)}`);

    const child = spawn(command, args, { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;

    // 收集 stderr（截尾保留最近 4000 字符），失败时附到错误信息里。
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });

    // 子进程启动失败或提前退出时，让主流程立刻失败而不是干等到超时。
    let failChild!: (error: Error) => void;
    const childFailed = new Promise<never>((_, reject) => {
      failChild = reject;
    });
    child.once("error", (error) => failChild(new Error(`opencode 进程启动失败: ${error.message}${stderr ? `\n${stderr}` : ""}`)));
    child.once("exit", (code, signal) =>
      failChild(new Error(`opencode 进程提前退出 (code=${code}, signal=${signal})${stderr ? `\n${stderr}` : ""}`)),
    );

    // 总超时：先协作式取消（SDK 会对进行中的请求发 $/cancel_request），宽限 5s 后硬失败。
    const controller = new AbortController();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        // 协作取消没生效（agent 不回应）时的兜底：硬失败。
        graceTimer = setTimeout(() => reject(new Error(`OpenCode 任务超时（${timeoutMs}ms）`)), 5000);
      }, timeoutMs);
    });
    const cancellationSignal = controller.signal;

    // stdio 建流：第一条是「写到子进程 stdin」，第二条是「从子进程 stdout 读」。
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );

    // 注册客户端处理器：拒绝一切权限；不声明 fs 能力，故 fs 请求正常不会来，来了就显式报错。
    const app = acp
      .client({ name: "qqbot" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        logger.warn(`[opencode] 拒绝权限请求: ${ctx.params.toolCall.title ?? ctx.params.toolCall.toolCallId}`);
        return decidePermission(ctx.params);
      })
      .onRequest(acp.methods.client.fs.readTextFile, () => {
        throw new Error("本客户端未声明 fs 能力，不应收到 fs/read_text_file");
      })
      .onRequest(acp.methods.client.fs.writeTextFile, () => {
        throw new Error("本客户端未声明 fs 能力，不应收到 fs/write_text_file");
      });

    try {
      const result = await Promise.race([
        app.connectWith(stream, async (ctx) => {
          // 只声明协议版本，不声明任何客户端能力（无 fs/terminal/elicitation）。
          const init = await ctx.request(
            acp.methods.agent.initialize,
            { protocolVersion: acp.PROTOCOL_VERSION },
            { cancellationSignal },
          );
          logger.debug(`[opencode] initialize 完成 protocol=${init.protocolVersion}`);

          const session = await ctx.buildSession(cwd).start({ cancellationSignal });
          logger.info(`[opencode] 会话 ${session.sessionId} 已建立`);
          try {
            // prompt 的响应给出 stopReason；readText 累积文本直到本轮结束。
            const promptPromise = session.prompt(prompt, { cancellationSignal });
            let text: string;
            try {
              text = await session.readText();
            } catch (error) {
              // readText 与 promptPromise 共享同一次失败，避免留下未处理的拒绝。
              await promptPromise.catch(() => undefined);
              throw error;
            }
            const response = await promptPromise;
            return { text, stopReason: response.stopReason };
          } finally {
            session.dispose();
          }
        }),
        childFailed,
        timeout,
      ]);

      // 协作取消可能在宽限期内正常返回 cancelled：这里统一按超时处理。
      if (timedOut) throw new Error(`OpenCode 任务超时（${timeoutMs}ms）`);

      let output = result.text.trim();
      if (output.length > maxOutputChars) output = `${output.slice(0, maxOutputChars)}\n…(结果已截断)`;
      // 非正常结束时把状态告知模型，避免它把不完整结果当成完整答案。
      if (result.stopReason !== "end_turn") output = `${output}\n[OpenCode 未正常结束: ${result.stopReason}]`.trim();
      if (!output) output = `OpenCode 没有返回内容（stopReason=${result.stopReason}）`;

      logger.info(
        `[opencode] 完成 用时=${Date.now() - startedAt}ms stop=${result.stopReason} 字符=${output.length}`,
      );
      return output;
    } catch (error) {
      if (timedOut) {
        logger.warn(`[opencode] 任务超时（${timeoutMs}ms），已取消`);
        throw new Error(`OpenCode 任务超时（${timeoutMs}ms）${stderr ? `\n${stderr}` : ""}`);
      }
      logger.warn(`[opencode] 任务失败: ${(error as Error).message}`);
      // 把 stderr 附到错误里（若子进程的失败信息未包含）。
      const message = (error as Error).message;
      throw stderr && !message.includes(stderr) ? new Error(`${message}\n${stderr}`) : error;
    } finally {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      this.dispose();
    }
  }
}
