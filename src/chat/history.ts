/**
 * history.ts —— 单个会话（群聊/私聊）的消息记录与文本格式化。
 *
 * 核心数据结构 ChatRecord：一条消息的发送者、正文、时间，以及是否来自 bot、
 * 是否 @ 了 bot、是否回复 bot 等元信息；可选的 quote 记录被引用的消息。
 * 对外两种消费方式：
 *   - relation / formatLine 把记录渲染成统一格式「说话人 → 对象：正文（引用 某人的「原文」）」，
 *     decider 输入、回复提示词、记忆提示词共用该格式，三处必须保持一致；
 *   - SessionHistory 保存有界的历史记录，供防抖判断与回复时取最近上下文。
 * 约束：records 只保留最近 maxRecords 条，但 total 累计数不随裁剪减少，
 * 因此 since(mark) 能识别标记早于当前窗口的情况；botMessageIds 用于判断
 * 某条引用/回复目标是否由 bot 自己发出。
 */
import type { FileRef } from "./files.js";

/** 会话类型：群聊或私聊；长期记忆按此分区。 */
export type Scope = "group" | "private";

/** 被引用（回复）的消息快照：作者展示名、正文、是否来自 bot，以及作者 QQ（可能缺失）。 */
export type Quote = { name: string; text: string; fromBot: boolean; userId?: number };

/**
 * 一条会话消息记录。
 * 记录进入历史后，表情包/图片描述、@ 展示名、引用内容等字段仍可能异步补齐，
 * ready 用于等待这些补全完成（发送方据此拿到最终文本）。
 */
export type ChatRecord = {
  /** 协议端消息 ID；bot 消息同样携带，用于「这条是不是 bot 发的」判定。 */
  messageId?: number;
  /** 发送者 QQ 号。 */
  userId: number;
  /** 发送者展示名（群名片优先于昵称，由上层解析）。 */
  name: string;
  /** 渲染后的正文（图片/表情包已替换为 `[图片：描述]` 等形式）。 */
  text: string;
  /** 消息时间戳（毫秒）。 */
  time: number;
  /** 是否由 bot 自己发出。 */
  fromBot: boolean;
  /** 是否 @ 了 bot。 */
  atBot: boolean;
  /** 是否在回复 bot 的消息（被引用消息来自 bot）。 */
  replyToBot: boolean;
  /** 是否点名了 bot（@、名字或别名）。 */
  mentionsBot: boolean;
  // 本条消息 @ 的其他用户 QQ 号；mentionNames 是解析出展示名后的对照数组。
  mentions?: number[];
  mentionNames?: string[];
  // 本条消息所回复的消息快照。
  quote?: Quote;
  // 本条消息携带的文件（群/私聊文件段）；供 opencode 调用时懒加载文本内容。
  files?: FileRef[];
  // 表情包描述、@ 展示名、引用内容全部补齐后 resolve。
  ready?: Promise<void>;
};

// 引用原文在记录里的最大字符数，超出截断加省略号，避免旧消息原文挤占上下文。
const QUOTE_MAX_CHARS = 60;

/**
 * 推断一条消息「在对谁说」以及引用了什么，使读者能看清谁在和谁说话。
 * 收信对象优先级：@ 了 bot（记为 self）→ @ 的其他用户；都没有时退回到被引用消息的作者。
 * @param record 消息记录
 * @param self bot 在提示词中的自称（如「你」）
 * @returns to 为收信对象展示名列表；quote 为「某人的「原文」」形式的引用（无引用时缺省）
 */
export function relation(record: ChatRecord, self: string): { to: string[]; quote?: string } {
  // @bot 与 @其他人可同时成立，顺序为先 bot 后其他人
  const to = [...(record.atBot ? [self] : []), ...(record.mentionNames ?? [])];
  const quoted = record.quote;
  // 没有明确 @ 对象时，回复谁就是在跟谁说
  if (to.length === 0 && quoted) to.push(quoted.fromBot ? self : quoted.name);
  if (!quoted) return { to };
  // 引用原文压成单行；过长截断，保持记录格式稳定
  const text = quoted.text.replace(/\s+/g, " ");
  const short = text.length > QUOTE_MAX_CHARS ? `${text.slice(0, QUOTE_MAX_CHARS)}…` : text;
  return { to, quote: `${quoted.fromBot ? self : quoted.name}的「${short}」` };
}

/**
 * 把记录渲染成统一聊天记录行：「说话人 → 对象：正文（引用 某人的「原文」）」。
 * decider 输入、回复提示词、记忆提示词共用此格式，改动需三处同步。
 * @param record 消息记录
 * @param speaker 说话人称呼（bot 传 botName，其他人传展示名）
 * @param self bot 的自称（用于「→ 你」及引用 bot 的场合）
 */
// "名字 → 对象：正文（引用 某人的「原文」）"
export function formatLine(record: ChatRecord, speaker: string, self: string): string {
  const { to, quote } = relation(record, self);
  // 没有明确对象时省略箭头段
  const arrow = to.length > 0 ? ` → ${to.join("、")}` : "";
  return `${speaker}${arrow}：${record.text}${quote ? `（引用${quote}）` : ""}`;
}

/** 一段时间窗口内的发言统计，供 decider 判断「是否刷屏」。 */
export type Presence = {
  /** 窗口内 bot 发言条数。 */
  bot: number;
  /** 窗口内所有发言条数。 */
  total: number;
  /** 最近一次 bot 发言时间戳；从未发言则缺省（不受窗口限制）。 */
  lastBotAt?: number;
};

