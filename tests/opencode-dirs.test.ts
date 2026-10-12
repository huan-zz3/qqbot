/**
 * opencode-dirs.test.ts —— src/opencode/dirs.js 的 parseDirs()/resolveDir() 测试。
 *
 * 覆盖（对应「多仓库切换」这个功能的核心校验，任一写错都不能静默照跑）：
 * - OPENCODE_CWD → 短名固定 default；OPENCODE_DIRS → 追加 短名=路径；
 * - 缺 "="、空名、空路径 → 抛错；
 * - 短名重复（含与 default 冲突）→ 抛错；
 * - 相对路径 / 不存在的目录 → 抛错；
 * - 合法时返回顺序与内容正确；
 * - resolveDir 命中返回路径、未命中抛错并列出可选短名。
 *
 * 纯逻辑，不依赖 ACP SDK。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { parseDirs, resolveDir, DEFAULT_DIR_NAME } = await import("../src/opencode/dirs.js");

// 两个真实存在的绝对目录，供存在性校验通过。
const repoA = mkdtempSync(join(tmpdir(), "opencode-dir-a-"));
const repoB = mkdtempSync(join(tmpdir(), "opencode-dir-b-"));

test("only OPENCODE_CWD becomes a single 'default' entry", () => {
  assert.deepEqual(parseDirs(repoA, ""), [{ name: DEFAULT_DIR_NAME, path: repoA }]);
  assert.equal(DEFAULT_DIR_NAME, "default");
});

test("only OPENCODE_DIRS parses 短名=路径 pairs", () => {
  assert.deepEqual(parseDirs("", `web=${repoA} api=${repoB}`), [
    { name: "web", path: repoA },
    { name: "api", path: repoB },
  ]);
});

test("CWD comes first, then the appended list", () => {
  assert.deepEqual(parseDirs(repoA, `web=${repoB}`), [
    { name: "default", path: repoA },
    { name: "web", path: repoB },
  ]);
});

test("empty config yields an empty list (caller decides if that is allowed)", () => {
  assert.deepEqual(parseDirs("", ""), []);
});

test("throws when an item has no '='", () => {
  assert.throws(() => parseDirs("", repoA), /缺少 "="/);
});

test("throws when the name is empty", () => {
  assert.throws(() => parseDirs("", `=${repoA}`), /短名为空/);
});

test("throws when the path is empty", () => {
  assert.throws(() => parseDirs("", "web="), /路径为空/);
});

test("throws on duplicate short names (including clash with default)", () => {
  assert.throws(() => parseDirs("", `web=${repoA} web=${repoB}`), /短名重复/);
  assert.throws(() => parseDirs(repoA, `default=${repoB}`), /短名重复/);
});

test("throws on a relative path", () => {
  assert.throws(() => parseDirs("", "web=./relative"), /不是绝对路径/);
});

test("throws when the path is not an existing directory", () => {
  assert.throws(() => parseDirs("", `web=${join(tmpdir(), "opencode-does-not-exist-xyz")}`), /不存在或不是目录/);
});

test("resolveDir returns the path for a known name", () => {
  const dirs = parseDirs(repoA, `web=${repoB}`);
  assert.equal(resolveDir(dirs, "web"), repoB);
  assert.equal(resolveDir(dirs, "default"), repoA);
});

test("resolveDir throws and lists valid names for an unknown name", () => {
  const dirs = parseDirs(repoA, `web=${repoB}`);
  assert.throws(() => resolveDir(dirs, "nope"), /未知的 OpenCode 目录：nope；可选：default、web/);
});
