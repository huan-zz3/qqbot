/**
 * materials.ts —— 压缩包物料化编排：下载 → 解压 → 文本转码 → 原子落盘 → 缓存 → 清理。
 *
 * 触发时机：回复批构建时（「见包就提前解压」），对启用范围内每个压缩包各解压到一个
 * 独立目录，再把「目录 + 文件清单」交给回复提示词（见 chat/archive.ts 的 buildManifest）。
 *
 * 目录布局：`<root>/<会话段>/u<发送者>-m<消息id>-<序号>`；解压先写到 `<dir>.tmp`，
 * 全部校验通过后原子 rename 成最终目录——临时目录的存在即「未完成」，最终目录即「已完成」。
 *
 * 失败语义：任何异常都不吞——写 `[archive]` 日志，并在清单里以「拒绝/失败：原因」显式出现。
 * 策略违规抛 ArchiveRejected 记为拒绝，其余记为失败；二者都会删掉临时目录。
 *
 * 缓存：按最终目录路径缓存 Promise（成功、拒绝、失败都缓存），同批多次调用只处理一次。
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { logger } from "../logger.js";
import {
  ArchiveRejected,
  archiveDirName,
  archiveKindOf,
  buildManifest,
  isTextName,
  selectForCleanup,
  sessionDirName,
  type ArchiveRequest,
  type CleanupCandidate,
  type ExtractedFile,
  type ExtractDriver,
  type ExtractLimits,
  type MaterialResult,
} from "./archive.js";
import { decodeTextFile } from "./decode.js";
import type { FileRef } from "./files.js";

/** Materials 的运行参数（来自 config.files）。 */
export type MaterialsOptions = {
  /** 解压根目录（如 data/uploads）。 */
  dir: string;
  /** 单包下载字节上限。 */
  maxBytes: number;
  /** 解压限额。 */
  limits: ExtractLimits;
  /** 目录保留时长（毫秒）。 */
  keepMs: number;
  /** 磁盘总预算（字节），超出按最旧优先清理。 */
  storeMaxBytes: number;
  /** 定时清扫间隔（毫秒）。 */
  sweepMs: number;
};

/** 外部依赖（可注入假实现以便单测）：下载函数与各类型解压驱动。 */
export type MaterialsDeps = {
  /** 下载一个文件引用的完整字节；失败抛错。 */
  download: (ref: FileRef) => Promise<Buffer>;
  /** 按类型选择解压驱动。 */
  drivers: Record<"zip" | "rar", ExtractDriver>;
};

/** 物料化结果 + 本批可用目录（交给 opencode 作为 additionalDirectories）。 */
export type MaterialsOutput = { text: string; dirs: string[] };

export class Materials {
  // 最终目录路径 → 物料化任务；失败/拒绝同样缓存，避免同批反复重试。
  private readonly cache = new Map<string, Promise<MaterialResult>>();
  private timer: NodeJS.Timeout | undefined;
  // 解压根目录的绝对路径：清单要交给模型、目录要作为 opencode 的 additionalDirectories，
  // 两者都必须是绝对路径（ACP 规范：additionalDirectories 每项必须绝对，否则被静默丢弃）。
  private readonly root: string;

  constructor(
    private readonly options: MaterialsOptions,
    private readonly deps: MaterialsDeps,
  ) {
    // FILES_DIR 允许配成相对进程启动目录的值；这里统一规范化成绝对路径，避免下游拿到相对路径。
    this.root = resolve(options.dir);
  }

  /** 启动清理：立刻扫一遍，之后按 sweepMs 周期扫描。 */
  start(): void {
    void this.sweep().catch((error: Error) => logger.warn(`[archive] 清理失败: ${error.message}`));
    this.timer = setInterval(() => {
      void this.sweep().catch((error: Error) => logger.warn(`[archive] 清理失败: ${error.message}`));
    }, this.options.sweepMs);
  }

  /** 停止定时清扫（进程退出时调用）。 */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 逐个物料化本批压缩包（串行：RAR 解压会阻塞事件循环，避免并发叠加）。 */
  async materialize(requests: ArchiveRequest[]): Promise<MaterialsOutput> {
    const results: MaterialResult[] = [];
    for (const request of requests) results.push(await this.materializeOne(request));
    const dirs = results.filter((result): result is Extract<MaterialResult, { status: "ok" }> => result.status === "ok").map((result) => result.dir);
    return { text: buildManifest(results), dirs };
  }

  /** 单个包：目录确定后走缓存；未命中则创建任务并缓存。 */
  private materializeOne(request: ArchiveRequest): Promise<MaterialResult> {
    const name = request.ref.name;
    const kind = archiveKindOf(name);
    if (!kind) return Promise.resolve({ status: "failed", name, reason: "不是 zip/rar 压缩包" });
    if (!request.ref.fileId) return Promise.resolve({ status: "failed", name, reason: "缺少 file_id" });
    if (request.messageId === undefined) return Promise.resolve({ status: "failed", name, reason: "缺少消息 id" });
    const dir = join(
      this.root,
      sessionDirName(request.sessionKey),
      archiveDirName(request.userId, request.messageId, request.index),
    );
    const cached = this.cache.get(dir);
    if (cached) return cached;
    const task = this.run(request, kind, dir);
    this.cache.set(dir, task);
    return task;
  }

