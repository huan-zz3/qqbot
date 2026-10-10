/**
 * logger.ts —— 按级别输出到控制台的最小日志封装
 *
 * 阈值来自 LOG_LEVEL（config.logLevel），非法或未设置时回退 info，silent 可完全静音。
 * 输出格式为 `YYYY-MM-DD HH:mm:ss [level] ...args`，时间固定按东八区显示；
 * error/warn 分别走 console.error/warn，其余走 console.log。
 * 参数原样交给控制台（不序列化、不做格式化）。
 */
import { config } from "./config.js";

// 级别数值：越大越严重；silent(100) 只是阈值，设成它等于不输出任何日志。
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
// 对外暴露的级别名；silent 不能用来发日志，故排除。
type Level = Exclude<keyof typeof LEVELS, "silent">;

// 模块加载时读一次 LOG_LEVEL 并固定；配错的值回退到 info。
const threshold = LEVELS[config.logLevel as keyof typeof LEVELS] ?? LEVELS.info;

/** 当前时间，格式化为东八区的 `YYYY-MM-DD HH:mm:ss`（sv-SE 区域设置恰好是这种格式）。 */
function timestamp(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
}

/** 内部输出：低于阈值丢弃；否则加时间戳前缀，按级别选择对应的 console 方法。 */
function emit(level: Level, args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const line = [`${timestamp()} [${level}]`, ...args];
  if (level === "error") console.error(...line);
  else if (level === "warn") console.warn(...line);
  else console.log(...line);
}

/** 全局日志器；阈值在模块加载时从 config 读取一次。 */
export const logger = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};
