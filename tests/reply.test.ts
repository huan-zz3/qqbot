/**
 * reply.test.ts —— 回复生成与发送规划（src/chat/reply.ts）及搜索文本清理
 * （src/search/web-search.ts 的 cleanSearchOutput）单元测试。
 *
 * 覆盖：
 * - postProcess：跳过标记、Markdown/名字前缀/引用标记清理、按行成条、长度与条数上限、
 *   [表情包#编号] 标记解析；
 * - buildSystemPrompt / buildTranscript：提示词只列事实（表情包、记忆、搜索能力），
 *   聊天记录格式（时间、★ 待回应、bot 自称「你」）；
 * - planSends：短回复逐条发、长回复合并转发、开头短句与表情包保留为普通消息；
 * - dropRepeatedEndings：近期用过两次的结尾 emoji/表情会被去掉；
 * - cleanSearchOutput：去掉 Codex 引用标记、压缩空行、超长截断。
 *
 * 注意：config.ts 在 import 时读取 process.env，上限配置必须在动态 import 前设置。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// 收紧各上限，方便一个小用例覆盖分条/转发/截断边界；import 后 config 已定型。
process.env.REPLY_MAX_PARTS = "3";
process.env.REPLY_MAX_CHARS = "20";
process.env.REPLY_FORWARD_PARTS = "2";
process.env.REPLY_FORWARD_CHARS = "30";

// 动态 import：让上面的 env 先于 config.ts 读取（静态 import 会被提升到赋值之前）。
const { postProcess, buildTranscript, buildSystemPrompt, planSends, dropRepeatedEndings, SKIP_MARKER } = await import(
  "../src/chat/reply.js"
);

// 简写构造文本回复段（ReplyPart 的 text 形态）。
const text = (value: string) => ({ kind: "text", text: value });
const { cleanSearchOutput } = await import("../src/search/web-search.js");

// 跳过标记：模型只输出 [不回复] 或纯空白时，解析结果为空数组（上层据此不发送）。
test("skip marker and empty output send nothing", () => {
  assert.deepEqual(postProcess(SKIP_MARKER, "小猫"), []);
  assert.deepEqual(postProcess("  ", "小猫"), []);
});

// 清洗：去掉行首「小猫：」自称前缀、**加粗**、## 标题和 Codex 引用标记；
// 列表符号「-」保留（它是正文的一部分）。
test("strips markdown, name prefix and citation markers", () => {
  const raw = "小猫：**好的**\n- 第一点\ue200cite\ue202turn0search0\ue201\n## 标题";
  assert.deepEqual(postProcess(raw, "小猫"), [text("好的"), text("- 第一点"), text("标题")]);
});

// 每行独立成条（REPLY_MAX_PARTS=3）——第 4 行被上限截掉；
// 单行超过 REPLY_MAX_CHARS=20 字符时截断并加省略号（上限只防失控输出）。
test("each line is a message; caps only guard against runaway output", () => {
  assert.deepEqual(postProcess("a\nb\nc\nd", "小猫"), [text("a"), text("b"), text("c")]);
  assert.deepEqual(postProcess("一".repeat(25), "小猫"), [text(`${"一".repeat(20)}…`)]);
});

// [表情包#编号] 解析成 sticker 段：紧跟文字之后、顺序保持；单独一行的标记也不丢。
test("sticker markers become sticker parts in order", () => {
  assert.deepEqual(postProcess("笑死[表情包#3]\n[表情包#12]", "小猫"), [
    text("笑死"),
    { kind: "sticker", id: 3 },
    { kind: "sticker", id: 12 },
  ]);
});

// 系统提示词只交代事实：列出收藏表情（#3 猫猫叹气）、可用 web_search、相关记忆；
// 边界：没有表情/记忆且不挂搜索时，提示词不得再出现这三类内容（不给示例句）。
test("system prompt lists stickers without prescribing style", () => {
  const ctx = {
    scope: "group" as const,
    sessionLabel: "测试群",
    botName: "小猫",
    persona: "是群里的一员。",
    records: [],
    pending: new Set<never>(),
    stickers: [{ id: 3, description: "猫猫叹气" }],
    memories: ["李四：私聊里告诉你的：在北京工作"],
    now: Date.now(),
  };
  const prompt = buildSystemPrompt(ctx, ["web_search"]);
  assert.match(prompt, /#3 猫猫叹气/);
  assert.match(prompt, /web_search/);
  assert.match(prompt, /- 李四：私聊里告诉你的：在北京工作/);
  assert.doesNotMatch(buildSystemPrompt({ ...ctx, stickers: [], memories: [] }, []), /表情包#|web_search|opencode|记得/);
});

// 搜索结果清理：去掉 \ue200cite\ue202turn0search0\ue201 这类 Codex 引用标记、
// 把连续 3 个以上空行压成一个、首尾去空白；超过 maxChars 时截断并附省略提示。
test("search output loses Codex citation markers", () => {
  const raw = "Title (https://x.y)\n\ue200cite\ue202turn0search0\ue202turn0search1\ue201 body\n\n\n\nend";
  assert.equal(cleanSearchOutput(raw), "Title (https://x.y)\n body\n\nend");
  assert.ok(cleanSearchOutput("x".repeat(20), 10).startsWith("xxxxxxxxxx\n…"));
});

// 聊天记录格式：bot 自己的消息标注「小猫（你）」并显示 [时:分]（Asia/Shanghai，
// UTC 11:05 → 19:05）；pending 里的新消息前加 ★，并用「→ 你」表示对象是 bot。
test("transcript stars pending messages and labels the bot", () => {
  const base = { messageId: 1, userId: 2, time: Date.UTC(2026, 8, 21, 11, 5), atBot: false, replyToBot: false, mentionsBot: false };
  const bot = { ...base, name: "小猫", text: "在的", fromBot: true };
  const user = { ...base, name: "张三", text: "你好", fromBot: false, atBot: true };
  const transcript = buildTranscript({
    scope: "group",
    sessionLabel: "测试群",
    botName: "小猫",
    persona: "",
    records: [bot, user],
    pending: new Set([user]),
    stickers: [],
    memories: [],
    now: Date.now(),
  });
  assert.match(transcript, /\[19:05\] 小猫（你）：在的/);
  assert.match(transcript, /★\[19:05\] 张三 → 你：你好/);
});

// 发送规划（REPLY_FORWARD_PARTS=2 / REPLY_FORWARD_CHARS=30）：
// - 短内容（≤2 段且 ≤30 字）逐段直接发送；
// - 超限时长段正文合并成一条转发，但开头短句（≤30 字）和表情包仍作为普通消息单独发；
// - 单段就超长时整段（含尾巴）一起进转发。
test("short replies go line by line; long ones become one merged forward", () => {
  const t = (value: string) => ({ kind: "text" as const, text: value });
  const sticker = { kind: "sticker" as const, id: 3 };
  assert.deepEqual(planSends([t("在的"), sticker]), [
    { kind: "part", part: t("在的") },
    { kind: "part", part: sticker },
  ]);
  assert.deepEqual(planSends([t("展开讲讲👇"), t("第一点"), t("第二点"), sticker]), [
    { kind: "part", part: t("展开讲讲👇") },
    { kind: "forward", text: "第一点\n第二点" },
    { kind: "part", part: sticker },
  ]);
  const long = "很长".repeat(20);
  assert.deepEqual(planSends([t(long), t("尾巴")]), [{ kind: "forward", text: `${long}\n尾巴` }]);
});

// 结尾去重：同一结尾 emoji/QQ 表情在最近 5 条里已用过两次才去掉，只用过一次保留；
// 同一条回复内先出现的也算（第三个 😂 被去掉）；去掉后会变空则原样保留；
// [图片] 这类非 QQ 表情的方括号结尾不算结尾表情，不参与去重。
test("an ending emoji or face used twice recently is dropped", () => {
  const t = (value: string) => ({ kind: "text" as const, text: value });
  const recent = ["查户口是吧😌", "在的", "熬夜是吧😌"];
  assert.deepEqual(dropRepeatedEndings([t("谁问你了😌"), t("行吧[doge]")], recent), [t("谁问你了"), t("行吧[doge]")]);
  assert.deepEqual(dropRepeatedEndings([t("好😌")], ["a😌"]), [t("好😌")]);
  assert.deepEqual(dropRepeatedEndings([t("一😂"), t("二😂"), t("三😂")], []), [t("一😂"), t("二😂"), t("三")]);
  assert.deepEqual(dropRepeatedEndings([t("😌")], ["a😌", "b😌"]), [t("😌")]);
  assert.deepEqual(dropRepeatedEndings([t("看[图片]")], ["x[图片]", "y[图片]"]), [t("看[图片]")]);
});