  /** 完整流程：下载 → 解压到 .tmp → 校验/转码 → 原子改名；任一步失败都删临时目录并给出原因。 */
  private async run(request: ArchiveRequest, kind: "zip" | "rar", dir: string): Promise<MaterialResult> {
    const { ref } = request;
    const name = ref.name;
    const tmp = `${dir}.tmp`;
    const startedAt = Date.now();
    try {
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true });
      const buffer = await this.deps.download(ref);
      logger.info(`[archive] ${name} 下载 bytes=${buffer.length}`);
      await this.deps.drivers[kind](buffer, tmp, this.options.limits);
      const files = await this.collect(tmp);
      // 旧目录（若上次同名残留）先删掉，再原子改名，保证目录要么完整要么不存在。
      await rm(dir, { recursive: true, force: true });
      await mkdir(dirname(dir), { recursive: true });
      await rename(tmp, dir);
      logger.info(
        `[archive] ${name} 解压完成 目录=${dir} 文件=${files.length} 用时=${Date.now() - startedAt}ms`,
      );
      return { status: "ok", name, dir, files };
    } catch (error) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      const reason = (error as Error).message || "未知错误";
      if (error instanceof ArchiveRejected) {
        logger.warn(`[archive] ${name} 拒绝：${reason}`);
        return { status: "rejected", name, reason };
      }
      logger.warn(`[archive] ${name} 失败：${reason}`);
      return { status: "failed", name, reason };
    }
  }

  /**
   * 遍历解压目录：校验无符号链接、统计文件、对文本类文件按多编码严格解码，
   * 命中非 UTF-8 就地重写为 UTF-8（记日志）。
   * @returns 相对路径 + 写盘后字节数 + 是否转码。
   */
  private async collect(root: string): Promise<ExtractedFile[]> {
    const files: ExtractedFile[] = [];
    await this.walk(root, root, files);
    return files;
  }

  private async walk(root: string, current: string, files: ExtractedFile[]): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const relative = full.slice(root.length + 1).split("\\").join("/");
      if (entry.isSymbolicLink()) throw new ArchiveRejected(`含符号链接：${relative}`);
      if (entry.isDirectory()) {
        await this.walk(root, full, files);
        continue;
      }
      if (!entry.isFile()) throw new ArchiveRejected(`含非常规文件：${relative}`);
      if (!isTextName(entry.name)) {
        files.push({ name: relative, bytes: (await stat(full)).size, converted: false });
        continue;
      }
      const bytes = await readFile(full);
      const decoded = decodeTextFile(bytes);
      if (decoded.status !== "text") {
        // 解不出文本（二进制或编码都不匹配）：保留原文件，如实按非文本记录。
        logger.warn(`[archive] ${relative} 文本解码失败（${decoded.reason}），保留原始字节`);
        files.push({ name: relative, bytes: bytes.length, converted: false });
        continue;
      }
      if (decoded.encoding !== "utf-8") {
        await writeFile(full, decoded.content, "utf8");
        logger.info(`[archive] ${relative} 以 ${decoded.encoding} 解码并转为 UTF-8`);
        files.push({ name: relative, bytes: Buffer.byteLength(decoded.content, "utf8"), converted: true });
        continue;
      }
      files.push({ name: relative, bytes: bytes.length, converted: false });
    }
  }

  /**
   * 清理：先删所有 `.tmp` 残留（上次崩溃遗留），再按 TTL 与磁盘预算删最终目录，最后清空的会话目录。
   */
  async sweep(now: number = Date.now()): Promise<void> {
    const root = this.root;
    let sessionDirs: string[];
    try {
      sessionDirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return; // 根目录还不存在：没什么可清。
    }
    const candidates: CleanupCandidate[] = [];
    for (const session of sessionDirs) {
      const sessionPath = join(root, session);
      for (const entry of await readdir(sessionPath, { withFileTypes: true })) {
        const full = join(sessionPath, entry.name);
        if (entry.name.endsWith(".tmp")) {
          await rm(full, { recursive: true, force: true });
          logger.info(`[archive] 清理临时目录 ${full}`);
          continue;
        }
        if (!entry.isDirectory()) continue;
        const info = await stat(full);
        candidates.push({ dir: full, mtimeMs: info.mtimeMs, bytes: await this.sizeOf(full) });
      }
    }
    const doomed = selectForCleanup(candidates, {
      now,
      keepMs: this.options.keepMs,
      storeMaxBytes: this.options.storeMaxBytes,
    });
    for (const target of doomed) {
      await rm(target, { recursive: true, force: true });
      logger.info(`[archive] 清理 ${target}`);
    }
    // 会话目录空了就删掉，避免长期积累空壳。
    for (const session of sessionDirs) {
      const sessionPath = join(root, session);
      if ((await readdir(sessionPath)).length === 0) await rm(sessionPath, { recursive: true, force: true });
    }
  }

  /** 递归求目录内文件总字节数。 */
  private async sizeOf(dir: string): Promise<number> {
    let total = 0;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) total += await this.sizeOf(full);
      else if (entry.isFile()) total += (await stat(full)).size;
    }
    return total;
  }
}
