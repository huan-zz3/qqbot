/**
 * materials.test.ts —— 压缩包物料化编排（src/chat/materials.ts）单元测试。
 *
 * 用假下载与假解压驱动 + 临时目录，覆盖：成功落盘与清单、相对根目录规范化为绝对路径、
 * 非 UTF-8 文本转码、策略拒绝、运行失败、目录原子性（无 .tmp 残留）、按目录缓存（同请求只处理一次）、
 * 清理（TTL 到期删除）。不依赖 config，直接静态 import。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, isAbsolute, join } from "node:path";
import { test } from "node:test";

import { ArchiveRejected, type ArchiveRequest, type ExtractDriver } from "../src/chat/archive.js";
import { Materials, type MaterialsDeps, type MaterialsOptions } from "../src/chat/materials.js";

// 基础配置：目录由调用方指定，限额放大到不干扰测试。
function options(dir: string, overrides: Partial<MaterialsOptions> = {}): MaterialsOptions {
  return {
    dir,
    maxBytes: 1024 * 1024,
    limits: { maxBytes: 1024 * 1024, maxEntries: 100, maxFileBytes: 1024 * 1024 },
    keepMs: 60 * 60 * 1000,
    storeMaxBytes: 1024 * 1024 * 1024,
    sweepMs: 60 * 60 * 1000,
    ...overrides,
  };
}

// 固定请求：一条消息里的一个 zip。
function request(overrides: Partial<ArchiveRequest> = {}): ArchiveRequest {
  return {
    ref: { fileId: "f1", name: "logs.zip", size: 10, groupId: 500 },
    sessionKey: "group:500",
    userId: 7,
    messageId: 900,
    index: 0,
    ...overrides,
  };
}

// 假依赖：下载返回固定字节，驱动按预设行为写入文件或抛错。
function deps(driver: ExtractDriver, download?: (ref: { name: string }) => Promise<Buffer>): MaterialsDeps {
  return {
    download: download ?? (async () => Buffer.from("ZIPDATA")),
    drivers: { zip: driver, rar: async () => undefined },
  };
}

// 成功：文件落盘、清单含目录与文件名、无 .tmp 残留。
test("materialize extracts files, reports the manifest, and leaves no tmp dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-mat-"));
  const driver: ExtractDriver = async (_buffer, dest) => {
    await writeFile(join(dest, "app.log"), "line1\nline2\n");
  };
  const materials = new Materials(options(dir), deps(driver));
  const out = await materials.materialize([request()]);

  assert.equal(out.dirs.length, 1);
  assert.match(out.text, /logs\.zip → /);
  assert.match(out.text, /app\.log/);
  assert.equal(await readFile(join(out.dirs[0]!, "app.log"), "utf8"), "line1\nline2\n");
  const sessions = await readdir(join(dir, "group-500"));
  assert.deepEqual(sessions, ["u7-m900-0"]);
});

// 相对 FILES_DIR：解压根目录被规范化成绝对路径，返回的 dirs 与清单里的目录都必须是绝对路径
//（ACP 的 additionalDirectories 每项必须绝对，相对路径会被静默丢弃，导致 opencode 读不到解压目录）。
test("materialize resolves a relative root into an absolute path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-mat-"));
  // 传一个真正相对的路径（相对进程启动目录），确保走的是规范化逻辑。
  const relativeDir = relative(process.cwd(), dir);
  assert.equal(isAbsolute(relativeDir), false);
  const driver: ExtractDriver = async (_buffer, dest) => {
    await writeFile(join(dest, "a.log"), "hi");
  };
  const materials = new Materials(options(relativeDir), deps(driver));
  const out = await materials.materialize([request()]);

  const expected = join(dir, "group-500", "u7-m900-0");
  assert.equal(out.dirs.length, 1);
  assert.equal(isAbsolute(out.dirs[0]!), true);
  assert.equal(out.dirs[0], expected);
  // 清单里的目录也必须是绝对路径：模型会把它原样交给 opencode。
  assert.ok(out.text.includes(`→ ${expected}（`), `清单未包含绝对目录：${out.text}`);
  assert.equal(await readFile(join(out.dirs[0]!, "a.log"), "utf8"), "hi");
});

// 非 UTF-8 文本在落盘后就地转成 UTF-8，并在清单里标注。
test("materialize converts non UTF-8 text to UTF-8", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-mat-"));
  const driver: ExtractDriver = async (_buffer, dest) => {
    await writeFile(join(dest, "gbk.txt"), Buffer.from([0xd6, 0xd0, 0xce, 0xc4])); // "中文"(GB18030)
  };
  const materials = new Materials(options(dir), deps(driver));
  const out = await materials.materialize([request()]);

  assert.match(out.text, /gbk\.txt（已转 UTF-8）/);
  assert.equal(await readFile(join(out.dirs[0]!, "gbk.txt"), "utf8"), "中文");
});

// 策略拒绝：记拒绝并给出原因，不产生最终目录。
test("a rejected archive is reported without leaving a directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-mat-"));
  const driver: ExtractDriver = async () => {
    throw new ArchiveRejected("加密的 zip 条目：secret");
  };
  const materials = new Materials(options(dir), deps(driver));
  const out = await materials.materialize([request()]);

  assert.equal(out.dirs.length, 0);
  assert.match(out.text, /无法解压（加密的 zip 条目：secret）/);
  await assert.rejects(() => stat(join(dir, "group-500", "u7-m900-0")), /ENOENT/);
});

// 下载失败：记失败并给出原因。
test("a download failure is reported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-mat-"));
  const materials = new Materials(
    options(dir),
    deps(async () => undefined, async () => {
      throw new Error("下载失败 HTTP 404");
    }),
  );
  const out = await materials.materialize([request()]);
  assert.match(out.text, /读取失败（下载失败 HTTP 404）/);
});

// 缓存：同一请求重复物料化只处理一次（下载只调一次）。
test("materialize caches per archive directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-mat-"));
  let downloads = 0;
  const materials = new Materials(
    options(dir),
    deps(
      async (_buffer, dest) => {
        await writeFile(join(dest, "a.txt"), "hi");
      },
      async () => {
        downloads++;
        return Buffer.from("ZIPDATA");
      },
    ),
  );
  const first = await materials.materialize([request()]);
  const second = await materials.materialize([request()]);
  assert.equal(downloads, 1);
  assert.deepEqual(first.dirs, second.dirs);
});

// 清理：keepMs=0 时，下一轮扫描删除已存在的解压目录。
test("sweep removes directories past the keep window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-mat-"));
  const target = join(dir, "group-500", "u7-m900-0");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "a.txt"), "hi");
  const past = Date.now() - 10_000;
  await utimes(target, past / 1000, past / 1000);

  const materials = new Materials(options(dir, { keepMs: 0 }), deps(async () => undefined));
  await materials.sweep(Date.now());
  await assert.rejects(() => stat(target), /ENOENT/);
});

// 清理：启动时删除 .tmp 残留。
test("sweep removes leftover tmp directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-mat-"));
  const tmp = join(dir, "group-500", "u7-m900-0.tmp");
  await mkdir(tmp, { recursive: true });
  const materials = new Materials(options(dir), deps(async () => undefined));
  await materials.sweep(Date.now());
  await assert.rejects(() => stat(tmp), /ENOENT/);
});
