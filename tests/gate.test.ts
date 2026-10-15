/**
 * gate.test.ts —— 发言判断（src/chat/gate.js）测试。
 *
 * 覆盖：
 * - decider 分数与阈值比较决定回不回；达到阈值时来源标记为 decider；
 * - 被 @ / 被回复时改用更低的 direct 阈值，但 decider 仍可否决（@ 不强制回复）；
 * - GATE_DIRECT_USERS 名单里的 QQ 被 @ / 被回复时视同 bot 自己，同样走 direct 阈值；
 * - needs_search 严格大于 0.1 才建议挂搜索；无 decider 的兜底路径一律挂；
 * - 没有硬性冷却：bot 刚发过言也由 decider 依据 state 里的活跃度自行权衡；
 * - buildState 把 bot 活跃度与 bot 自身消息标记整理进 decider 输入；
 * - decider 报错/缺失时走 fallback 硬规则：私聊、被 @、被回复、被点名且非纯反应才回；
 * - ctx.force（累计群消息到阈值）时无视 decider 分数强制回复，来源标 rule、搜索建议不变；
 * - isBareReaction 对纯反应/收尾消息的识别。
 *
 * 注意：阈值 env 必须在动态 import 之前设置（config.ts 在 import 时读取）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// 阈值必须在 import gate.js 之前设置：config.ts 在 import 时固化 env。
process.env.GATE_GROUP_THRESHOLD = "0.6";
process.env.GATE_PRIVATE_THRESHOLD = "0.35";
process.env.GATE_DIRECT_THRESHOLD = "0.3";
process.env.GATE_DIRECT_USERS = "10001,10002";
process.env.GATE_SEARCH_THRESHOLD = "0.1";
// should_reply 的正文 / true / false 完全取自这三项 env（代码无内置文案）。
process.env.GATE_REPLY_QUESTION_PROMPT = "reply whenever it feels natural.";
process.env.GATE_REPLY_TRUE_PROMPT = "add extra true guidance.";
process.env.GATE_REPLY_FALSE_PROMPT = "add extra false guidance.";

// 动态引入被测模块（env 已生效）。
const { decide, buildState, buildQuestions, isBareReaction } = await import("../src/chat/gate.js");
// 从 decide() 的参数类型取出 GateContext 与其消息元素 ChatRecord 类型。
type GateContext = Parameters<typeof decide>[0];
type ChatRecord = GateContext["pending"][number];

// 固定的「当前时间」，让相对时间与无冷却断言可复现。
const now = 1_800_000_000_000;

// 构造一条默认聊天记录（张三问「今天吃什么」），可逐字段覆盖。
function record(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    messageId: 1,
    userId: 2,
    name: "张三",
    text: "今天吃什么",
    time: now - 1000,
    // 默认不是 bot、没 @、没回复、没点名，具体场景由用例覆盖。
    fromBot: false,
    atBot: false,
    replyToBot: false,
    mentionsBot: false,
    ...overrides,
  };
}

// 构造一份默认群聊 GateContext：单条新消息、presence 0/1、无别名。
function context(overrides: Partial<GateContext> = {}): GateContext {
  return {
    scope: "group",
    sessionLabel: "测试群",
    botName: "小猫",
    aliases: [],
    earlier: [],
    pending: [record()],
    presence: { bot: 0, total: 1 },
    now,
    ...overrides,
  };
}

// 构造一个固定返回给定分数的假 decider。
const decider = (answers: Record<string, number>) => async () => answers;

/**
 * decider 分数与群聊阈值 0.6 比较：0.7 达到阈值 → 回复，来源 decider；
 * 0.5 低于阈值 → 不回复。addressed 只记录、不参与判定。
 */
test("decider score above threshold replies, below skips", async () => {
  const yes = await decide(context(), decider({ should_reply: 0.7, addressed: 0.2 }));
  // 0.7 ≥ 0.6：达到阈值回复。
  assert.equal(yes.reply, true);
  // 来源是 decider（而非兜底规则）。
  assert.equal(yes.source, "decider");

  const no = await decide(context(), decider({ should_reply: 0.5, addressed: 0.2 }));
  // 0.5 < 0.6：低于阈值不回复。
  assert.equal(no.reply, false);
});

