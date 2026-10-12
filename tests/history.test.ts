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

// 构造一条历史记录；speaker 传 "bot" 表示机器人自己发的。
function record(speaker: number | "bot", text: string) {
  const fromBot = speaker === "bot";
  return {
    userId: fromBot ? 100 : (speaker as number),
    name: fromBot ? "bot" : String(speaker),
    text,
    time: clock++,
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
