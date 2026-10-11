/**
 * errors.ts —— 错误信息提取：把 undici `fetch failed` 藏在 cause 里的真实原因（code/message）
 * 一并带出，否则日志里只剩笼统的 `fetch failed`，无法排查。
 */

/** 提取错误信息；若错误带 cause（`fetch failed` 的常见形态），附带其 code/message。 */
export function errorText(error: unknown): string {
  const cause = (error as { cause?: unknown } | undefined)?.cause as
    | { code?: string; message?: string }
    | undefined;
  const base = error instanceof Error ? error.message : String(error);
  if (!cause) return base;
  const detail = cause.code ? `${cause.code}: ${cause.message ?? ""}`.trim() : cause.message;
  return detail ? `${base}（${detail}）` : base;
}