/**
 * 被 @ / 被回复只是把阈值降到 direct 阈值（本测试设为 0.3），并不强制回复：
 * - @ 场景分数 0.4 ≥ 0.3 → 回复，scores.threshold 记录生效阈值 0.3；
 * - 被回复的纯收尾消息「哈哈哈」分数 0.1 < 0.3 → decider 仍可拒绝。
 */
test("@ or reply lowers the bar but decider can still decline", async () => {
  // 一条 @ 了 bot 的新消息。
  const pending = [record({ atBot: true, text: "@小猫 你怎么看" })];
  const yes = await decide(context({ pending }), decider({ should_reply: 0.4, addressed: 0.9 }));
  assert.equal(yes.reply, true);
  // 生效阈值是被 @ 时的 direct 阈值 0.3。
  assert.equal(yes.scores!.threshold, 0.3);

  // 回复了 bot，但内容是纯收尾的「哈哈哈」。
  const closing = [record({ replyToBot: true, text: "哈哈哈" })];
  const no = await decide(context({ pending: closing }), decider({ should_reply: 0.1, addressed: 0.8 }));
  // 0.1 低于 0.3，不回复。
  assert.equal(no.reply, false);
  // 拒绝也来自 decider（没有走兜底规则）。
  assert.equal(no.source, "decider");
});

/**
 * GATE_DIRECT_USERS 名单（本测试设为 10001,10002）里的 QQ 被 @ 或被回复时视同 bot 自己：
 * 生效阈值降到 direct 阈值 0.3；名单外的人被 @/回复仍是群聊阈值 0.6；
 * 有引用但作者 QQ 未知时不误判为 direct。
 */
test("watched QQ @ or reply uses the direct threshold", async () => {
  // @ 了名单里的 QQ。
  const atWatched = await decide(
    context({ pending: [record({ mentions: [10001], text: "@10001 你怎么看" })] }),
    decider({ should_reply: 0.4, addressed: 0.2 }),
  );
  assert.equal(atWatched.reply, true);
  // 生效阈值是 direct 阈值 0.3。
  assert.equal(atWatched.scores!.threshold, 0.3);

  // 回复的消息来自名单里的 QQ（作者 QQ 10002）。
  const replyWatched = await decide(
    context({ pending: [record({ quote: { name: "李四", text: "在吗", fromBot: false, userId: 10002 } })] }),
    decider({ should_reply: 0.4, addressed: 0.2 }),
  );
  assert.equal(replyWatched.reply, true);
  assert.equal(replyWatched.scores!.threshold, 0.3);

  // @ 了名单外的人：仍走群聊阈值 0.6，0.5 不回复。
  const other = await decide(
    context({ pending: [record({ mentions: [99999] })] }),
    decider({ should_reply: 0.5, addressed: 0.2 }),
  );
  assert.equal(other.reply, false);
  assert.equal(other.scores!.threshold, 0.6);

  // 有引用但作者 QQ 未知：不判为 direct，仍是群聊阈值 0.6。
  const unknown = await decide(
    context({ pending: [record({ quote: { name: "某人", text: "…", fromBot: false } })] }),
    decider({ should_reply: 0.5, addressed: 0.2 }),
  );
  assert.equal(unknown.scores!.threshold, 0.6);
});

/**
 * 无 decider 的兜底路径同样受益：@ 到名单里的 QQ 算信号，且有实义内容时可回复。
 */
test("watched QQ is a signal on the no-decider fallback path", async () => {
  const pending = [record({ mentions: [10001], text: "帮我看看这个报错" })];
  assert.equal((await decide(context({ pending }), undefined)).reply, true);
});

/**
 * needs_search 与搜索阈值 0.1 为严格大于关系：
 * 0.31 / 0.11 → 建议挂搜索；0.1 / 0.05 → 不挂；
 * 没有 decider 的兜底路径（decider 为 undefined）下一律建议挂搜索，搜不搜由模型决定。
 */
test("search tool is offered above a low needs_search score", async () => {
  // 固定其它分数高于阈值，只让 needs_search 变化。
  const at = (needs_search: number) => decider({ should_reply: 0.8, addressed: 0.8, needs_search });
  // 0.31 高于阈值 → 挂。
  assert.equal((await decide(context(), at(0.31))).search, true);
  // 0.11 仍高于阈值 → 挂。
  assert.equal((await decide(context(), at(0.11))).search, true);
  // 恰好等于 0.1 不算（判定是严格大于）。
  assert.equal((await decide(context(), at(0.1))).search, false);
  // 0.05 低于阈值 → 不挂。
  assert.equal((await decide(context(), at(0.05))).search, false);
  // 没有 decider 的兜底路径：搜索一律挂上，由模型决定搜不搜。
  assert.equal((await decide(context({ scope: "private" }), undefined)).search, true);
});

