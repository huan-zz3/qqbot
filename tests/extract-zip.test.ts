/**
 * extract-zip.test.ts —— zip 解压驱动（src/chat/extract-zip.ts）单元测试。
 *
 * 用 fflate 造 zip 夹具，覆盖：正常解压、路径穿越拒绝、条目数/单文件限额拒绝。
 * 驱动只写文件到调用方给的目录，因此直接给临时目录。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zipSync, strToU8 } from "fflate";

import { ArchiveRejected, type ExtractLimits } from "../src/chat/archive.js";
import { extractZip } from "../src/chat/extract-zip.js";

const limits = (overrides: Partial<ExtractLimits> = {}): ExtractLimits => ({
  maxBytes: 1024 * 1024,
  maxEntries: 100,
  maxFileBytes: 1024 * 1024,
  ...overrides,
});

// 正常解压：文件按相对路径写出。
test("extractZip writes entries to the destination", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-zip-"));
  const zip = zipSync({ "a.txt": strToU8("hi"), "dir/b.log": strToU8("hello") });
  await extractZip(Buffer.from(zip), dir, limits());
  assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "hi");
  assert.equal(await readFile(join(dir, "dir", "b.log"), "utf8"), "hello");
});

// 路径穿越：整包拒绝，且不写出任何文件。
test("extractZip rejects a path traversal entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-zip-"));
  const zip = zipSync({ "../evil.txt": strToU8("x") });
  await assert.rejects(() => extractZip(Buffer.from(zip), dir, limits()), ArchiveRejected);
  await assert.rejects(() => stat(join(dir, "..", "evil.txt")), /ENOENT/);
});

// 条目数超限：拒绝。
test("extractZip rejects too many entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-zip-"));
  const zip = zipSync({ "a.txt": strToU8("a"), "b.txt": strToU8("b") });
  await assert.rejects(() => extractZip(Buffer.from(zip), dir, limits({ maxEntries: 1 })), ArchiveRejected);
});

// 单文件超限：拒绝。
test("extractZip rejects an oversized entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-zip-"));
  const zip = zipSync({ "a.txt": strToU8("abcd") });
  await assert.rejects(() => extractZip(Buffer.from(zip), dir, limits({ maxFileBytes: 1 })), ArchiveRejected);
});
