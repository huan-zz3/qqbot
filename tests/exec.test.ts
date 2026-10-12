/**
 * exec.test.ts —— 定时执行命令（src/exec/cron-exec.ts 的 CronExecutor）单元测试。
 *
 * 直接调用 run()（脱离 cron 到点），用真实 /bin/sh 命令验证：
 * - 正常：命令执行成功（以产生标记文件为凭据）；
 * - 失败：非零退出不抛错、正常 resolve（证明 cron 回调安全）；
 * - 重叠守卫：上一次未结束时再次 run 被跳过（命令只执行一次）；
 * - cron 非法：构造即抛错（index.ts 据此启动退出）。
 *
 * 注意：logger 经 config 读取 LOG_LEVEL，需先设 env 再动态 import。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.LOG_LEVEL = "silent";

const { CronExecutor } = await import("../src/exec/cron-exec.js");
type Deps = ConstructorParameters<typeof CronExecutor>[0];

// 用给定的任务建执行器；默认较短的超时与截断上限。
const make = (jobs: Deps["jobs"]) => new CronExecutor({ jobs, timeoutMs: 5000, maxOutputChars: 2000 });

test("run executes the shell command to completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const marker = join(dir, "done");
  const command = { index: 1, cron: "0 0 * * *", shell: `touch ${marker}` };
  const executor = make([command]);
  await executor.run(command);
  assert.ok(existsSync(marker));
  executor.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("a failing command does not throw", async () => {
  const command = { index: 1, cron: "0 0 * * *", shell: "exit 3" };
  const executor = make([command]);
  await executor.run(command);
  executor.dispose();
});

test("a run is skipped while the previous one is still executing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  const file = join(dir, "runs");
  const command = { index: 1, cron: "0 0 * * *", shell: `sleep 0.3; echo x >> ${file}` };
  const executor = make([command]);
  const first = executor.run(command);
  await executor.run(command); // 应被重叠守卫跳过
  await first;
  assert.equal(readFileSync(file, "utf8").trim(), "x");
  executor.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("an invalid cron expression throws at construction", () => {
  assert.throws(() => make([{ index: 1, cron: "not a cron", shell: "true" }]));
});
