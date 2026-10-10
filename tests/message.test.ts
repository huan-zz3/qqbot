/**
 * message.test.ts —— 消息段渲染与解析（src/napcat/message.ts）单元测试。
 *
 * 覆盖：toSegments（数组/字符串归一化）、renderSegments（text/at/image/face/markdown
 * 等段转成一行可读文本）、isAtSelf / replyTargetId / hasText / atTargets 辅助函数，
 * 以及 textToSegments（已知 QQ 表情名转 face、@群成员名字转真 @，名字可含空格）与
 * markdownToText（剥 LaTeX 样式、链接/图片语法）。
 *
 * 本文件直接用静态 import 引入纯函数模块（不依赖 config / env）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  atTargets,
  markdownToText,
  hasText,
  isAtSelf,
  renderSegments,
  replyTargetId,
  textToSegments,
  toSegments,
} from "../src/napcat/message.js";

// 渲染上下文：bot 自己是 100，名字为小猫。
const ctx = { selfId: 100, botName: "小猫" };

// 混合段渲染：reply 段不渲染；@自己显示 @小猫；image(sub_type 0) → [图片]；
// at 段带 name 用 name；face 14 → [微笑]。
// 辅助函数：isAtSelf 只认 qq 等于 selfId；replyTargetId 取引用段的消息 id 55。
test("renders text, at and media placeholders", () => {
  const segments = toSegments([
    { type: "reply", data: { id: "55" } },
    { type: "at", data: { qq: "100" } },
    { type: "text", data: { text: "你看这个" } },
    { type: "image", data: { sub_type: 0 } },
    { type: "at", data: { qq: "200", name: "张三" } },
    { type: "face", data: { id: "14" } },
  ]);
  assert.equal(renderSegments(segments, ctx), "@小猫 你看这个[图片]@张三 [微笑]");
  assert.equal(isAtSelf(segments, 100), true);
  assert.equal(isAtSelf(segments, 999), false);
  assert.equal(replyTargetId(segments), 55);
});

// 字符串形式的消息整体包成单个 text 段（CQ 码不解析）；
// hasText 判断是否含非空文本——纯图片消息为 false。
test("string messages become a single text segment", () => {
  const segments = toSegments("hello");
  assert.deepEqual(segments, [{ type: "text", data: { text: "hello" } }]);
  assert.equal(hasText(segments), true);
  assert.equal(hasText(toSegments([{ type: "image", data: {} }])), false);
});

// 特殊段：at qq="all" → @全体成员；image sub_type 1（收藏表情）→ [表情包]。
test("sticker images and @all", () => {
  const segments = toSegments([
    { type: "at", data: { qq: "all" } },
    { type: "image", data: { sub_type: 1 } },
  ]);
  assert.equal(renderSegments(segments, ctx), "@全体成员 [表情包]");
});

// 收到的 face 段按 ID 查名字表：179 → [doge]；未知 ID → 兜底占位 [表情]。
test("incoming faces render by name, unknown ids as a placeholder", () => {
  const segments = toSegments([
    { type: "face", data: { id: "179" } },
    { type: "face", data: { id: "99999" } },
  ]);
  assert.equal(renderSegments(segments, ctx), "[doge][表情]");
});

// 模型回复里的表情名转真表情：文字末尾的 [doge] 拆成 text + face(179)；
// 段首 [捂脸] 同理（id 264）；未知名字 [不存在的表情] 保持原文不转义。
test("known face names become face segments inline with text", () => {
  assert.deepEqual(textToSegments("难道你怀疑我是机器人？[doge]"), [
    { type: "text", data: { text: "难道你怀疑我是机器人？" } },
    { type: "face", data: { id: "179" } },
  ]);
  assert.deepEqual(textToSegments("[捂脸]不是吧[不存在的表情] ok"), [
    { type: "face", data: { id: "264" } },
    { type: "text", data: { text: "不是吧[不存在的表情] ok" } },
  ]);
  assert.deepEqual(textToSegments("没有表情"), [{ type: "text", data: { text: "没有表情" } }]);
});

// @ 他人只显示名字：优先 atName 回调（123456789 → 路人甲），查不到兜底「某人」，
// 绝不向模型暴露 QQ 号；atTargets 返回除自己以外的被 @ 者（含未知名字的 555）。
test("@ of other users shows a name, never the raw QQ number", () => {
  const segments = toSegments([
    { type: "at", data: { qq: "100" } },
    { type: "text", data: { text: "你还记得" } },
    { type: "at", data: { qq: "123456789" } },
    { type: "text", data: { text: "吗" } },
    { type: "at", data: { qq: "555" } },
  ]);
  const atName = (id: number) => (id === 123456789 ? "路人甲" : undefined);
  assert.equal(renderSegments(segments, { ...ctx, atName }), "@小猫 你还记得@路人甲 吗@某人");
  assert.deepEqual(atTargets(segments, 100), [123456789, 555]);
});

// markdown 段与等价的 fallback text 段同时在时只渲染一次（避免重复）；
// LaTeX 样式（多层嵌套的 \scalebox/\textcolor/\colorbox）全部剥掉只留文字；
// markdownToText 对 textcolor / \Huge / colorbox / 标题 / 加粗同样生效。
test("markdown messages render once, without LaTeX styling", () => {
  const latex = "$\\scalebox{5.0}{\\colorbox{black}{\\textcolor{white}{\\text{\\scalebox{6.0}{\\colorbox{black}{\\textcolor{white}{\\text{666}}}}}}}}$";
  const segments = toSegments([
    { type: "markdown", data: { content: latex } },
    { type: "text", data: { text: latex } },
  ]);
  assert.equal(renderSegments(segments, ctx), "666");
  assert.equal(markdownToText("$\\textcolor{#FC5C7D}{就}\\textcolor{#DF6496}{只}$"), "就只");
  assert.equal(markdownToText("$\\Huge 何\\Huge 意\\Huge 味$"), "何意味");
  assert.equal(markdownToText("$\\colorbox{#FF0000}{\\color{white}{红底白字}}$"), "红底白字");
  assert.equal(markdownToText("# 一级标题\n**正文**"), "一级标题\n正文");
});

// 有识图描述时带在占位符里：普通图 → [图片：一张截图]；收藏表情 → [表情包：猫猫叹气]。
test("pictures show their description when known", () => {
  const segments = toSegments([
    { type: "image", data: { sub_type: 0, file: "p" } },
    { type: "image", data: { sub_type: 1, file: "s" } },
  ]);
  const imageText = (seg: { data: Record<string, unknown> }) => (seg.data.file === "p" ? "一张截图" : "猫猫叹气");
  assert.equal(renderSegments(segments, { ...ctx, imageText }), "[图片：一张截图][表情包：猫猫叹气]");
});

// 模型回复写 @名字：名字表命中时转真 @ 段（并补一个空格文本作间隔）；
// 名字可含空格与 emoji，按最长匹配（@李四 命中李四而不是更短的李）；
// 邮箱里的 a@b.com 与未知的 @路人 保持原文。
test("@名字 of known members becomes a real mention; names may contain spaces", () => {
  const members = new Map([["李四", 42], ["🌟- PP( ˘ 🐽˘)❤", 77], ["李", 1]]);
  assert.deepEqual(textToSegments("@李四 处理什么[doge]", members), [
    { type: "at", data: { qq: "42" } },
    { type: "text", data: { text: " " } },
    { type: "text", data: { text: "处理什么" } },
    { type: "face", data: { id: "179" } },
  ]);
  assert.deepEqual(textToSegments("问问@🌟- PP( ˘ 🐽˘)❤", members), [
    { type: "text", data: { text: "问问" } },
    { type: "at", data: { qq: "77" } },
  ]);
  assert.deepEqual(textToSegments("邮箱a@b.com @路人", members), [{ type: "text", data: { text: "邮箱a@b.com @路人" } }]);
});

// markdown 里的 QQ 提及链接（mqqapi）与普通链接只留可点击文字；
// 图片语法 ![alt](url) 统一渲染成 [图片]。
test("markdown links and images render as plain text", () => {
  assert.equal(markdownToText("[@OvO](mqqapi://markdown/mention?at_type=1&at_tiny_id=1) 你好"), "@OvO 你好");
  assert.equal(markdownToText("看 ![star #20px](https://x/s.png) 和 [完整榜单](https://github.com/trending)"), "看 [图片] 和 完整榜单");
});

// 文件段：有文件名和大小 → [文件：名（大小）]；只有名字 → 不带大小；连名字都没有 → 兜底 [文件]。
// 大小按 B/KB/MB 人类可读化（formatSize 纯函数），且非正数/非数字不渲染大小。
test("file segments render name and size", () => {
  const segments = toSegments([
    { type: "file", data: { file: "报告.txt", file_size: 2048 } },
    { type: "file", data: { file: "log.txt", file_size: 512 } },
    { type: "file", data: { file: "无大小.txt" } },
    { type: "file", data: {} },
  ]);
  assert.equal(
    renderSegments(segments, ctx),
    "[文件：报告.txt（2.0KB）][文件：log.txt（512B）][文件：无大小.txt][文件]",
  );
});