/**
 * 代码里没有硬性冷却：bot 2 秒前刚发过言、presence 显示它很活跃，
 * 只要 decider 分数 0.8 ≥ 群聊阈值 0.6 就照样回复——是否刷屏由 decider
 * 依据 state 里的 bot_activity 自己权衡。
 */
test("no hard cooldown: decider decides even right after the bot spoke", async () => {
  // bot 3/4 条发言、最近一次在 2 秒前。
  const presence = { bot: 3, total: 4, lastBotAt: now - 2000 };
  const decision = await decide(context({ presence }), decider({ should_reply: 0.8, addressed: 0.1 }));
  assert.equal(decision.reply, true);
  // 生效阈值仍是群聊 0.6（本条没有被 @/回复）。
  assert.equal(decision.scores!.threshold, 0.6);
});

/**
 * buildState 把 bot 活跃度整理成 decider 可见的 bot_activity：
 * 条数直接取 presence；距上次发言的秒数由 now - lastBotAt 四舍五入得出。
 */
test("bot activity is visible to decider", () => {
  // bot 30 秒前发过言，窗口统计为 bot 2 条 / 总共 9 条。
  const state = buildState(context({ presence: { bot: 2, total: 9, lastBotAt: now - 30_000 } })) as Record<string, any>;
  // 三个字段：窗口内 bot 条数、窗口内总条数、距上次发言秒数（30）。
  assert.deepEqual(state.bot_activity, {
    bot_messages_last_5min: 2,
    all_messages_last_5min: 9,
    seconds_since_bot_last_spoke: 30,
  });
});

/**
 * decider 报错或缺失时的兜底硬规则：
 * 只有私聊、被 @、被回复、被点名算信号，且整批不能全是纯反应消息。
 * - 群聊普通消息（无信号）→ 不回；mentionsBot → 回；私聊 → 回；
 * - decider 本身报错时决定来源标为 fallback；
 * - 「@小猫 帮我看看这个报错」有实义内容 → 回；
 * - 「@小猫 哈哈哈哈」是纯反应 → 不回（@ 不强制）；
 * - 私聊里的「好的谢谢」是收尾话 → 也不回。
 */
test("falls back to hard rules when decider fails or is missing", async () => {
  // 模拟 decider 调用抛错。
  const failing = async () => {
    throw new Error("boom");
  };
  // 群聊普通消息，无任何信号 → 不回复。
  assert.equal((await decide(context(), failing)).reply, false);
  // mentionsBot（点名）算信号 → 回复。
  assert.equal((await decide(context({ pending: [record({ mentionsBot: true })] }), failing)).reply, true);
  // 私聊本身算信号 → 回复。
  assert.equal((await decide(context({ scope: "private" }), undefined)).reply, true);
  // decider 报错走兜底，来源为 fallback。
  assert.equal((await decide(context(), undefined)).source, "fallback");
  // 构造 @ 了 bot 的单条消息上下文。
  const at = (text: string) => context({ pending: [record({ atBot: true, text })] });
  // @ + 有实际内容 → 回复。
  assert.equal((await decide(at("@小猫 帮我看看这个报错"), undefined)).reply, true);
  // @ + 纯反应 → 不回复。
  assert.equal((await decide(at("@小猫 哈哈哈哈"), undefined)).reply, false);
  // 私聊但内容是收尾话「好的谢谢」→ 不回复。
  assert.equal((await decide(context({ scope: "private", pending: [record({ text: "好的谢谢" })] }), undefined)).reply, false);
});

/**
 * isBareReaction：先去掉 @xxx 与空白/标点，剩余部分整串由
 * 「哈哈/草/6/嗯/好的/ok/谢谢/表情包名/问号串」等纯反应片段组成才算 true。
 * 反向：句子带实义内容（如「哈哈哈这个好笑在哪」）不算纯反应。
 */
