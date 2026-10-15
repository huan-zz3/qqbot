/**
 * gate.ts —— 发言判断：决定「这一刻该不该说话」，以及要不要给模型挂联网搜索。
 *
 * 主路径：把会话快照（聊天场景、机器人身份与活跃度、旧消息 earlier、新消息 pending）打包成
 * decider 的 state，并问三个是非题（buildQuestions）：
 * - should_reply：概率达到阈值才发言。阈值分档：被 @/被回复用 directThreshold（默认 0.45），
 *   否则群聊用 groupThreshold（0.6）、私聊用 privateThreshold（0.35）；GATE_DIRECT_USERS 名单里的
 *   QQ 被 @ 或被回复时视同 bot 自己，同样归入 direct（见 isDirect）。
 *   GATE_REPLY_QUESTION_PROMPT / GATE_REPLY_TRUE_PROMPT / GATE_REPLY_FALSE_PROMPT 三项分别是
 *   should_reply 正文 / true / false 的**唯一来源**（代码不再拼接内置文案），用于说明「什么情况下该回复」；
 * - addressed：是不是在跟机器人说话，只记进日志便于调参，不参与判定；
 * - needs_search：高于 config.gate.searchThreshold（默认 0.1）就建议挂联网搜索工具，
 *   挂不挂得上还要看凭证是否可用（runtime.ts），真搜不搜由模型自己决定。
 *
 * 兜底路径：decider 不可用或调用报错时走 fallback——只认直接指向 bot 的信号（被 @、被回复、
 * GATE_DIRECT_USERS 命中），正文点名、私聊、纯反应均不触发；搜索则一律挂上，交给模型判断。
 * GATE_DIRECT_USERS 名单里的 QQ 被 @/被回复也视同 bot 自己（direct），两条路径一致生效。
 *
 * 强制路径：runtime 在某个群累计的未回复消息达到 GATE_FORCE_REPLY_MESSAGES 时，通过 ctx.force
 * 要求本轮强制回复一次——判定照常进行（搜索建议不变），只把回复结论置为 true（来源标为 rule）。
 *
 * 关键约束：@ 和被回复只是**降低阈值**的提示，绝不强制回复；机器人最近一段时间的活跃度
 * 也放进 state 交给 decider 自己权衡，代码里没有硬性冷却。
 */
import { noul, type DeciderQuestions, type DeciderState, type JsonValue } from "../decider/questions.js";

import { config } from "../config.js";
import { createDecider, type Decider } from "../decider/client.js";
import { relation, type ChatRecord, type Presence, type Scope } from "./history.js";

// Decider 已移到中立模块以便群管理复用；这里重新导出，兼容既有导入方。
export { createDecider };
export type { Decider };

/** decide() 的输入：一次判断所需的全部会话快照。 */
export type GateContext = {
  scope: Scope; // 群聊还是私聊
  sessionLabel: string; // 会话显示名（群名/对方昵称）
  botName: string; // 机器人名字
  aliases: string[]; // 别名列表
  earlier: ChatRecord[]; // 本批之前的上下文消息
  pending: ChatRecord[]; // 本批新消息（判断的对象）
  presence: Presence; // 最近窗口内的活跃度统计
  now: number; // 当前时间戳（毫秒），用于相对时间
  // 累计强制回复：本批所在群已累计足够多未回复消息时由 runtime 传入，判定层据此强制回复一次。
  // count 为该群当前累计条数、threshold 为触发条数，仅用于日志展示。
  force?: { count: number; threshold: number } | undefined;
};

/** decider 给出的原始概率与当次生效的阈值（写进日志便于调参）。 */
export type GateScores = {
  reply: number;
  addressed: number;
  search: number;
  threshold: number;
};

/** 判断结果。 */
export type GateDecision = {
  reply: boolean;
  // 是否给模型挂联网搜索工具；真搜不搜仍由模型自己决定。
  search: boolean;
  reason: string; // 简短理由（进日志）
  source: "rule" | "decider" | "fallback"; // 决定来源
  scores?: GateScores; // 仅 decider 路径有
};

/** 把时间戳转成 decider 输入里的相对时间文案（just now / 30s ago / 5min ago / 2h ago）。 */
function relativeTime(time: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}min ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** 把一条聊天记录转成 decider state 里的条目对象（说话人、时间、对谁、引用、@ 标记）。 */
function describe(record: ChatRecord, ctx: GateContext): JsonValue {
  const entry: Record<string, JsonValue> = {
    from: record.fromBot ? `${ctx.botName} (the bot itself)` : record.name,
    text: record.text,
    when: relativeTime(record.time, ctx.now),
  };
  const { to, quote } = relation(record, ctx.botName);
  // 可选字段只在有值时才写入。
  if (to.length > 0) entry.to = to;
  if (quote) entry.quoting = quote;
  if (record.atBot) entry.at_bot = true;
  if (record.replyToBot) entry.replies_to_bot = true;
  if (record.mentionsBot) entry.mentions_bot_name = true;
  return entry;
}

