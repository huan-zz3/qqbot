/**
 * run_batch 的纯逻辑：项结构校验、逐项钳位、预算/总量派生、结果聚合排版。
 *
 * 不碰 socket：server.ts 下发前用它算参数，tools.ts 用它校验与合并回包。
 * 单独成文件是为了能单测「模型给了什么、我们到底发下去什么」。
 */

/** 一次批量的项数上限。硬编码：只挡失控输出，不需要可调旋钮。 */
export const MAX_BATCH_ITEMS = 16;

/** read_file 未指定 max_bytes 时的缺省值（256 KiB），与单条工具保持一致。 */
const DEFAULT_MAX_BYTES = 262_144;

/** 聚合头部里「目标」最多占的字符数（命令/路径都要压成一行）。 */
const TARGET_MAX_CHARS = 60;

export type BatchLimits = {
  /** 单条 psh 超时上限；模型传的 timeout_ms 会被钳到它。 */
  pshTimeoutMs: number;
  /** 单条输出字符上限；max_bytes 与整批总量都由它派生。 */
  maxOutputChars: number;
};

/** 服务端钳位后真正下发给客户端的项。 */
export type BatchItem =
  | { type: "psh"; command: string; timeout_ms: number }
  | { type: "read"; path: string; max_bytes: number };

/** 结构非法、就地判失败的项；index 是模型原始 items 的下标。 */
export type BatchFailure = { index: number; error: string };

export type BatchPlan =
  | { ok: false; error: string }
  | {
      ok: true;
      /** 原始项数：合并回包与头部 [i/N] 都用它，不能用 dispatch 长度。 */
      total: number;
      dispatch: { index: number; item: BatchItem }[];
      failures: BatchFailure[];
    };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** psh 超时钳位：非法值按上限处理，合法值夹到 [1000, max(pshTimeoutMs, 1000)]。 */
export function clampPshTimeoutMs(raw: unknown, pshTimeoutMs: number): number {
  const max = Math.max(pshTimeoutMs, 1000);
  const requested = typeof raw === "number" && Number.isFinite(raw) ? raw : max;
  return Math.min(Math.max(Math.trunc(requested), 1000), max);
}

/** read 字节数钳位：上限是 max(4×单条字符上限, 64KiB)，与单条工具一致。 */
export function clampMaxBytes(raw: unknown, maxOutputChars: number): number {
  const max = Math.max(4 * maxOutputChars, 65_536);
  const requested =
    typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_MAX_BYTES;
  return Math.min(Math.max(Math.trunc(requested), 1024), max);
}

/** 整批执行预算：给回包留 1 秒，避免客户端跑完最后一项时服务端已经超时。 */
export function batchBudgetMs(callTimeoutMs: number): number {
  return Math.max(1000, callTimeoutMs - 1000);
}

/** 整批输出上限：4 × 单条上限，不允许凭空常量。 */
export function batchMaxTotalChars(maxOutputChars: number): number {
  return 4 * maxOutputChars;
}

/**
 * 校验 items 并逐项钳位。
 * 非法项就地转成失败（不下发），其余照跑；items 本身非法则整批拒绝。
 */
export function planBatch(rawItems: unknown, limits: BatchLimits): BatchPlan {
  if (!Array.isArray(rawItems)) return { ok: false, error: "items 必须是数组" };
  if (rawItems.length === 0) return { ok: false, error: "items 不能为空" };
  if (rawItems.length > MAX_BATCH_ITEMS) {
    return {
      ok: false,
      error: `items 最多 ${MAX_BATCH_ITEMS} 项，收到 ${rawItems.length} 项`,
    };
  }

  const dispatch: { index: number; item: BatchItem }[] = [];
  const failures: BatchFailure[] = [];

  rawItems.forEach((raw, index) => {
    const record = asRecord(raw);
    const type = record.type;
    if (type === undefined || type === null || type === "") {
      failures.push({ index, error: "缺少 type，应为 psh 或 read" });
      return;
    }
    if (typeof type !== "string") {
      failures.push({ index, error: `未知指令类型：${String(type)}，应为 psh 或 read` });
      return;
    }
    if (type === "psh") {
      // 空白命令等于没给：让客户端跑一条空命令只会换来一个莫名退出码。
      const command = typeof record.command === "string" ? record.command : "";
      if (!command.trim()) {
        failures.push({ index, error: "psh 缺少 command" });
        return;
      }
      dispatch.push({
        index,
        item: {
          type: "psh",
          command,
          timeout_ms: clampPshTimeoutMs(record.timeout_ms, limits.pshTimeoutMs),
        },
      });
      return;
    }
    if (type === "read") {
      const path = typeof record.path === "string" ? record.path : "";
      if (!path.trim()) {
        failures.push({ index, error: "read 缺少 path" });
        return;
      }
      dispatch.push({
        index,
        item: { type: "read", path, max_bytes: clampMaxBytes(record.max_bytes, limits.maxOutputChars) },
      });
      return;
    }
    failures.push({ index, error: `未知指令类型：${type}，应为 psh 或 read` });
  });

  return { ok: true, total: rawItems.length, dispatch, failures };
}

/** 聚合排版的一项：头部工具名 + 目标，正文已由单条 formatter 生成。 */
export type BatchEntry = {
  tool: string;
  target: string;
  body: string;
};

/** 把命令/路径压成一行并截到 60 字符：聚合头部只留够认出是哪一条的信息。 */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function truncationNote(next: number, maxTotalChars: number): string {
  return `（第 ${next} 项起未展示：整批输出超过上限 ${maxTotalChars} 字符）`;
}

/**
 * 聚合多项结果并整批截断。
 * 只在项边界切：切掉半条输出会让模型把残片当成完整结果。
 */
export function formatBatch(entries: BatchEntry[], maxTotalChars: number): string {
  const total = entries.length;
  const blocks = entries.map(
    (entry, i) => `[${i + 1}/${total}] ${entry.tool}  ${oneLine(entry.target, TARGET_MAX_CHARS)}\n${entry.body}`,
  );
  const full = blocks.join("\n");
  if (full.length <= maxTotalChars) return full;

  const kept: string[] = [];
  let length = 0;
  for (const block of blocks) {
    const addition = (kept.length === 0 ? 0 : 1) + block.length;
    // 要留出末尾说明的位置；说明本身是「还有多少没显示」的唯一信号，不能被挤掉。
    const note = truncationNote(kept.length + 1, maxTotalChars);
    if (length + addition + 1 + note.length > maxTotalChars) break;
    length += addition;
    kept.push(block);
  }
  return [...kept, truncationNote(kept.length + 1, maxTotalChars)].join("\n");
}
