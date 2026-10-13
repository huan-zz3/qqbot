/**
 * extract-rar.test.ts —— rar 解压驱动（src/chat/extract-rar.ts）单元测试。
 *
 * 用仓库里的真实 rar 夹具 tests/fixtures/FolderTest.rar（含中文名与嵌套目录），覆盖：
 * 正常解压、单文件超限被整包拒绝、非 rar 字节被判失败。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ArchiveRejected, type ExtractLimits } from "../src/chat/archive.js";
import { extractRar } from "../src/chat/extract-rar.js";

const FIXTURE = readFileSync(join("tests", "fixtures", "FolderTest.rar"));

const limits = (overrides: Partial<ExtractLimits> = {}): ExtractLimits => ({
  maxBytes: 64 * 1024 * 1024,
  maxEntries: 1000,
  maxFileBytes: 64 * 1024 * 1024,
  ...overrides,
});

// 正常解压：中文名与嵌套目录都按原样写出。
test("extractRar writes the nested fixture entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-rar-"));
  await extractRar(FIXTURE, dir, limits());
  const short = join(dir, "Folder1", "Folder 中文", "2中文.txt");
  assert.equal((await stat(short)).size, 15);
  assert.equal((await stat(join(dir, "Folder1", "Folder Space", "long.txt"))).size, 1049076);
  assert.equal(typeof (await readFile(short, "utf8")), "string");
});

// 单文件超限：整包拒绝（预检阶段即拦下）。
test("extractRar rejects an oversized entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-rar-"));
  await assert.rejects(() => extractRar(FIXTURE, dir, limits({ maxFileBytes: 10 })), ArchiveRejected);
});

// 非 rar 字节：判失败（非策略拒绝）。
test("extractRar fails on non-rar bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-rar-"));
  await assert.rejects(() => extractRar(Buffer.from("not a rar"), dir, limits()));
});
