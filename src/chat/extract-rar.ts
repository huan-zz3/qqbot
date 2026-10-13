/**
 * extract-rar.ts —— rar 解压驱动（node-unrar-js，官方 unrar 6.1.7 编 WASM）。
 *
 * 限制（已知并如实处理）：不支持多卷、不支持加密包（整包拒绝）；解压是同步 FS 写入，
 * 会短暂阻塞事件循环（配合条目数/字节限额，见 chat/materials.ts 的串行物料化）。
 *
 * 先在 getFileList 阶段把整包条目预检一遍（加密/多卷/危险名/超限），全部通过才真正解压，
 * 避免解到一半才发现问题。wasm 在 SEA 打包后从嵌入资产读取，开发模式由库自行加载。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSea, getRawAsset } from "node:sea";

import unrar from "node-unrar-js";

import { ArchiveRejected, checkEntryName, type ExtractDriver } from "./archive.js";

/** SEA 打包后从嵌入资产取 unrar.wasm；开发模式下返回 undefined，由库自行加载。 */
function wasmBinary(): ArrayBuffer | undefined {
  return isSea() ? getRawAsset("unrar.wasm") : undefined;
}

/** 把 Node Buffer 转成库要求的 ArrayBuffer（复制一份，避免共享底层池）。 */
function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

export const extractRar: ExtractDriver = async (buffer, destDir, limits) => {
  const extractor = await unrar.createExtractorFromData({ data: toArrayBuffer(buffer), wasmBinary: wasmBinary() });
  const list = extractor.getFileList();
  if (list.arcHeader.flags.volume) throw new ArchiveRejected("多卷 RAR 不支持");
  if (list.arcHeader.flags.headerEncrypted) throw new ArchiveRejected("加密的 RAR（文件头加密）");

  // 第一遍：全量预检，任何违规整包拒绝。
  let entries = 0;
  let total = 0;
  for (const header of list.fileHeaders) {
    if (header.flags.encrypted) throw new ArchiveRejected(`加密的 RAR 条目：${header.name}`);
    const checked = checkEntryName(header.name);
    if (!checked.ok) throw new ArchiveRejected(checked.reason);
    if (header.flags.directory) continue;
    entries++;
    if (entries > limits.maxEntries) throw new ArchiveRejected(`条目数超过 ${limits.maxEntries}`);
    if (header.unpSize > limits.maxFileBytes) {
      throw new ArchiveRejected(`单文件过大：${header.name} ${header.unpSize} > ${limits.maxFileBytes}`);
    }
    total += header.unpSize;
    if (total > limits.maxBytes) throw new ArchiveRejected(`解压总量超过 ${limits.maxBytes}`);
  }

  // 第二遍：真正解压并写出。目录条目只需建目录；文件条目此时按预检通过的名字落盘。
  const { files } = extractor.extract();
  for (const file of files) {
    const checked = checkEntryName(file.fileHeader.name);
    if (!checked.ok) throw new ArchiveRejected(checked.reason);
    const target = join(destDir, checked.normalized);
    if (file.fileHeader.flags.directory || file.extraction === undefined) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.extraction);
  }
};
