/**
 * retry.ts —— 解析 OpenCode 经 ACP 上报的「模型重试」状态（纯逻辑，仅 type-only 依赖 SDK，便于单测）。
 *
 * 背景：opencode 在模型调用失败并排定重试时，会发一条 `session/update` 通知
 * `session_info_update`，并在 `_meta["opencode/retry"]` 里给出 `attempt`、`nextRetryAt`、
 * `error{type,message,status}`；重试真正开始时再发一条把该字段置为 null 的通知。
 * 这是 opencode 唯一会主动告知「内部正在重试/卡住」的通道（ACP 规范本身不保证别的 agent 会发）。
 *
 * 约束：
 * - `_meta` 在协议里是保留的扩展位，SDK 类型是 unknown，必须防御式解析；
 * - 解析结果显式区分 none / cleared / active / malformed，绝不把「解析不了」和「没有重试」混为一谈
 *   （malformed 会由调用方记日志，便于排查）。
 */
import type { SessionNotification } from "@agentclientprotocol/sdk";

/** 一条重试状态的解析结果。 */
export type RetryNotice =
  | { kind: "none" }
  | { kind: "cleared" }
  | {
      kind: "active";
      attempt: number;
      nextRetryAt?: string;
      errorType?: string;
      errorStatus?: number;
      errorMessage?: string;
    }
  | { kind: "malformed"; raw: unknown };

/** 在 `_meta` 对象里读取 `opencode/retry` 键：区分「键不存在」与「键存在但值为 null」。 */
function readRetryKey(meta: unknown): { present: false } | { present: true; value: unknown } {
  if (!meta || typeof meta !== "object") return { present: false };
  const record = meta as Record<string, unknown>;
  if (!("opencode/retry" in record)) return { present: false };
  return { present: true, value: record["opencode/retry"] };
}

/** 从 error 子对象里取 type/status/message（宽容，缺字段即 undefined）。 */
function readError(error: unknown): { type?: string; status?: number; message?: string } {
  if (!error || typeof error !== "object") return {};
  const record = error as Record<string, unknown>;
  return {
    type: typeof record.type === "string" ? record.type : undefined,
    status: typeof record.status === "number" ? record.status : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}

/**
 * 解析一条 ACP 通知里的重试状态。
 *
 * 只对 `session_info_update` 生效；`_meta` 优先看 update 自身（opencode 文档里的位置），
 * 其次看通知外层，两者都没有该键则返回 none。
 *
 * @param notification ACP 的 session/update 通知。
 * @returns none（不是 info 通知 / 没有该键）、cleared（值为 null）、
 *          active（对象，含容忍缺字段的解析结果）、或 malformed（键存在但既非 null 也非对象）。
 */
export function parseRetryNotice(notification: SessionNotification): RetryNotice {
  const update = notification.update as { sessionUpdate?: unknown; _meta?: unknown } | null | undefined;
  if (!update || update.sessionUpdate !== "session_info_update") return { kind: "none" };

  const fromUpdate = readRetryKey(update._meta);
  const found = fromUpdate.present ? fromUpdate : readRetryKey(notification._meta);
  if (!found.present) return { kind: "none" };
  if (found.value === null) return { kind: "cleared" };
  if (typeof found.value !== "object") return { kind: "malformed", raw: found.value };

  const record = found.value as Record<string, unknown>;
  const error = readError(record.error);
  return {
    kind: "active",
    attempt: typeof record.attempt === "number" ? record.attempt : 0,
    nextRetryAt: typeof record.nextRetryAt === "string" ? record.nextRetryAt : undefined,
    errorType: error.type,
    errorStatus: error.status,
    errorMessage: error.message,
  };
}

/**
 * 活跃重试的次数是否已超过容忍上限。
 *
 * @param notice parseRetryNotice 的结果。
 * @param max 容忍的重试次数（>=1）；attempt 严格大于它才算超限。
 */
export function retryExceeded(notice: RetryNotice, max: number): boolean {
  return notice.kind === "active" && notice.attempt > max;
}
