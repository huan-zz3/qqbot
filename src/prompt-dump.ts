/**
 * prompt-dump.ts —— 调试辅助：把实际送给 decider / 回复模型的请求体落盘成 JSON 文件，便于核对提示词。
 *
 * 唯一开关是 config.debug.promptDumpDir（PROMPT_DUMP_DIR）：为空即完全关闭（进入 I/O 前返回，零副作用、
 * 零日志）；非空则每次请求写一个文件，文件名含东八区时间戳、递增序号与类型标签（decider / llm）。
 *
 * 约束：
 * - 纯旁路：任何 I/O 异常都不得影响请求本身，模块内消化为 warn 日志，绝不向上抛出；
 * - 不静默：目录创建失败记一条 warn 并停用（不重复刷日志）；单次写入失败记一条 warn（含文件路径）；
 * - 请求体不含密钥（密钥走请求头），无需脱敏。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { errorText } from "./errors.js";
import { logger } from "./logger.js";

// 目录就绪状态：undefined = 尚未尝试，true = 已就绪，false = 创建失败（已告警，后续不再重试）。
let dirReady: boolean | undefined;
// 进程内递增序号，保证文件名唯一且可按「时间戳 + 序号」还原先后顺序。
let sequence = 0;

/** 东八区紧凑时间戳 `YYYYMMDD-HHmmss-SSS`，与日志时间同区，便于对照。 */
function stamp(time: number): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  // 中国无夏令时，UTC+8 恒定。
  const local = new Date(time + 8 * 60 * 60 * 1000);
  const date = `${local.getUTCFullYear()}${pad(local.getUTCMonth() + 1)}${pad(local.getUTCDate())}`;
  const clock = `${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}${pad(local.getUTCSeconds())}`;
  return `${date}-${clock}-${pad(local.getUTCMilliseconds(), 3)}`;
}

/**
 * 把一次请求的完整请求体落盘。目录未配置时不做任何事；落盘失败只记 warn，不影响调用方。
 * @param kind 类型标签（decider / llm），进文件名便于区分来源。
 * @param payload 请求体对象（会被缩进序列化）。
 */
export function dumpPrompt(kind: string, payload: unknown): void {
  const dir = config.debug.promptDumpDir;
  if (!dir) return;
  if (dirReady === undefined) {
    try {
      mkdirSync(dir, { recursive: true });
      dirReady = true;
    } catch (error) {
      dirReady = false;
      logger.warn(`[prompt-dump] 无法创建目录 ${dir}，提示词落盘停用：${errorText(error)}`);
      return;
    }
  }
  if (!dirReady) return;
  sequence += 1;
  const file = join(dir, `${stamp(Date.now())}-${String(sequence).padStart(4, "0")}-${kind}.json`);
  try {
    writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  } catch (error) {
    logger.warn(`[prompt-dump] 写入 ${file} 失败：${errorText(error)}`);
  }
}