test("bare reactions and closings are recognized", () => {
  // 正向：整串（去掉 @ 与标点后）都是纯反应。
  for (const text of ["哈哈哈", "@小猫 草", "666", "好的！", "嗯嗯", "ok", "谢谢~", "[表情包]", "？？"]) {
    assert.equal(isBareReaction(text), true, text);
  }
  // 反向：含实义内容，不是纯反应。
  for (const text of ["哈哈哈这个好笑在哪", "好的，那明天几点", "6点见", "为什么"]) {
    assert.equal(isBareReaction(text), false, text);
  }
});

/**
 * buildState 的消息条目：bot 自己的消息 from 标成「名字 (the bot itself)」，
 * 新消息带 at_bot / replies_to_bot / mentions_bot_name 等布尔标记；state.bot 只含 name/aliases。
 */
test("state marks the bot's own messages and flags", () => {
  // earlier 放一条 bot 消息，pending 放一条 @ 了 bot 的消息。
  const state = buildState(
    context({ earlier: [record({ fromBot: true, text: "我在" })], pending: [record({ atBot: true })] }),
  ) as Record<string, any>;
  // bot 消息的说话人被标注出自身身份，方便 decider 区分。
  assert.equal(state.earlier_messages[0].from, "小猫 (the bot itself)");
  // 新消息带 at_bot 标记。
  assert.equal(state.new_messages[0].at_bot, true);
  // state.bot 不再带 persona，只有身份与别名。
  assert.deepEqual(Object.keys(state.bot).sort(), ["aliases", "name"]);
});

/**
 * GATE_REPLY_QUESTION_PROMPT / _TRUE_PROMPT / _FALSE_PROMPT 是 should_reply 的
 * 正文 / criteria.true / criteria.false 的**唯一来源**：代码不再拼接任何内置文案。
 * 该覆盖只作用于 should_reply，不污染 addressed / needs_search。
 */
test("custom reply prompts are the sole source of the should_reply slots", () => {
  const questions = buildQuestions("小猫") as any;
  const should = questions.should_reply;
  // 正文逐字等于 env 值，不含内置英文底稿。
  assert.equal(should.instructions, "reply whenever it feels natural.");
  assert.doesNotMatch(should.instructions, /Should 小猫/);
  // true 标准逐字等于 env 值。
  assert.equal(should.criteria.true, "add extra true guidance.");
  assert.doesNotMatch(should.criteria.true, /new_messages call for a response/);
  // false 标准逐字等于 env 值。
  assert.equal(should.criteria.false, "add extra false guidance.");
  assert.doesNotMatch(should.criteria.false, /new_messages do not need anything/);
  // 其它两题不受影响（仍为通用英文文案）。
  assert.doesNotMatch(questions.addressed.instructions, /reply whenever it feels natural\./);
  assert.doesNotMatch(questions.needs_search.instructions, /add extra (?:true|false) guidance\./);
});

/**
 * 累计强制回复（ctx.force）：无论 decider 分数多低、甚至走兜底，都强制回复一次；
 * 来源标为 rule，搜索建议与原始分数仍照常来自判定（不被强制污染）。
 */
test("force replies regardless of the decider score and keeps the search suggestion", async () => {
  const forced = await decide(
    context({ force: { count: 5, threshold: 3 } }),
    decider({ should_reply: 0.1, addressed: 0.1, needs_search: 0.9 }),
  );
  // 0.1 远低于群聊阈值 0.6，但被强制回复。
  assert.equal(forced.reply, true);
  assert.equal(forced.source, "rule");
  assert.match(forced.reason, /forced \(5>=3\)/);
  // 搜索建议照常来自 decider（0.9 > 0.1 → 挂），原始分数保留供日志对照。
  assert.equal(forced.search, true);
  assert.equal(forced.scores!.reply, 0.1);

  // 相同分数、未强制时不回复。
  const normal = await decide(context(), decider({ should_reply: 0.1, addressed: 0.1, needs_search: 0.9 }));
  assert.equal(normal.reply, false);
  assert.equal(normal.source, "decider");

  // 无 decider 的兜底路径同样被强制（群聊普通消息本不回复）。
  const fb = await decide(context({ force: { count: 5, threshold: 3 } }), undefined);
  assert.equal(fb.reply, true);
  assert.equal(fb.source, "rule");
  assert.equal(fb.search, true);
});
