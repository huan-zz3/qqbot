/**
 * voice.test.ts —— 语音标记解析与切分（src/chat/voice.ts）单元测试。
 *
 * 覆盖：takeVoiceMarker（裸标记/带情绪/全角冒号/未知情绪/行中标记不命中/行首标记后第二个标记原样保留/无标记）、
 * cleanSpokenText（表情包标记、小黄脸、@、保留 (laughs)、折叠空白）、
 * planVoicePieces（短文本一条、多句合并、按逗号切、硬切、代理对不被拆开、空输入）。
 *
 * 纯函数模块，不依赖 config / env，直接静态 import。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanSpokenText, planVoicePieces, takeVoiceMarker, VOICE_EMOTIONS } from "../src/chat/voice.js";

test("takeVoiceMarker: bare marker yields no emotion", () => {
  assert.deepEqual(takeVoiceMarker("[语音]今天好累"), { text: "今天好累", emotion: undefined });
});

test("takeVoiceMarker: emotion is parsed case-insensitively with optional space", () => {
  assert.deepEqual(takeVoiceMarker("[语音:happy] 早啊"), { text: "早啊", emotion: "happy" });
  assert.deepEqual(takeVoiceMarker("[语音: SAD]早啊"), { text: "早啊", emotion: "sad" });
});

test("takeVoiceMarker: unknown emotion is dropped", () => {
  assert.deepEqual(takeVoiceMarker("[语音:excited]早啊"), { text: "早啊", emotion: undefined });
});

test("takeVoiceMarker: full-width colon is accepted", () => {
  assert.deepEqual(takeVoiceMarker("[语音：sad]早啊"), { text: "早啊", emotion: "sad" });
});

test("takeVoiceMarker: leading whitespace is allowed", () => {
  assert.deepEqual(takeVoiceMarker("   [语音:happy] 早啊"), { text: "早啊", emotion: "happy" });
});

test("takeVoiceMarker: marker in the middle of a line is not a marker", () => {
  assert.equal(takeVoiceMarker("你发的 [语音] 我没听清"), undefined);
});

test("takeVoiceMarker: only the leading marker is removed, later ones stay", () => {
  assert.deepEqual(takeVoiceMarker("[语音:calm]前半[语音]后半"), {
    text: "前半[语音]后半",
    emotion: "calm",
  });
});

test("takeVoiceMarker: no marker returns undefined", () => {
  assert.equal(takeVoiceMarker("普通的一句话"), undefined);
});

test("cleanSpokenText: strips sticker, face and at marks", () => {
  assert.equal(cleanSpokenText("[表情包#3] 你看@张三 [微笑] 这个"), "你看张三 这个");
});

test("cleanSpokenText: keeps unknown bracket text", () => {
  assert.equal(cleanSpokenText("[图片：一只猫]好看"), "[图片：一只猫]好看");
});

test("cleanSpokenText: keeps MiniMax tags and collapses whitespace", () => {
  assert.equal(cleanSpokenText("  (laughs)  好啊\n\n  走 "), "(laughs) 好啊 走");
});

test("planVoicePieces: short text stays one piece", () => {
  assert.deepEqual(planVoicePieces("今天天气不错", 45, 1), ["今天天气不错"]);
});

test("planVoicePieces: adjacent sentences merge within budget", () => {
  assert.deepEqual(planVoicePieces("你好。今天忙吗？", 45, 1), ["你好。今天忙吗？"]);
});

test("planVoicePieces: budget splits when merged text would overflow", () => {
  // 预算 = floor(1 * 4.5 * 1) = 4 字符。
  assert.deepEqual(planVoicePieces("一二三。四五六。", 1, 1), ["一二三。", "四五六。"]);
});

test("planVoicePieces: long single sentence splits at commas", () => {
  assert.deepEqual(planVoicePieces("一二三，四五六，", 1, 1), ["一二三，", "四五六，"]);
});

test("planVoicePieces: overlong clause is hard cut", () => {
  assert.deepEqual(planVoicePieces("一二三四五六七八", 1, 1), ["一二三四", "五六七八"]);
});

test("planVoicePieces: hard cut does not split surrogate pairs", () => {
  const pieces = planVoicePieces("一二三😀四五六七八", 1, 1);
  for (const piece of pieces) {
    assert.ok(Array.from(piece).every((ch) => !/^[\uD800-\uDFFF]$/.test(ch)), `孤立代理项: ${piece}`);
  }
});

test("planVoicePieces: empty input returns empty array", () => {
  assert.deepEqual(planVoicePieces("   ", 45, 1), []);
});

test("VOICE_EMOTIONS: lists known emotions in order", () => {
  assert.deepEqual([...VOICE_EMOTIONS], ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm"]);
});
