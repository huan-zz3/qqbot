/**
 * gate.ts —— 发言判断：决定「这一刻该不该说话」，以及要不要给模型挂联网搜索。
 *
 * 主路径：把会话快照（聊天场景、机器人身份与活跃度、旧消息 earlier、新消息 pending）打包成
 * TypeSafe（jev）的 state，并问三个是非题（buildQuestions）：
 * - should_reply：概率达到阈值才发言。阈值分档：被 @/被回复用 directThreshold（默认 0.45），
 *   否则群聊用 groupThreshold（0.6）、私聊用 privateThreshold（0.35）；
 * - addressed：是不是在跟机器人说话，只记进日志便于调参，不参与判定；
 * - needs_search：高于 config.gate.searchThreshold（默认 0.1）就建议挂 web_search 工具，
 *   挂不挂得上还要看凭证是否可用（runtime.ts），真搜不搜由模型自己决定。
 *
 * 兜底路径：jev 不可用或调用报错时走 fallback——只有私聊、被 @、被回复、被点名算信号，
 * 纯反应消息（isBareReaction）不回复；搜索则一律挂上，交给模型判断。
 *
 * 关键约束：@ 和被回复只是**降低阈值**的提示，绝不强制回复；机器人最近一段时间的活跃度
 * 也放进 state 交给 jev 自己权衡，代码里没有硬性冷却。
 */
import { noul, type EntryType, type JsonValue, type Questions } from "@typesafe-ai/sdk";

import { config } from "../config.js";
import { createJevJudge, type Judge } from "../jev/judge.js";
import { relation, type ChatRecord, type Presence, type Scope } from "./history.js";

// Judge 已移到中立模块以便群管理复用；这里重新导出，兼容既有导入方。
export { createJevJudge };
export type { Judge };

/** decide() 的输入：一次判断所需的全部会话快照。 */
export type GateContext = {
  scope: Scope; // 群聊还是私聊
  sessionLabel: string; // 会话显示名（群名/对方昵称）
  botName: string; // 机器人名字
  aliases: string[]; // 别名列表
  persona: string; // 人设，放进 state 供 jev 理解说话风格
  earlier: ChatRecord[]; // 本批之前的上下文消息
  pending: ChatRecord[]; // 本批新消息（判断的对象）
  presence: Presence; // 最近窗口内的活跃度统计
  now: number; // 当前时间戳（毫秒），用于相对时间
};

/** jev 给出的原始概率与当次生效的阈值（写进日志便于调参）。 */
export type GateScores = {
  reply: number;
  addressed: number;
  search: number;
  threshold: number;
};

/** 判断结果。 */
export type GateDecision = {
  reply: boolean;
  // 是否给模型挂 web_search 工具；真搜不搜仍由模型自己决定。
  search: boolean;
  reason: string; // 简短理由（进日志）
  source: "rule" | "jev" | "fallback"; // 决定来源
  scores?: GateScores; // 仅 jev 路径有
};

/** 把时间戳转成 jev 输入里的相对时间文案（just now / 30s ago / 5min ago / 2h ago）。 */
function relativeTime(time: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}min ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** 把一条聊天记录转成 jev state 里的条目对象（说话人、时间、对谁、引用、@ 标记）。 */
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

/** 组装 jev 的 state：聊天场景、机器人身份与活跃度、旧消息与本批新消息。 */
export function buildState(ctx: GateContext): EntryType {
  const sinceBot = ctx.presence.lastBotAt === undefined ? null : Math.round((ctx.now - ctx.presence.lastBotAt) / 1000);
  return {
    chat: ctx.scope === "group" ? `QQ group "${ctx.sessionLabel}"` : `QQ private chat with ${ctx.sessionLabel}`,
    bot: { name: ctx.botName, aliases: ctx.aliases, persona: ctx.persona },
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

/** 构造 jev 的三个是非题；每题可用 true/false 两面描述判定标准。 */
export function buildQuestions(botName: string): Questions {
  return {
    should_reply: noul(`Should ${botName}, a member of this QQ chat, send a message now in response to new_messages?`, {
      true: `new_messages call for a response from ${botName}, or ${botName} has something worth adding. Being @mentioned or replied to (at_bot, replies_to_bot) makes this more likely.`,
      false: `new_messages do not need anything from ${botName}: the exchange is between others, it is winding down, or a message from ${botName} would add nothing.`,
    }),
    addressed: noul(`new_messages are directed at ${botName} and expect it to respond.`),
    needs_search: noul(`A good reply to new_messages depends on up-to-date or specific facts that should be looked up on the web.`),
  };
}

// 仅在没有 jev 的兜底路径使用：这些是收尾话和纯反应，不需要接话。
const BARE_REACTION =
  /^(?:[哈嘿呵嘻hH]+|草+|6+|[嗯恩哦噢喔啊]+|好+的?|好吧|行|ok|收到|懂了|明白了?|谢谢|谢了|多谢|感谢|thx|thanks|拜拜|晚安|[?？!！]+|\[[^\]]+\])+$/i;

/**
 * 是否是纯反应消息（如「哈哈哈」「6」「好的」「[doge]」）。
 * 先去掉 @xxx 与空白/标点再匹配；去空后为空的也算。
 */
export function isBareReaction(text: string): boolean {
  const core = text.replace(/@\S+/g, "").replace(/[\s,，.。~～…、]+/g, "");
  return core === "" || BARE_REACTION.test(core);
}

/**
 * 判断该不该发言。
 * jev 可用时问三个是非题并按当前阈值判定（被 @/被回复时改用 directThreshold）；
 * jev 缺失或调用报错时切到规则兜底。返回值同时携带搜索建议与分数（供日志/调参）。
 * @param ctx 会话快照。
 * @param judge jev 判定器；undefined 表示走兜底。
 */
export async function decide(ctx: GateContext, judge: Judge | undefined): Promise<GateDecision> {
  // @ 和回复只是降低门槛；最终仍由 jev 结合机器人近期活跃度判断。
  const direct = ctx.pending.some((record) => record.atBot || record.replyToBot);
  const mentioned = ctx.pending.some((record) => record.mentionsBot);

  if (judge) {
    try {
      const answers = await judge(buildState(ctx), buildQuestions(ctx.botName));
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
        reason: `${direct ? "direct, " : ""}jev ${yes ? "yes" : "no"}`,
        source: "jev",
        scores: { reply, addressed, search, threshold },
      };
    } catch (error) {
      return fallback(ctx, direct, mentioned, `jev error: ${(error as Error).message}`);
    }
  }
  return fallback(ctx, direct, mentioned, "no jev");
}

/**
 * 规则兜底：没有 jev 时只认明确信号（私聊、被 @、被回复、被点名）；
 * 整批全是纯反应消息时不回复。搜索一律挂上，交给模型判断。
 */
function fallback(ctx: GateContext, direct: boolean, mentioned: boolean, why: string): GateDecision {
  const signal = direct || mentioned || ctx.scope === "private";
  const reply = signal && !ctx.pending.every((record) => isBareReaction(record.text));
  return { reply, search: true, reason: why, source: "fallback" };
}
