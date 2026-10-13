/**
 * extract-zip.ts —— zip 解压驱动（yauzl，逐条流式，纯 JS，可进 esbuild/SEA）。
 *
 * 每条都先净化条目名、拒绝加密与符号链接，再按「条目数 / 单文件 / 总量」限额写出；
 * 实际写出字节再兜底一次（防止声明大小与实际不符）。策略违规抛 ArchiveRejected。
 */
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { fromBuffer, type Entry, type ZipFile } from "yauzl";

import { ArchiveRejected, checkEntryName, type ExtractDriver } from "./archive.js";

/** 释放一个 zip 条目到目标路径：流式写出并二次校验字节上限。 */
function writeEntry(zip: ZipFile, entry: Entry, target: string, maxFileBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`无法读取条目：${entry.fileName}`));
        return;
      }
      const out = createWriteStream(target);
      let written = 0;
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        stream.destroy();
        out.destroy();
        reject(err);
      };
      stream.on("data", (chunk: Buffer) => {
        written += chunk.length;
        if (written > maxFileBytes) fail(new ArchiveRejected(`条目实际字节超限：${entry.fileName}`));
      });
      stream.on("error", fail);
      out.on("error", fail);
      out.on("finish", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      stream.pipe(out);
    });
  });
}

export const extractZip: ExtractDriver = (buffer, destDir, limits) =>
  new Promise<void>((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) {
        reject(new Error(`无法打开 zip：${error?.message ?? "未知错误"}`));
        return;
      }
      let entries = 0;
      let total = 0;
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(err);
      };
      // 逐条处理：先净化与限额，再落盘，最后推进下一条。
      const handle = async (entry: Entry): Promise<void> => {
        if (entry.generalPurposeBitFlag & 0x1) throw new ArchiveRejected(`加密的 zip 条目：${entry.fileName}`);
        const checked = checkEntryName(entry.fileName);
        if (!checked.ok) throw new ArchiveRejected(checked.reason);
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((mode & 0xf000) === 0xa000) throw new ArchiveRejected(`含符号链接：${entry.fileName}`);
        const target = join(destDir, checked.normalized);
        if (entry.fileName.endsWith("/")) {
          await mkdir(target, { recursive: true });
          return;
        }
        entries++;
        if (entries > limits.maxEntries) throw new ArchiveRejected(`条目数超过 ${limits.maxEntries}`);
        if (entry.uncompressedSize > limits.maxFileBytes) {
          throw new ArchiveRejected(`单文件过大：${entry.fileName} ${entry.uncompressedSize} > ${limits.maxFileBytes}`);
        }
        total += entry.uncompressedSize;
        if (total > limits.maxBytes) throw new ArchiveRejected(`解压总量超过 ${limits.maxBytes}`);
        await mkdir(dirname(target), { recursive: true });
        await writeEntry(zip, entry, target, limits.maxFileBytes);
      };
      zip.on("error", (err: Error) => {
        // yauzl 自带的文件名校验也会拦下路径穿越；归为策略拒绝（而非运行失败）。
        if (/invalid relative path/i.test(err.message)) fail(new ArchiveRejected(`危险条目路径：${err.message}`));
        else fail(new Error(`zip 读取失败：${err.message}`));
      });
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zip.on("entry", (entry: Entry) => {
        handle(entry)
          .then(() => {
            if (!settled) zip.readEntry();
          })
          .catch(fail);
      });
      zip.readEntry();
    });
  });