// bot 消息 ID 只保留最近 500 条：足以覆盖近期的引用/回复判定，同时限制内存。
const MAX_BOT_MESSAGE_IDS = 500;

/**
 * 单个会话的有界消息记录。
 * 超出 maxRecords 时从最旧开始裁剪；total 是累计加入数、不随裁剪减少，
 * 调用方用 total 做标记，since(mark) 在记录被裁剪后仍能只返回保留下来的部分。
 */
export class SessionHistory {
  private readonly records: ChatRecord[] = [];
  // bot 自己消息的 ID 集合，用于判断回复/引用目标是不是 bot
  private readonly botMessageIds = new Set<number>();
  // 累计加入过的记录数（不因裁剪减少）；标记记进这个计数，裁剪后依然可识别
  total = 0;

  /** @param maxRecords 记录上限，超出后丢弃最旧的。 */
  constructor(private readonly maxRecords: number) {}

  /** 追加一条记录；超出上限时裁剪最旧记录，并登记 bot 消息 ID（集合同样限长）。 */
  add(record: ChatRecord): void {
    this.total++;
    this.records.push(record);
    // 一次性丢弃超限的最旧部分
    if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
    if (record.fromBot && record.messageId !== undefined) {
      this.botMessageIds.add(record.messageId);
      // Set 按插入顺序迭代，删掉最早登记的那个
      if (this.botMessageIds.size > MAX_BOT_MESSAGE_IDS) {
        this.botMessageIds.delete(this.botMessageIds.values().next().value!);
      }
    }
  }

  /** 该消息 ID 是否由 bot 自己发出（判断「在回复 bot」用）。 */
  isBotMessage(messageId: number): boolean {
    return this.botMessageIds.has(messageId);
  }

  /** 最近 count 条记录；不足时返回全部。 */
  recent(count: number): ChatRecord[] {
    return this.records.slice(-count);
  }

  /**
   * 组装给消费者（回复模型 / decider）看的上下文：共享窗口「最后 overall 条」叠加「每个发言账号各自最近 perUser 条」，
   * 再在该窗口已经触及的范围（最旧选中下标 → 末尾）内补齐 bot 自己的消息，合并去重后按时间顺序返回。
   * 用于让刷屏者触发的 prompt 更完整地携带他自己的内容，且 bot 落在逐账号空档里的回复不被丢弃。
   * @param overall 共享窗口条数；调用方通常传「上下文条数 + 本批条数」，保证本批全部在内。
   * @param perUser 每个发言账号额外保证的条数；<=0 或 userIds 为空时退化为只看共享窗口。
   * @param userIds 本批发言账号（重复无妨，按账号逐个限量）；bot 不作为发言账号参与此处。
   */
  context(overall: number, perUser: number, userIds: number[]): ChatRecord[] {
    const picked = new Set<number>();
    // 共享窗口：最后 overall 条。
    for (let i = Math.max(0, this.records.length - overall); i < this.records.length; i++) picked.add(i);
    // 逐账号保证：各自从新到旧取最多 perUser 条（含落在共享窗口内的），只按账号计数。
    if (perUser > 0 && userIds.length > 0) {
      const speakers = new Set(userIds);
      const taken = new Map<number, number>();
      for (let i = this.records.length - 1; i >= 0; i--) {
        const record = this.records[i]!;
        if (!speakers.has(record.userId)) continue;
        const used = taken.get(record.userId) ?? 0;
        if (used >= perUser) continue;
        taken.set(record.userId, used + 1);
        picked.add(i);
      }
    }
    // bot 补齐：窗口已触及的范围（最旧选中下标 → 末尾）内，凡 bot 自己的消息一律纳入，
    // 避免它们落在逐账号保证的空档里被丢弃；只补区间内、不改变下界（比下界更旧的 bot 消息仍不进）。
    if (picked.size > 0) {
      let min = this.records.length;
      for (const index of picked) if (index < min) min = index;
      for (let i = min; i < this.records.length; i++) {
        if (this.records[i]!.fromBot) picked.add(i);
      }
    }
    // 按原顺序输出（Set 无序，显式按时间升序过滤 records）。
    return this.records.filter((_record, index) => picked.has(index));
  }

  /**
   * 返回 total 计数从 mark 之后新增的记录。
   * mark 由调用方在某个时点读取 total 得到；若其间记录已被裁剪，
   * 只能返回仍保留的部分（Math.min 保证不越界）。
   */
  since(mark: number): ChatRecord[] {
    const count = Math.min(this.records.length, this.total - mark);
    return count > 0 ? this.records.slice(-count) : [];
  }

  /** 按消息 ID 查找（从新到旧取最新一条）。 */
  byId(messageId: number): ChatRecord | undefined {
    return this.records.findLast((record) => record.messageId === messageId);
  }

  /** 最后一条记录；空历史返回 undefined。 */
  last(): ChatRecord | undefined {
    return this.records.at(-1);
  }

  /**
   * 统计最近 windowMs 内的发言情况；lastBotAt 不受窗口限制（同一次遍历得出）。
   * @param windowMs 统计窗口（毫秒）
   * @param now 当前时间戳（毫秒）
   */
  presence(windowMs: number, now: number): Presence {
    let bot = 0;
    let total = 0;
    let lastBotAt: number | undefined;
    // 从新到旧遍历：首次遇到 bot 消息即为最近一次 bot 发言
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i]!;
      if (record.fromBot && lastBotAt === undefined) lastBotAt = record.time;
      // 窗口外的记录不计入统计，但继续向前找 lastBotAt
      if (now - record.time > windowMs) continue;
      total++;
      if (record.fromBot) bot++;
    }
    return { bot, total, lastBotAt };
  }
}
