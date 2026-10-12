/**
 * opencode-scheduler.test.ts —— src/opencode/scheduler.js 的 TaskScheduler 测试。
 *
 * 覆盖本次「会话内串行 + 全局并发上限」的核心调度语义：
 * - 同一 key 的任务永不并发（按提交顺序依次执行）；
 * - 不同 key 可并行，且全局运行数不超过构造上限；超上限按 FIFO 放行；
 * - 单个任务失败不影响同 key 后续任务，也不改变运行计数；
 * - 空 key 与非法并发上限都被明确拒绝（不静默退化）。
 *
 * scheduler 不依赖 config，用动态 import 与其它 opencode 测试保持一致。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { TaskScheduler } = await import("../src/opencode/scheduler.js");

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// 同一 key 三次任务：严格依次执行，无重叠。
test("same key runs strictly in submission order", async () => {
  const scheduler = new TaskScheduler(5);
  const log: string[] = [];
  let active = 0;
  const task = (name: string) => async () => {
    active++;
    assert.equal(active, 1, "同一 key 不应有并发");
    log.push(`start:${name}`);
    await tick();
    active--;
    log.push(`end:${name}`);
    return name;
  };
  const results = await Promise.all([
    scheduler.run("g", task("a")),
    scheduler.run("g", task("b")),
    scheduler.run("g", task("c")),
  ]);
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(log, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  assert.equal(scheduler.active, 0);
});

// 不同 key 可并行，峰值等于上限。
test("different keys run in parallel up to the limit", async () => {
  const scheduler = new TaskScheduler(3);
  let active = 0;
  let peak = 0;
  const task = () => async () => {
    active++;
    peak = Math.max(peak, active);
    await tick();
    active--;
  };
  await Promise.all([scheduler.run("a", task()), scheduler.run("b", task()), scheduler.run("c", task())]);
  assert.equal(peak, 3);
  assert.equal(scheduler.active, 0);
});

// 全局上限生效：超过上限的按提交顺序（FIFO）放行，运行数不超上限。
test("global limit caps concurrency and releases waiters in FIFO order", async () => {
  const scheduler = new TaskScheduler(2);
  const starts: string[] = [];
  let active = 0;
  let peak = 0;
  const task = (name: string) => async () => {
    active++;
    peak = Math.max(peak, active);
    starts.push(name);
    await tick();
    active--;
  };
  await Promise.all([
    scheduler.run("a", task("1")),
    scheduler.run("b", task("2")),
    scheduler.run("c", task("3")),
    scheduler.run("d", task("4")),
  ]);
  assert.equal(peak, 2);
  assert.deepEqual(starts, ["1", "2", "3", "4"]);
  assert.equal(scheduler.active, 0);
});

// 单任务失败不影响同 key 的后续任务，也不会卡住运行计数。
test("a failing task does not block later tasks for the same key", async () => {
  const scheduler = new TaskScheduler(1);
  await assert.rejects(
    scheduler.run("g", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await scheduler.run("g", async () => "ok"), "ok");
  assert.equal(scheduler.active, 0);
});

// 空 key 直接拒绝：不允许静默落到共享队列把不同会话并到一起。
test("empty key is rejected", async () => {
  const scheduler = new TaskScheduler(1);
  await assert.rejects(scheduler.run("", async () => "x"), /会话键/);
});

// 并发上限必须为正整数。
test("invalid concurrency is rejected", () => {
  assert.throws(() => new TaskScheduler(0), /正整数/);
  assert.throws(() => new TaskScheduler(-1), /正整数/);
  assert.throws(() => new TaskScheduler(1.5), /正整数/);
});
