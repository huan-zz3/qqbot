/**
 * reply.test.ts —— 回复生成与发送规划（src/chat/reply.ts）单元测试。
 *
 * 覆盖：
 * - postProcess：空白输出、Markdown/名字前缀清理、按行成条、长度与条数上限、
 *   [表情包#编号] 标记解析；
 * - buildSystemPrompt / buildTranscript：提示词只列事实（表情包、记忆、搜索能力），
 *   聊天记录格式（时间、★ 待回应、bot 自称「你」）；
 * - planSends：短回复逐条发、长回复首条单发其余合并转发、表情包保留为普通消息；
 * - dropRepeatedEndings：近期用过两次的结尾 emoji/表情会被去掉。
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
const { postProcess, buildTranscript, buildSystemPrompt, planSends, dropRepeatedEndings } = await import(
  "../src/chat/reply.js"
);

// 简写构造文本回复段（ReplyPart 的 text 形态）。
const text = (value: string) => ({ kind: "text", text: value });

// 纯空白输出：解析结果为空数组（上层按异常处理、不发送）。
test("blank output yields nothing", () => {
  assert.deepEqual(postProcess("  ", "小猫"), []);
});

// 清洗：去掉行首「小猫：」自称前缀、**加粗**、## 标题；
// 列表符号「-」保留（它是正文的一部分）。
test("strips markdown and the name prefix", () => {
  const raw = "小猫：**好的**\n- 第一点\n## 标题";
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

// 系统提示词只交代事实：列出收藏表情（#3 猫猫叹气）、搜索能力、相关记忆；
// 边界：没有表情/记忆且不挂搜索时，提示词不得再出现这几类内容（不给示例句）。
test("system prompt lists stickers without prescribing style", () => {
  const ctx = {
    scope: "group" as const,
    sessionLabel: "测试群",
    botName: "小猫",
    personaIdentity: "是群里的一员。",
    personaRules: "",
    records: [],
    pending: new Set<never>(),
    stickers: [{ id: 3, description: "猫猫叹气" }],
    memories: ["李四：私聊里告诉你的：在北京工作"],
    now: Date.now(),
  };
  const prompt = buildSystemPrompt(ctx, [], true);
  assert.match(prompt, /你是「小猫」，是群里的一员。/);
  assert.match(prompt, /#3 猫猫叹气/);
  // 明确点出记录里的 [表情包：…] 是展示文字，避免模型照抄成正文。
  assert.match(prompt, /只是对表情的展示文字/);
  assert.match(prompt, /联网搜索/);
  assert.match(prompt, /- 李四：私聊里告诉你的：在北京工作/);
  assert.doesNotMatch(buildSystemPrompt({ ...ctx, stickers: [], memories: [] }, []), /表情包#|联网搜索|opencode|记得/);
  // 代码不再定死「怎么回/说多少/语气由你判断」这类行为授权。
  assert.doesNotMatch(prompt, /都由你自己判断/);
});

// 身份与准则分层：准则独立成段原样注入；身份为空时身份句以句号收尾、不产生悬挂标点；
// 两层都空时只有身份骨架，不产生空的准则段。
test("identity and rules render as separate layers", () => {
  const base = {
    scope: "group" as const,
    sessionLabel: "测试群",
    botName: "小猫",
    records: [],
    pending: new Set<never>(),
    stickers: [],
    memories: [],
    now: Date.now(),
  };
  const rules = "必须遵守：只回答游戏问题。";
  const withRules = buildSystemPrompt({ ...base, personaIdentity: "话不多。", personaRules: rules }, []);
  assert.match(withRules, /你是「小猫」，话不多。/);
  assert.match(withRules, /必须遵守的人设与行为准则：/);
  assert.match(withRules, /只回答游戏问题。/);
  // 身份为空：句号收尾。
  const noIdentity = buildSystemPrompt({ ...base, personaIdentity: "", personaRules: rules }, []);
  assert.match(noIdentity, /你是「小猫」。/);
  assert.doesNotMatch(noIdentity, /你是「小猫」，/);
  // 两层都空：无准则段标题。
  const empty = buildSystemPrompt({ ...base, personaIdentity: "", personaRules: "" }, []);
  assert.match(empty, /你是「小猫」。/);
  assert.doesNotMatch(empty, /必须遵守的人设与行为准则/);
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
    personaIdentity: "",
    personaRules: "",
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
// - 超限时首条文本一律单独发普通消息，从第二条起合并成一条转发；
// - 表情包仍作为普通消息单独发，排在转发之后；
// - 只有一条文本却超限时，该行直接单发，不产生转发。
test("short replies go line by line; long ones send the first line then merge the rest", () => {
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
  // 首行不论长短都单独发，其余进转发。
  assert.deepEqual(planSends([t(long), t("尾巴")]), [
    { kind: "part", part: t(long) },
    { kind: "forward", text: "尾巴" },
  ]);
  // 只有一条文本却超限：直接单发，不产生转发。
  assert.deepEqual(planSends([t(long)]), [{ kind: "part", part: t(long) }]);
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