/** 组装 decider 的 state：聊天场景、机器人身份与活跃度、旧消息与本批新消息。 */
export function buildState(ctx: GateContext): DeciderState {
  const sinceBot = ctx.presence.lastBotAt === undefined ? null : Math.round((ctx.now - ctx.presence.lastBotAt) / 1000);
  return {
    chat: ctx.scope === "group" ? `QQ group "${ctx.sessionLabel}"` : `QQ private chat with ${ctx.sessionLabel}`,
    bot: { name: ctx.botName, aliases: ctx.aliases },
    // 机器人最近窗口（默认 5 分钟，GATE_PRESENCE_WINDOW_MS）内的活跃度：让它自己权衡会不会刷屏，代码不做硬性冷却。
    bot_activity: {
      bot_messages_last_5min: ctx.presence.bot,
      all_messages_last_5min: ctx.presence.total,
      seconds_since_bot_last_spoke: sinceBot,
    },
    earlier_messages: ctx.earlier.map((record) => describe(record, ctx)),
    new_messages: ctx.pending.map((record) => describe(record, ctx)),
  };
}

/**
 * 构造 decider 的三个是非题。should_reply 的正文 / true / false 只取 env 配置
 * （config.gate.replyPrompt），代码不含内置文案；非空由 index.ts 启动时保证。
 * addressed 与 needs_search 为通用英文文案，不参与 env 覆盖。
 */
export function buildQuestions(botName: string): DeciderQuestions {
  const { question, true: whenTrue, false: whenFalse } = config.gate.replyPrompt;
  return {
    should_reply: noul(question, { true: whenTrue, false: whenFalse }),
    addressed: noul(`new_messages are directed at ${botName} and expect it to respond.`),
    needs_search: noul(`A good reply to new_messages depends on up-to-date or specific facts that should be looked up on the web.`),
  };
}

/**
 * 本条消息是否「直接指向」bot：被 @ 或被回复。GATE_DIRECT_USERS 名单里的 QQ 被 @ 或被回复时
 * 视同 bot 自己。decide 的阈值与 runtime 的防抖时长共用此判定，语义保持一致。
 * @param record 消息记录
 */
export function isDirect(record: ChatRecord): boolean {
  if (record.atBot || record.replyToBot) return true;
  const watched = config.gate.directUsers;
  if (watched.size === 0) return false;
  // 本条 @ 到了名单里的某人；或本条回复的消息来自名单里的某人（作者 QQ 未知时无从判断）。
  if (record.mentions?.some((id) => watched.has(id))) return true;
  return record.quote?.userId !== undefined && watched.has(record.quote.userId);
}

/**
 * 判断该不该发言。先按正常规则判定，再按 ctx.force 覆盖回复结论：
 * 累计消息达到阈值的群无条件回复一次（来源标为 rule，搜索建议与原始分数仍保持判定结果）。
 * @param ctx 会话快照。
 * @param decider decider 判定器；undefined 表示走兜底。
 */
export async function decide(ctx: GateContext, decider: Decider | undefined): Promise<GateDecision> {
  const decision = await evaluate(ctx, decider);
  if (!ctx.force) return decision;
  // 只覆盖「回不回」；搜索建议照常来自判定，便于日志对照真实分数与强制的偏离。
  return {
    ...decision,
    reply: true,
    source: "rule",
    reason: `${decision.reason}; forced (${ctx.force.count}>=${ctx.force.threshold})`,
  };
}

/**
 * 正常判定：decider 可用时问三个是非题并按当前阈值判定（被 @/被回复时改用 directThreshold）；
 * decider 缺失或调用报错时切到规则兜底。返回值同时携带搜索建议与分数（供日志/调参）。
 */
async function evaluate(ctx: GateContext, decider: Decider | undefined): Promise<GateDecision> {
  // @ 和回复只是降低门槛；最终仍由 decider 结合机器人近期活跃度判断。
  const direct = ctx.pending.some(isDirect);

  if (decider) {
    try {
      const answers = await decider(buildState(ctx), buildQuestions(ctx.botName));
      // 概率字段缺失时按 0 处理。
      const reply = answers.should_reply ?? 0;
      const addressed = answers.addressed ?? 0;
      const search = answers.needs_search ?? 0;
      // 被 @/被回复用 directThreshold，否则按群聊/私聊各自的阈值。
      const threshold = direct
        ? config.gate.directThreshold
        : ctx.scope === "group"
          ? config.gate.groupThreshold
          : config.gate.privateThreshold;
      const yes = reply >= threshold;
      return {
        reply: yes,
        // 搜索门槛很低（默认 0.1）：宁可挂上工具，由模型决定是否真调用。
        search: search > config.gate.searchThreshold,
        reason: `${direct ? "direct, " : ""}decider ${yes ? "yes" : "no"}`,
        source: "decider",
        scores: { reply, addressed, search, threshold },
      };
    } catch (error) {
      return fallback(direct, `decider error: ${(error as Error).message}`);
    }
  }
  return fallback(direct, "no decider");
}

/**
 * 规则兜底：没有 decider 时只认直接指向 bot 的信号（被 @、被回复、GATE_DIRECT_USERS 命中）。
 * 搜索一律挂上，交给模型判断。
 */
function fallback(direct: boolean, why: string): GateDecision {
  return { reply: direct, search: true, reason: why, source: "fallback" };
}
