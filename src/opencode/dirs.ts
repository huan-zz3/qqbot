/**
 * dirs.ts —— 解析/校验 OpenCode 可用的预定义仓库目录（纯逻辑，不依赖 ACP SDK，便于单测）。
 *
 * 背景：opencode 工具从「固定一个仓库」扩展为「一组预定义仓库，模型用短名选择」。
 * 短名清单有两个来源（见 config.ts）：
 * - OPENCODE_CWD：单个绝对路径，短名固定为 "default"（向后兼容旧部署）；
 * - OPENCODE_DIRS：追加列表，每项写成 `短名=绝对路径`，按逗号/空白切分。
 *
 * 设计约束（刻意保持最小，不要随意扩）：
 * - 只允许预定义短名，模型无法传任意路径；
 * - 任何不合法（缺 "="、空名/空路径、短名重复、路径非绝对或不存在）都直接抛错，
 *   绝不静默丢弃或自动改名——由 index.ts 转成启动失败，避免「配置写错却照跑」。
 */
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** 一个预定义仓库：短名 + 绝对路径。 */
export type DirEntry = { name: string; path: string };

/** OPENCODE_DIRS 里单个追加项的固定短名归属：OPENCODE_CWD 的别名。 */
export const DEFAULT_DIR_NAME = "default";

/** 按逗号（中/英文）或空白切分，去空白、丢弃空项（与 config.ts 的 list 同规则）。 */
function splitList(raw: string): string[] {
  return raw
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 路径是否是一个已存在的目录。 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 解析并校验目录集合。
 *
 * @param cwd OPENCODE_CWD 的原始值（可空）。
 * @param dirsRaw OPENCODE_DIRS 的原始值（可空）。
 * @returns 校验通过的目录列表（可能为空——是否要求非空由调用方决定）。
 * @throws 任一项不合法（缺 "="、空名/空路径、短名重复、路径非绝对或不存在）。
 */
export function parseDirs(cwd: string, dirsRaw: string): DirEntry[] {
  const entries: DirEntry[] = [];

  const primary = cwd.trim();
  if (primary) entries.push({ name: DEFAULT_DIR_NAME, path: primary });

  for (const item of splitList(dirsRaw)) {
    const eq = item.indexOf("=");
    if (eq < 0) throw new Error(`OPENCODE_DIRS 项缺少 "="（应为 短名=绝对路径）：${item}`);
    const name = item.slice(0, eq).trim();
    const path = item.slice(eq + 1).trim();
    if (!name) throw new Error(`OPENCODE_DIRS 项短名为空：${item}`);
    if (!path) throw new Error(`OPENCODE_DIRS 项路径为空：${item}`);
    entries.push({ name, path });
  }

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) throw new Error(`OpenCode 目录短名重复：${entry.name}`);
    seen.add(entry.name);
    if (!isAbsolute(entry.path)) throw new Error(`OpenCode 目录不是绝对路径：${entry.name}=${entry.path}`);
    if (!isDirectory(entry.path)) throw new Error(`OpenCode 目录不存在或不是目录：${entry.name}=${entry.path}`);
  }

  return entries;
}

/**
 * 按短名解析出绝对路径。
 *
 * @param dirs 已校验的目录列表。
 * @param name 模型指定的短名。
 * @returns 对应的绝对路径。
 * @throws 短名未知（错误文本列出全部合法短名）。
 */
export function resolveDir(dirs: ReadonlyArray<DirEntry>, name: string): string {
  const entry = dirs.find((dir) => dir.name === name);
  if (!entry) {
    const names = dirs.map((dir) => dir.name).join("、") || "（无）";
    throw new Error(`未知的 OpenCode 目录：${name}；可选：${names}`);
  }
  return entry.path;
}
