/**
 * build-sea.mjs —— 把 tsc 产物打成单文件可执行（Node SEA）
 *
 * 前提：先跑过 `tsc`（dist/index.js 已存在）。步骤：
 *   1. esbuild 把 dist/index.js 连同 node_modules 依赖汇成单文件 CJS；
 *   2. node --experimental-sea-config 生成 blob；
 *   3. 复制当前 node 二进制，用 postject 注入 blob。
 *
 * 产物：dist/qqbot。目标平台 = 当前机器（blob 与 node 二进制同平台）。
 * 运行不依赖 node_modules / tsc，但仍需 cwd 下的 data/ 与 .env/环境变量。
 */
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { inject } from "postject";

const require = createRequire(import.meta.url);
// node-unrar-js 的 WASM 主体：SEA 下无法按文件路径加载，必须作为资产嵌入，运行时用 node:sea 读取。
const UNRAR_WASM = require.resolve("node-unrar-js/dist/js/unrar.wasm");

const BUNDLE = "dist/qqbot.cjs";
const BLOB = "dist/qqbot.blob";
const CONFIG = "dist/sea-config.json";
const OUTPUT = "dist/qqbot";
// 配对 node 内置 SEA 的哨兵 fuse，固定值（见 Node 官方 SEA 文档）。
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

// 1. 汇成单文件 CJS（SEA 的 main 必须是 CommonJS）。
await build({
  entryPoints: ["dist/index.js"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: BUNDLE,
  // ws 的可选原生加速依赖，缺失时运行时自动降级，保持 external 免告警。
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "warning",
});

// 2. 生成 SEA blob。
const seaConfig = {
  main: BUNDLE,
  output: BLOB,
  disableExperimentalSEAWarning: true,
  // 嵌入 rar 解压所需的 WASM（运行时经 node:sea 的 getRawAsset("unrar.wasm") 取回）。
  assets: { "unrar.wasm": UNRAR_WASM },
};
writeFileSync(CONFIG, JSON.stringify(seaConfig));
const sea = spawnSync(process.execPath, ["--experimental-sea-config", CONFIG], { stdio: "inherit" });
if (sea.status !== 0) throw new Error("生成 SEA blob 失败");

// 3. 复制 node 二进制并注入 blob。
// postject 基于 wasm 解析 ELF note 段，会刷一堆 "Can't find string offset" 噪音；
// 这里过滤掉该已知前缀，其余告警照常透出。
copyFileSync(process.execPath, OUTPUT);
const warn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("warning: Can't find string offset")) return;
  warn(...args);
};
try {
  await inject(OUTPUT, "NODE_SEA_BLOB", readFileSync(BLOB), { sentinelFuse: SENTINEL });
} finally {
  console.warn = warn;
}
chmodSync(OUTPUT, 0o755);

console.log(`已生成 ${OUTPUT}`);
