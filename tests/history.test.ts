/**
 * history.test.ts —— SessionHistory.context() 的单元测试，重点覆盖「bot 补齐」规则。
 *
 * 规则：共享窗口（最后 overall 条）∪ 各发言账号逐账号保证（各自最近 perUser 条），
 * 再在已触及的范围（最旧选中下标 → 末尾）内把 bot 自己的消息补齐；比下界更旧的 bot 不进。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { SessionHistory } = await import("../src/chat/history.js");

let clock = 0;

// 构造一条历史记录；speaker 传 "bot" 表示机器人自己发的；time 缺省用自增时钟。
function record(speaker: number | "bot", text: string, time = clock++) {
  const fromBot = speaker === "bot";
  return {
    userId: fromBot ? 100 : (speaker as number),
    name: fromBot ? "bot" : String(speaker),
    text,
    time,
    fromBot,
    atBot: false,
    replyToBot: false,
    mentionsBot: false,
  };
}

// 建一个含指定记录的历史（上限放宽，避免裁剪干扰）。
function historyOf(speakers: (number | "bot")[]) {
  const history = new SessionHistory(100);
  for (const speaker of speakers) history.add(record(speaker, `${speaker}#${clock}`));
  return history;
}

const texts = (records: { text: string }[]) => records.map((r) => r.text);

test("补回落在逐账号空档里的 bot 消息", () => {
  // 0 bot / 1 B / 2 A / 3 B / 4 A / 5 bot / 6 B / 7 A
  const history = historyOf(["bot", 8, 7, 8, 7, "bot", 8, 7]);
  // overall=2 → 6,7；userIds=[7] perUser=2 → 7,4；min=4。
  const result = history.context(2, 2, [7]);
  // 下标 4,5,6,7：其中 5 是空档里的 bot，被补回。
  assert.deepEqual(
    result.map((r) => r.fromBot),
    [false, true, false, false],
  );
  assert.equal(result.length, 4);
});

test("比最旧选中更旧的 bot 消息不补", () => {
  // 同上序列，下标 0 的 bot 早于下界 4，不应出现。
  const history = historyOf(["bot", 8, 7, 8, 7, "bot", 8, 7]);
  const result = history.context(2, 2, [7]);
  assert.equal(result.filter((r) => r.fromBot).length, 1); // 只有下标 5 的 bot
  assert.equal(result[0]!.text, history.context(2, 2, [7])[0]!.text); // 下界未被前移
});

test("无 bot 记录时退化为原有稀疏选择", () => {
  // 0 A7 / 1 A8 / 2 A7 / 3 A8 / 4 A7
  const history = historyOf([7, 8, 7, 8, 7]);
  const result = history.context(2, 2, [7]);
  // overall=2 → 3,4；userIds=[7] perUser=2 → 4,2；结果 2,3,4。
  assert.equal(result.length, 3);
  assert.deepEqual(
    result.map((r) => r.userId),
    [7, 8, 7],
  );
  assert.ok(result.every((r) => !r.fromBot));
});

test("bot 已在共享窗口内时不重复", () => {
  // 0 A / 1 B / 2 bot / 3 A
  const history = historyOf([7, 8, "bot", 7]);
  // overall=3 → 1,2,3；userIds=[7] perUser=2 → 3,0；min=0，bot@2 已在集合内。
  const result = history.context(3, 2, [7]);
  assert.equal(result.length, 4);
  assert.equal(result.filter((r) => r.fromBot).length, 1);
});

test("perUser=0 / userIds 为空时补齐不新增记录", () => {
  // 0 bot / 1 A / 2 B / 3 A
  const dense = historyOf(["bot", 7, 8, 7]);
  // overall=2 → 2,3；无逐账号；min=2，bot@0 在下界外。
  assert.equal(dense.context(2, 0, [7]).length, 2);
  assert.equal(dense.context(2, 2, []).length, 2);
  assert.ok(dense.context(2, 2, []).every((r) => !r.fromBot));
});

test("空历史返回空", () => {
  const history = new SessionHistory(10);
  assert.deepEqual(history.context(5, 5, [7]), []);
});

// ---- 按时间裁剪（HISTORY_MAX_AGE_MS） ----

test("超过保留时长的记录在收到新消息时被清除", () => {
  const history = new SessionHistory(100, 1000);
  history.add(record(7, "a", 0), 0);
  history.add(record(8, "b", 500), 500);
  // now=3000、maxAge=1000 → cutoff=2000，a/b 过期，c 是新加入的
  history.add(record(7, "c", 3000), 3000);
  assert.deepEqual(texts(history.recent(10)), ["c"]);
});

test("只删除过期记录，未过期的保留且顺序不变", () => {
  const history = new SessionHistory(100, 1000);
  history.add(record(7, "old", 0), 0);
  history.add(record(8, "keep1", 1500), 1500);
  history.add(record(7, "keep2", 2200), 2200);
  // now=2500、cutoff=1500：只删 old；keep1 恰好在边界上保留。
  history.add(record(8, "new", 2500), 2500);
  assert.deepEqual(texts(history.recent(10)), ["keep1", "keep2", "new"]);
});

test("恰好在保留时长边界上的记录保留，超过 1ms 即删除", () => {
  const history = new SessionHistory(100, 1000);
  history.add(record(7, "edge", 0), 0);
  history.add(record(8, "within", 1), 1);
  // cutoff=1001：edge（now-time=1001）删除，within（999）保留。
  history.add(record(7, "new", 1001), 1001);
  assert.deepEqual(texts(history.recent(10)), ["within", "new"]);

  const boundary = new SessionHistory(100, 1000);
  boundary.add(record(7, "edge", 0), 0);
  // now-time 恰好等于 1000 → 保留。
  boundary.add(record(8, "new", 1000), 1000);
  assert.deepEqual(texts(boundary.recent(10)), ["edge", "new"]);
});

test("maxAgeMs=0 时不按时间裁剪（默认行为）", () => {
  const history = new SessionHistory(100);
  history.add(record(7, "a", 0), 0);
  history.add(record(8, "b", 10), 10_000_000);
  assert.deepEqual(texts(history.recent(10)), ["a", "b"]);
});

test("时间裁剪后 total 不减少，since(mark) 只返回保留部分", () => {
  const history = new SessionHistory(100, 1000);
  history.add(record(7, "a", 0), 0);
  history.add(record(7, "b", 100), 100);
  const mark = history.total;
  history.add(record(7, "c", 5000), 5000);
  assert.equal(history.total, 3);
  assert.deepEqual(texts(history.since(mark)), ["c"]);
});

test("新记录即使时间戳偏旧也不会在同一次 add 中被删除", () => {
  const history = new SessionHistory(100, 1000);
  history.add(record(7, "stale", 0), 5000);
  assert.deepEqual(texts(history.recent(10)), ["stale"]);
  // 下一条消息到达时才清掉它。
  history.add(record(7, "fresh", 6000), 6000);
  assert.deepEqual(texts(history.recent(10)), ["fresh"]);
});

test("时间上限与条数上限互相独立，谁先命中谁生效", () => {
  const history = new SessionHistory(3, 1000);
  history.add(record(7, "a", 0), 0);
  history.add(record(7, "b", 100), 100);
  history.add(record(7, "c", 200), 200);
  history.add(record(7, "d", 300), 300);
  // 条数上限先生效。
  assert.deepEqual(texts(history.recent(10)), ["b", "c", "d"]);
  // 时间上限把之前的记录全清掉。
  history.add(record(7, "e", 5000), 5000);
  assert.deepEqual(texts(history.recent(10)), ["e"]);
});

