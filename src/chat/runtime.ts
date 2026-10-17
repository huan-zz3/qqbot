/**
 * runtime.ts —— 聊天运行时：会话状态机，串联「收消息 → 防抖攒批 → decider 判断 → 生成回复 → 发送 → 记忆整理」全流程。
 *
 * 关键概念：
 * - Session：以 `group:<群号>` / `private:<QQ号>` 为 key 的会话状态，包含历史 SessionHistory、
 *   待判断批次 pending、防抖定时器 timer、忙碌标志 busy 与待整理记忆批 learnPending。
 * - pending / firstPendingAt：尚未交给 gate 判断的新消息及其首条到达时间；防抖等待从首条消息算起，
 *   总时长不超过 config.gate.maxWaitMs（GATE_MAX_WAIT_MS）。
 * - busy：同一会话同一时刻只处理一批；处理结束在 finally 里重新 schedule，天然串行。
 * - learnPending / learnTimer：记忆学习只发生在 bot 实际回复后，范围为触发该次回复的整批消息；
 *   延迟窗（MEMORY_LEARN_DELAY_MS）内多次回复在此累积，到点合并成一次学习。
 * - sinceBot：群会话自上次发言/上次强制以来累计的群消息数。仅 GATE_FORCE_REPLY_GROUPS 内的群计数，
 *   达到 GATE_FORCE_REPLY_MESSAGES 时该群下一批强制回复一次（gate 的 ctx.force）；机器人发言、
 *   强制判定作出、或 /停止 时清零。仅群聊，私聊恒为 0。
 *
 * 依赖关系：消息渲染来自 napcat/message.js；该不该说话由 gate.decide 判断；说什么由
 * reply.generateReply 生成；表情包/图片/记忆/开关分别是 stickers/images/memory/power，
 * 由 index.ts 组装注入，除 client 外都可能是 undefined（对应功能停用）。
 *
 * 约束/坑：
 * - 一批消息里若有被群管理（moderation）处理过的消息，整批跳过 AI 回复（deps.handoff）；
 *   回复前先等这批消息的群管理判定出结果，保证群管理优先于聊天回复；消息仍进历史。
 * - 图片描述、引用消息、@ 群名片是异步补全的，通过 ChatRecord.ready 汇总，process 最多等 MEDIA_WAIT_MS。
 * - 定时器回调统一写作 `void this.xxx()`；async 方法内部自行 catch，避免未处理的 Promise 拒绝。
 * - 群聊只响应 BOT_GROUPS、私聊只响应 BOT_PRIVATE_USERS 白名单；停机时完全不参与。
 */
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { ModerationHandoff } from "../moderation/handoff.js";
import type { NapcatClient, SendTarget } from "../napcat/client.js";
import {
  atTargets,
  isAtSelf,
  isSticker,
  renderSegments,
  replySegment,
  replyTargetId,
  textSegment,
  textToSegments,
  toSegments,
} from "../napcat/message.js";
import type { MessageEvent, Segment } from "../napcat/types.js";
import type { OpenCodeAgent } from "../opencode/agent.js";
import type { McpSearch } from "../search/mcp-search.js";
import { archiveKindOf, type ArchiveRequest } from "./archive.js";
import { decide, isDirect, type GateDecision, type Decider } from "./gate.js";
import type { FileRef } from "./files.js";
import { SessionHistory, formatLine, type ChatRecord, type Quote, type Scope } from "./history.js";
import type { ImageDescriber } from "./images.js";
import type { Materials } from "./materials.js";
import type { MemoryStore } from "./memory.js";
import type { PowerSwitch } from "./power.js";
import { dropRepeatedEndings, generateReply, planSends, type ReplyPart } from "./reply.js";
import type { StickerStore } from "./stickers.js";

/**
 * 单个会话的运行时状态：群聊、私聊各持有一份，按 key（`group:<群号>` / `private:<QQ号>`）复用。
 */
type Session = {
  key: string; // 会话唯一键
  scope: Scope; // 群聊还是私聊
  target: SendTarget; // 回复时的发送目标
  label: string; // 会话显示名：群聊为群名（异步加载，加载前是群号），私聊为对方昵称
  history: SessionHistory; // 会话历史（含裁剪与机器人消息 id 识别）
  pending: ChatRecord[]; // 已入库、尚未交给 gate 判断的新消息
  firstPendingAt: number | undefined; // 本批首条消息的到达时间，用于 maxWaitMs 兜底
  timer: NodeJS.Timeout | undefined; // 防抖定时器；每来一条新消息就重置
  busy: boolean; // 是否正在处理一批，防止同一会话并发判断/回复
  learnPending: ChatRecord[]; // 已回复、等待延迟整理的触发批（窗口内多次回复在此累积）
  learnTimer: NodeJS.Timeout | undefined; // 记忆整理定时器
  sinceBot: number; // 自上次发言/上次强制以来累计的群消息数（仅 GATE_FORCE_REPLY_GROUPS 内的群计）
};

/**
 * 运行时依赖：由 index.ts 组装注入。
 * 除 client 外均可选：decider 缺失时 gate 用规则兜底；search/stickers/images/memory 缺失时对应功能停用；
 * power 缺失时视为始终运行（没有开关可切）。
 */
export type RuntimeDeps = {
  client: Pick<NapcatClient, "selfId" | "sendMessage" | "sendForward" | "callAction">; // NapCat 客户端能力集
  decider: Decider | undefined; // decider 判定器；未配置 DECIDER_API_KEY 时为 undefined
  search: McpSearch | undefined; // MCP 联网搜索
  opencode: OpenCodeAgent | undefined; // 只读 OpenCode（ACP）能力
  stickers: StickerStore | undefined; // 表情包收藏
  images?: ImageDescriber | undefined; // 普通图片识图
  materials?: Materials | undefined; // 压缩包物料化（下载解压 + 清理）；缺少则不解压
  memory: MemoryStore | undefined; // 长期记忆
  power?: PowerSwitch | undefined; // 管理员 /启动 /停止 开关
  // 群管理处理过的消息信号；一批里若有命中者则跳过整批 AI 回复。群管理未启用该项时为 undefined。
  handoff?: ModerationHandoff | undefined;
};

// 管理员私聊指令 → 目标开关状态。
const COMMANDS = new Map([
  ["/启动", true],
  ["/停止", false],
]);

// 后台补全（识图、拉引用、查群名片）的等待上限：到点即使没完成也照常判断，避免一条图片消息卡住整批。
// 必须大于 VISION_TIMEOUT_MS（启动时校验），否则识图会先被这里截断、永远等不到描述。
export const MEDIA_WAIT_MS = 35000;

// 待整理记忆批的条数上限：超过即立即整理，防止延迟窗被连续回复不停重置而无限累积。
const MEMORY_LEARN_PENDING_MAX = 200;

/**
 * 聊天运行时：接管 NapCat 消息事件，按会话编排防抖、判断、生成、发送与记忆整理。
 * 无轮询：所有后续动作都由 handle() 里注册的定时器驱动。
 */
export class ChatRuntime {
  private readonly sessions = new Map<string, Session>(); // 活跃会话表，键见 Session.key
  // 群名片/昵称缓存，键为 "groupId:userId"；来源是消息发送者与 get_group_member_info 查询。
  private readonly memberNames = new Map<string, string>();

  /** @param deps 运行时依赖；构造后固定不变。 */
  constructor(private readonly deps: RuntimeDeps) {}

  /**
   * 消息事件入口：白名单过滤 → 管理员指令 → 渲染文本 → 组装记录入库 → 排防抖判断。
   * 机器人自己的消息、非白名单会话、停机状态都在这里被挡下。
   * @param event OneBot 消息事件。
   */
  handle(event: MessageEvent): void {
    const selfId = this.deps.client.selfId ?? event.self_id;
    // 忽略机器人自己发的消息，防止回环。
    if (event.user_id === selfId) return;
    // 管理员私聊里的 /启动 /停止 直接处理，不进入聊天流程。
    if (event.message_type === "private" && config.bot.adminUsers.has(event.user_id)) {
      const command = renderSegments(toSegments(event.message), { botName: config.bot.name });
      const on = COMMANDS.get(command);
      if (on !== undefined) {
        void this.command(event.user_id, on);
        return;
      }
    }
    // 停机意味着完全不参与：不判断、不记录、不学习。
    if (this.deps.power && !this.deps.power.on) return;
    const scope: Scope = event.message_type;
    // 只响应白名单内的群聊 / 私聊（BOT_GROUPS / BOT_PRIVATE_USERS）。
    if (scope === "group" && !config.bot.groups.has(event.group_id ?? 0)) return;
    if (scope === "private" && !config.bot.privateUsers.has(event.user_id)) return;

    const groupId = scope === "group" ? event.group_id : undefined;
    const senderName = event.sender?.card || event.sender?.nickname || String(event.user_id);
    // 顺手学习发送者名字（群名片优先），供 @ 显示名解析使用。
    if (groupId !== undefined) this.memberNames.set(`${groupId}:${event.user_id}`, senderName);

    const segments = toSegments(event.message);
    const atName = (userId: number) =>
      groupId === undefined ? undefined : this.memberNames.get(`${groupId}:${userId}`);
    const renderContext = { selfId, botName: config.bot.name, atName };
    const text = renderSegments(segments, renderContext);
    // 渲染后为空（没有可展示内容）的消息直接丢弃。
    if (!text) return;

    const session = this.session(event);
    // 聊天里收到的文件：组装成 FileRef 挂到记录（群聊带群号），供压缩包物料化选取。
    let files: FileRef[] | undefined;
    if (this.deps.materials) {
      for (const seg of segments) {
        if (seg.type !== "file") continue;
        const name = typeof seg.data.file === "string" && seg.data.file ? seg.data.file : "未命名文件";
        const fileId = fileIdOf(seg.data.file_id ?? seg.data.id);
        const size = Number(seg.data.file_size);
        (files ??= []).push({
          fileId,
          name,
          size: Number.isFinite(size) && size > 0 ? size : undefined,
          groupId,
        });
        logger.info(`[file] ${session.key} 收到文件 ${name} size=${Number.isFinite(size) ? size : "?"} id=${fileId ?? "无"}`);
      }
    }
    const replyTo = replyTargetId(segments);
    const names = [config.bot.name, ...config.bot.aliases];
    const mentions = atTargets(segments, selfId);
    const record: ChatRecord = {
      messageId: event.message_id,
      userId: event.user_id,
      name: senderName,
      text,
      time: event.time ? event.time * 1000 : Date.now(), // OneBot 的时间戳是秒，转毫秒
      fromBot: false,
      atBot: isAtSelf(segments, selfId), // 是否 @ 了机器人
      replyToBot: replyTo !== undefined && session.history.isBotMessage(replyTo), // 是否回复了机器人的消息
      mentionsBot: names.some((name) => name && text.includes(name)), // 正文是否点名（名字或别名）
      mentions, // 本条 @ 的其他用户（不含机器人自己）
      files, // 本条携带的文件（无则 undefined）
    };

    // 引用消息优先在本地历史里找，找不到再从 NapCat 异步拉取。
    const known = replyTo !== undefined ? session.history.byId(replyTo) : undefined;
    if (known) record.quote = { name: known.name, text: known.text, fromBot: known.fromBot, userId: known.userId };
    const nameMentions = () => mentions.map((userId) => atName(userId) ?? "某人");
    // 先用已知群名片填一遍 @ 名字；解析不到的等 lookupMember 完成后回填。
    record.mentionNames = nameMentions();

    const media = segments.filter((seg) => seg.type === "image" || seg.type === "mface");
    const unknownNames = groupId === undefined ? [] : mentions.filter((userId) => atName(userId) === undefined);
    const fetchQuote = replyTo !== undefined && !known;
    if (media.length > 0 || unknownNames.length > 0 || fetchQuote) {
      // 有异步补全需求时挂上 ready：识图 + 拉引用 + 查群名片并发执行，判断前会等待它（带上限）。
      record.ready = Promise.all([
        this.describeMedia(media),
        fetchQuote
          ? this.fetchQuote(replyTo!, selfId, atName).then((found) => {
              record.quote = found;
            })
          : undefined,
        ...unknownNames.map((userId) => this.lookupMember(groupId!, userId)),
      ]).then(([descriptions]) => {
        // 描述就绪后重新渲染文本，把 [图片：描述] 写进记录，并刷新 @ 名字。
        record.text = renderSegments(segments, { ...renderContext, imageText: (seg) => descriptions.get(seg) });
        record.mentionNames = nameMentions();
      });
    }
    // 记录同时进入历史（作为后续上下文）与待判断队列。
    session.history.add(record);
    session.pending.push(record);
    // 累计强制回复：仅对启用名单内的群，累加自上次发言/上次强制以来的群消息。
    if (this.forceReplyEnabled(groupId)) session.sinceBot += 1;
    this.schedule(session);
  }

  /** 取（或首次创建）事件对应的会话；群聊首次见到时异步加载群名。 */
  private session(event: MessageEvent): Session {
    const scope: Scope = event.message_type;
    const key = scope === "group" ? `group:${event.group_id}` : `private:${event.user_id}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        key,
        scope,
        target: scope === "group" ? { groupId: event.group_id! } : { userId: event.user_id },
        label: scope === "group" ? String(event.group_id) : event.sender?.nickname || String(event.user_id),
        history: new SessionHistory(config.history.maxMessages),
        pending: [],
        firstPendingAt: undefined,
        timer: undefined,
        busy: false,
        learnPending: [],
        learnTimer: undefined,
        sinceBot: 0,
      };
      this.sessions.set(key, session);
      // 群名异步加载；失败时 label 保持群号。
      if (scope === "group") void this.loadGroupName(session, event.group_id!);
    }
    return session;
  }

  /**
   * 处理管理员 /启动 /停止：切换持久化开关并私聊回复结果。
   * @param userId 发起指令的管理员 QQ 号。
   * @param on 目标状态：true = 启动，false = 停止。
   */
  private async command(userId: number, on: boolean): Promise<void> {
    const power = this.deps.power;
    let reply: string;
    if (!power) {
      reply = "没有配置开关（BOT_STATE_FILE）";
    } else if (power.on === on) {
      // 状态没变时只回复现状，不重复写盘。
      reply = on ? `${config.bot.name} 已经在运行` : `${config.bot.name} 已经是停止状态`;
    } else {
      await power.set(on);
      // 停机时清空所有待判断消息，恢复后不会把积压的旧消息突然补回复。
      if (!on) this.dropPending();
      reply = on ? `${config.bot.name} 已启动` : `${config.bot.name} 已停止，群聊和私聊都不再回复，发 /启动 恢复`;
    }
    logger.info(`[admin] ${userId} ${on ? "/启动" : "/停止"} -> ${reply}`);
    try {
      await this.deps.client.sendMessage({ userId }, [textSegment(reply)]);
    } catch (error) {
      // 指令已生效，回复失败只记警告。
      logger.warn("[admin] 回复失败:", (error as Error).message);
    }
  }

  /** 停机时清空所有会话的待判断消息，并取消防抖与学习定时器。 */
  private dropPending(): void {
    for (const session of this.sessions.values()) {
      if (session.timer) clearTimeout(session.timer);
      if (session.learnTimer) clearTimeout(session.learnTimer);
      session.timer = undefined;
      session.learnTimer = undefined;
      session.learnPending = [];
      session.pending = [];
      session.firstPendingAt = undefined;
      // 停机同样不参与：清零累计，避免恢复后旧计数立刻触发一次强制回复。
      session.sinceBot = 0;
    }
  }

  /**
   * 该群是否属于「累计消息强制回复」的生效范围（GATE_FORCE_REPLY_ENABLED + GATE_FORCE_REPLY_GROUPS）。
   * 只有这些群会计数，并在达到 GATE_FORCE_REPLY_MESSAGES 时强制回复一次。
   */
  private forceReplyEnabled(groupId: number | undefined): boolean {
    const force = config.gate.forceReply;
    return force.enabled && groupId !== undefined && force.groups.has(groupId);
  }

  /**
   * 从 NapCat 拉取被引用消息并转成 Quote（含其中的图片识别描述）。
   * @param messageId 被引用消息 id。
   * @param selfId 机器人 QQ 号，用于判断引用是否出自机器人。
   * @param atName @ 显示名解析回调。
   * @returns 拉取失败或渲染为空时返回 undefined（调用方按「没有引用」处理）。
   */
  private async fetchQuote(
    messageId: number,
    selfId: number,
    atName: (userId: number) => string | undefined,
  ): Promise<Quote | undefined> {
    try {
      const { data } = await this.deps.client.callAction<{
        user_id?: number;
        sender?: { card?: string; nickname?: string };
        message?: Segment[] | string;
      }>("get_msg", { message_id: messageId });
      const segments = toSegments(data?.message);
      // 引用里的图片/表情包也识图，让上下文完整。
      const descriptions = await this.describeMedia(segments.filter((seg) => seg.type === "image" || seg.type === "mface"));
      const text = renderSegments(segments, {
        selfId,
        botName: config.bot.name,
        atName,
        imageText: (seg) => descriptions.get(seg),
      });
      if (!text) return undefined;
      const fromBot = data?.user_id === selfId;
      // 引用机器人自己时署名用 bot 名；拿不到名字时用「某人」兜底。
      const name = fromBot ? config.bot.name : data?.sender?.card || data?.sender?.nickname || "某人";
      // 缺作者 QQ 时无法判断引用是否来自 GATE_DIRECT_USERS 名单里的 QQ，记一条 debug 便于排查（不阻断主流程）。
      if (data?.user_id === undefined) logger.debug(`获取引用消息 ${messageId} 缺少作者 QQ，无法判断是否直接指向`);
      return { name, text, fromBot, userId: data?.user_id };
    } catch (error) {
      // get_msg 失败（消息过旧、未缓存等）不阻断主流程。
      logger.debug(`获取引用消息失败 ${messageId}:`, (error as Error).message);
      return undefined;
    }
  }

  /**
   * 查询群成员的群名片/昵称并写入缓存；@ 名字解析不到时触发，失败静默。
   * @param groupId 群号。
   * @param userId 成员 QQ 号。
   */
  private async lookupMember(groupId: number, userId: number): Promise<void> {
    try {
      const info = await this.deps.client.callAction<{ card?: string; nickname?: string }>("get_group_member_info", {
        group_id: groupId,
        user_id: userId,
      });
      const name = info.data?.card || info.data?.nickname;
      if (name) this.memberNames.set(`${groupId}:${userId}`, name);
    } catch (error) {
      logger.debug(`获取群成员失败 ${groupId}:${userId}:`, (error as Error).message);
    }
  }

  /** 首次见到某群时拉取群名作为会话 label；失败时保持群号。 */
  private async loadGroupName(session: Session, groupId: number): Promise<void> {
    try {
      const info = await this.deps.client.callAction<{ group_name?: string }>("get_group_info", { group_id: groupId });
      if (info.data?.group_name) session.label = info.data.group_name;
    } catch (error) {
      logger.debug(`获取群名失败 ${groupId}:`, (error as Error).message);
    }
  }

  /**
   * 安排下一次防抖判断：每来一批新消息就重置计时器，等待从本批首条消息算起、总长受 maxWaitMs 限制。
   * 被 @ / 被回复时用更短的 directDebounceMs（对方在等回应），其余按群聊/私聊区分；
   * 正在处理（busy）或没有待判断消息时不排。
   */
  private schedule(session: Session): void {
    if (session.busy || session.pending.length === 0) return;
    const now = Date.now();
    session.firstPendingAt ??= now;
    // 本批里是否有直接指向机器人的消息（含被名单 QQ 指向的，见 gate.isDirect）。
    const direct = session.pending.some(isDirect);
    const debounce = direct
      ? config.gate.directDebounceMs
      : session.scope === "group"
        ? config.gate.groupDebounceMs
        : config.gate.privateDebounceMs;
    // 剩余可用时间 = 首条消息时间 + 最长等待 - 现在；再与防抖时长取小，保证消息不断时也会到点判断。
    const delay = Math.max(0, Math.min(debounce, session.firstPendingAt + config.gate.maxWaitMs - now));
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => void this.process(session), delay);
  }

  /**
   * 一批待判断消息的核心处理：等异步补全 → gate.decide 判断 → 决定回复则生成并发送。
   * 同一会话串行（busy 保护）；无论成败都在 finally 里重新 schedule 排下一批。
   */
  private async process(session: Session): Promise<void> {
    session.timer = undefined;
    if (session.busy || session.pending.length === 0) return;
    if (this.deps.power && !this.deps.power.on) {
      // 处理前再查一次开关：停机期间积攒的消息直接丢弃。
      session.pending = [];
      return;
    }
    session.busy = true;
    // 原子取走本批；处理期间新到的消息进入下一批。
    const pending = session.pending.splice(0);
    session.firstPendingAt = undefined;
    try {
      // 群管理优先：先等本批消息的群管理判定出结果，再决定是否回复，避免「群管理命中、聊天却抢先说话」。
      const pendingIds = pending.map((record) => record.messageId).filter((id): id is number => id !== undefined);
      if (this.deps.handoff && !(await this.deps.handoff.wait(pendingIds))) {
        logger.warn(`[chat] ${session.key} 等待群管理判定超时，按未命中继续 :: ${summarize(pending)}`);
      }
      // 本批若已有消息被群管理处理，整批跳过 AI 回复（群管理优先）；消息仍留在历史里供后续上下文。
      if (pending.some((record) => record.messageId !== undefined && this.deps.handoff?.handled(record.messageId))) {
        logger.info(`[chat] ${session.key} 本批已被群管理处理，跳过 AI 回复 :: ${summarize(pending)}`);
        return; // finally 里仍会重置 busy 并重新 schedule
      }
      // 等识图/引用/名片补全，最多 MEDIA_WAIT_MS；超时就用已就绪的部分继续，并记 warn 以便排查。
      const ready = await Promise.race([
        Promise.all(pending.map((record) => record.ready)).then(() => true),
        sleep(MEDIA_WAIT_MS).then(() => false),
      ]);
      if (!ready) {
        logger.warn(`[chat] ${session.key} 媒体补全超时（${MEDIA_WAIT_MS}ms），按已就绪内容继续 :: ${summarize(pending)}`);
      }
      const now = Date.now();
      // pending 在历史里也有一份，用 Set 区分「本批新消息」与「上文」。
      const pendingSet = new Set(pending);
      // 本批发言账号（去重）：给其中每个人额外保证其最近若干条消息进入两个窗口。
      const speakers = [...new Set(pending.map((record) => record.userId))];
      // decider 窗口：共享最近 deciderContextMessages 条，叠加每个发言账号各自最近 deciderUserContextMessages 条。
      const deciderRecords = session.history.context(
        config.history.deciderContextMessages + pending.length,
        config.history.deciderUserContextMessages,
        speakers,
      );
      const deciderShared = session.history.recent(config.history.deciderContextMessages + pending.length);
      // 模型窗口：共享最近 contextMessages 条，叠加每个发言账号各自最近 userContextMessages 条。
      const shared = session.history.recent(config.history.contextMessages + pending.length);
      const records = session.history.context(
        config.history.contextMessages + pending.length,
        config.history.userContextMessages,
        speakers,
      );
      // 分别记录两个窗口的实际条数、额外纳入条数与 bot 补齐条数，便于确认拆分与 bot 补齐是否生效。
      // 各窗口的共享部分是各自窗口的子集，故 extra/botFill 恒 >= 0。
      const countBot = (list: ChatRecord[]) => list.reduce((n, record) => n + (record.fromBot ? 1 : 0), 0);
      logger.debug(
        `[context] ${session.key} decider=${deciderRecords.length}(extra=${deciderRecords.length - deciderShared.length},botFill=${countBot(deciderRecords) - countBot(deciderShared)}) model=${records.length}(extra=${records.length - shared.length},botFill=${countBot(records) - countBot(shared)}) shared=${shared.length} speakers=${speakers.length}`,
      );
      // 累计强制回复：本群累计未回复消息达到条数时，本批判定强制回复一次。
      const forceThreshold = config.gate.forceReply.messages;
      const force =
        this.forceReplyEnabled(session.target.groupId) && session.sinceBot >= forceThreshold
          ? { count: session.sinceBot, threshold: forceThreshold }
          : undefined;
      const decision = await decide(
        {
          scope: session.scope,
          sessionLabel: session.label,
          botName: config.bot.name,
          aliases: config.bot.aliases,
          earlier: deciderRecords.filter((record) => !pendingSet.has(record)), // 上文（非本批，decider 窗口）
          pending,
          presence: session.history.presence(config.gate.presenceWindowMs, now), // 最近窗口内的活跃度
          now,
          force,
        },
        this.deps.decider,
      );
      // 强制判定一经作出即清零：被强制的批次必发消息，且计数不会持续卡在阈值反复强制。
      if (force) session.sinceBot = 0;
      // 每次判断都记日志：决定与来源、分数、消息摘要，便于调阈值。
      logger.info(`[gate] ${session.key} ${formatDecision(decision)} :: ${summarize(pending)}`);
      if (decision.reply) await this.reply(session, records, pendingSet, decision.search);
    } catch (error) {
      logger.error(`[chat] ${session.key} 处理失败:`, (error as Error).message);
    } finally {
      session.busy = false;
      this.schedule(session);
    }
  }

  /**
   * 生成并发送回复：拼上下文 → deepseek 生成 → 去掉重复结尾 → 分条发送或合并转发 → 安排记忆整理。
   * @param records 给模型看的聊天记录（含本批）。
   * @param pending 本批新消息（records 的子集），提示词里用 ★ 标记。
   * @param withSearch gate 是否建议挂搜索；真正挂载前还会确认 MCP 搜索当前可用。
   */
  private async reply(
    session: Session,
    records: ChatRecord[],
    pending: Set<ChatRecord>,
    withSearch: boolean,
  ): Promise<void> {
    // gate 建议搜索且 MCP 搜索当前可用时，才把工具挂给模型；OpenCode 组件存在即挂载。
    const usableSearch = withSearch && this.deps.search?.usable();
    if (withSearch && this.deps.search && !usableSearch) logger.debug(`[search] ${session.key} MCP 搜索不可用，跳过挂载`);
    const search = usableSearch ? this.deps.search : undefined;
    // 压缩包物料化：本批发言人最近发来的 zip/rar（新→旧、去重、限 maxFiles），有就提前下载解压。
    const archives = this.deps.materials ? this.collectArchives(session, records, pending) : [];
    if (this.deps.materials && archives.length === 0) logger.debug(`[archive] ${session.key} 本批无压缩包`);
    const materials =
      archives.length > 0 ? await this.deps.materials!.materialize(archives) : { text: "", dirs: [] };
    // 配了提示文本时，opencode 开始执行前先发一条；未配置则不传回调，行为与原来一致。
    const onOpencodeStart = config.opencode.notice ? () => this.sendOpencodeNotice(session) : undefined;
    const generated = await generateReply(
      {
        scope: session.scope,
        sessionLabel: session.label,
        botName: config.bot.name,
        personaIdentity: config.bot.personaIdentity,
        personaRules: config.bot.personaRules,
        records,
        pending,
        stickers: this.deps.stickers?.list() ?? [],
        memories: this.deps.memory?.describe(records) ?? [],
        now: Date.now(),
        filesEnabled: this.deps.materials !== undefined,
        materials: materials.text || undefined,
      },
      {
        search,
        opencode: this.deps.opencode
          ? { agent: this.deps.opencode, key: session.key, dirs: materials.dirs }
          : undefined,
        onOpencodeStart,
      },
    );
    // 机器人最近发过的文本，用来检查是否在复读同一个结尾。
    const recentBot = records.filter((record) => record.fromBot).map((record) => record.text);
    const parts = dropRepeatedEndings(generated, recentBot);
    if (parts.length === 0) {
      // 模型未产出有效内容（纯空白/接口异常）：记 warn 并跳过本轮发送。
      logger.warn(`[chat] ${session.key} 模型未产出有效内容，跳过发送`);
      return;
    }

    const list = [...pending];
    // 引用目标：本批最后一条直接 @/回复机器人的消息，没有就取本批最后一条。
    const target = list.findLast((record) => record.atBot || record.replyToBot) ?? list.at(-1)!;
    // 群聊里且回复期间对话又往前走了（最后一条已不是目标消息）时才带引用，避免显得答非所问。
    const quote =
      session.scope === "group" && target.messageId !== undefined && session.history.last() !== target;

    const members = this.members(session);
    for (const [index, item] of planSends(parts).entries()) {
      // 首条立即发；后续按打字速度间隔，合并转发固定等 1.5s。
      if (index > 0) await sleep(item.kind === "forward" ? 1500 : typingDelay(item.part));
      if (item.kind === "forward") {
        await this.sendForward(session, item.text, members);
        continue;
      }
      const sent = await this.toSegments(item.part, members);
      if (!sent) continue;
      // 引用只挂在第一条文本消息上。
      const quoted = index === 0 && quote;
      const segments = quoted ? [replySegment(target.messageId!), ...sent.segments] : sent.segments;
      const quoteOf = quoted ? { name: target.name, text: target.text, fromBot: false } : undefined;
      this.recordSent(session, await this.deps.client.sendMessage(session.target, segments), sent.text, quoteOf);
    }
    // 记忆学习只针对本次回复的触发批：把本批并入待学集合，延迟整理等对话自然停下。
    for (const record of pending) if (!session.learnPending.includes(record)) session.learnPending.push(record);
    this.scheduleLearn(session, config.memory.learnDelayMs);
  }

  /**
   * 选取要物料化的压缩包：仅本批发言人（pending）、且在模型可见 records 里的 zip/rar；
   * 按时间从新到旧、按 fileId（无则名字+大小）去重，最多 config.files.maxFiles 个。
   * index 是「同一消息里的第几个压缩包」，用于生成互不冲突的目录名。
   */
  private collectArchives(session: Session, records: ChatRecord[], pending: Set<ChatRecord>): ArchiveRequest[] {
    const senders = new Set([...pending].map((record) => record.userId));
    const seen = new Set<string>();
    const requests: ArchiveRequest[] = [];
    outer: for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i]!;
      if (!record.files || !senders.has(record.userId)) continue;
      let index = 0;
      for (const ref of record.files) {
        if (!archiveKindOf(ref.name)) continue;
        const key = ref.fileId ?? `${ref.name}:${ref.size ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        requests.push({ ref, sessionKey: session.key, userId: record.userId, messageId: record.messageId, index });
        index++;
        if (requests.length >= config.files.maxFiles) break outer;
      }
    }
    logger.debug(`[archive] ${session.key} 选中压缩包 ${requests.length} 个`);
    return requests;
  }

  /**
   * 发送 opencode 开始探索的提示：只记账（归零 + [send] 日志），**不写入会话历史**——
   * 这行提示若进上下文，会被模型照抄成回复（假装在调查却没真调用 opencode）。
   * 提示属于附属行为：发送失败只记 warn、不重抛，避免中断正在进行的探索任务。
   */
  private async sendOpencodeNotice(session: Session): Promise<void> {
    const text = config.opencode.notice;
    if (!text) return;
    try {
      await this.deps.client.sendMessage(session.target, [textSegment(text)]);
      this.markSent(session, text);
    } catch (error) {
      logger.warn(`[send] ${session.key} opencode 提示发送失败:`, (error as Error).message);
    }
  }

  /** 安排记忆整理：重置已有定时器，delay 毫秒后执行；未配置 memory 时直接跳过。 */
  private scheduleLearn(session: Session, delay: number): void {
    if (!this.deps.memory) return;
    if (session.learnTimer) clearTimeout(session.learnTimer);
    // 待学批过大时立即整理，避免窗口被连续回复不断重置而无限累积。
    if (session.learnPending.length >= MEMORY_LEARN_PENDING_MAX) {
      logger.info(`[memory] ${session.key} 待整理批达上限 ${MEMORY_LEARN_PENDING_MAX}，立即整理`);
      delay = 0;
    }
    session.learnTimer = setTimeout(() => void this.learn(session), delay);
  }

  /**
   * 整理一批触发过回复的消息进长期记忆：取走并清空待学集合后交给 MemoryStore.learn。
   * 失败只记警告、不重试，避免同一批反复消耗模型调用。
   */
  private async learn(session: Session): Promise<void> {
    session.learnTimer = undefined;
    const records = session.learnPending;
    session.learnPending = [];
    // 定时器到点却无待学内容属异常，记 info 便于发现逻辑错位，不静默。
    if (records.length === 0) {
      logger.info(`[memory] ${session.key} 到点但无待整理内容`);
      return;
    }
    try {
      const updated = await this.deps.memory!.learn(session.scope, session.label, records, config.bot.name);
      logger.info(`[memory] ${session.key} 整理 ${records.length} 条，更新 ${updated} 人`);
    } catch (error) {
      logger.warn(`[memory] ${session.key} 整理失败:`, (error as Error).message);
    }
  }

  /**
   * 发送一条合并转发；失败时退回逐条发送同样内容，保证回复能送达。
   * @param text 合并转发的正文（可能多行）。
   * @param members @ 名字 → QQ 号映射，供 textToSegments 发出真 @。
   */
  private async sendForward(session: Session, text: string, members: Map<string, number>): Promise<void> {
    const node: Segment = {
      type: "node",
      data: {
        user_id: String(this.deps.client.selfId ?? 0), // 转发节点署名机器人自己
        nickname: config.bot.name,
        content: textToSegments(text, members),
      },
    };
    try {
      this.recordSent(session, await this.deps.client.sendForward(session.target, [node]), `[合并转发]\n${text}`);
    } catch (error) {
      logger.warn(`[send] ${session.key} 合并转发失败，改为逐条发送:`, (error as Error).message);
      // 逐行发送：空行跳过，行间留出打字间隔。
      for (const line of text.split("\n").filter(Boolean)) {
        await sleep(typingDelay({ kind: "text", text: line }));
        this.recordSent(session, await this.deps.client.sendMessage(session.target, textToSegments(line, members)), line);
      }
    }
  }

  /**
   * 记录「机器人发了一条消息」的副作用，但不写入会话历史：累计强制回复归零 + [send] 日志。
   * 供不需要进入模型上下文的消息复用（如 opencode 开场通知）。
   */
  private markSent(session: Session, text: string): void {
    // 机器人自己发了言，累计归零。
    session.sinceBot = 0;
    logger.info(`[send] ${session.key} ${text}`);
  }

  /** 把机器人自己发出的消息写入历史并记日志；这类记录的各 @/回复标记恒为 false。 */
  private recordSent(session: Session, messageId: number | undefined, text: string, quote?: Quote): void {
    session.history.add({
      quote,
      messageId,
      userId: this.deps.client.selfId ?? 0,
      name: config.bot.name,
      text,
      time: Date.now(),
      fromBot: true,
      atBot: false,
      replyToBot: false,
      mentionsBot: false,
    });
    // 机器人自己发了言，累计归零 + 记日志（含普通回复、合并转发与降级）。
    this.markSent(session, text);
  }

  // 本群成员的显示名 → QQ 号映射，供回复里的 "@名字" 发成真 @。
  private members(session: Session): Map<string, number> {
    const members = new Map<string, number>();
    if (session.target.groupId === undefined) return members;
    const prefix = `${session.target.groupId}:`;
    // 同名成员时，后缓存的名字会覆盖先缓存的。
    for (const [key, name] of this.memberNames) {
      if (key.startsWith(prefix)) members.set(name, Number(key.slice(prefix.length)));
    }
    return members;
  }

  /**
   * 对图片/表情包逐段识图：表情包走 stickers、普通图片走 images；
   * 未启用或单段失败时，该段只是没有描述，不影响其它段。
   * @returns Segment → 描述 的映射（只含成功拿到描述的段）。
   */
  private async describeMedia(segments: Segment[]): Promise<Map<Segment, string>> {
    const descriptions = new Map<Segment, string>();
    await Promise.all(
      segments.map(async (segment) => {
        // 表情包和普通图片用各自的存储器识别。
        const sticker = isSticker(segment);
        const source = sticker ? this.deps.stickers : this.deps.images;
        let description: string | undefined;
        try {
          description = await source?.observe(segment);
        } catch (error) {
          // 单段识图抛错不让整批静默失败：记 warn 说明是图片还是表情包。
          logger.warn(`[chat] ${sticker ? "表情包" : "图片"}识图异常:`, (error as Error).message);
          return;
        }
        if (description) descriptions.set(segment, description);
      }),
    );
    return descriptions;
  }

  /**
   * 把回复片段转成可发送的消息段：文字经 textToSegments（真 @、QQ 小黄脸），表情包按编号查收藏。
   * @returns 表情包编号不存在时返回 undefined，调用方跳过该段并记警告。
   */
  private async toSegments(
    part: ReplyPart,
    members: Map<string, number>,
  ): Promise<{ segments: Segment[]; text: string } | undefined> {
    if (part.kind === "text") return { segments: textToSegments(part.text, members), text: part.text };
    const sticker = this.deps.stickers?.byId(part.id);
    if (!sticker) {
      logger.warn(`[send] 表情包 #${part.id} 不存在，跳过`);
      return undefined;
    }
    // text 是写进历史的展示文本，segments 才是真正发送的内容。
    return { segments: [await this.deps.stickers!.toSegment(sticker)], text: `[表情包：${sticker.description}]` };
  }
}

// 大致模拟真人打出下一条消息所需的时间：文字按长度估算（上限 3.5s），表情包固定 700ms，
// 再叠加 0-400ms 随机抖动，避免间隔过于机械。
function typingDelay(part: ReplyPart): number {
  const base = part.kind === "sticker" ? 700 : Math.min(3500, 500 + part.text.length * 100);
  return base + Math.floor(Math.random() * 400);
}

/** 把 gate 决定格式化成一行日志文本：是否回复、来源、理由，以及可选的四项分数。 */
function formatDecision(decision: GateDecision): string {
  const scores = decision.scores
    ? ` reply=${decision.scores.reply.toFixed(2)} addressed=${decision.scores.addressed.toFixed(2)} search=${decision.scores.search.toFixed(2)} threshold=${decision.scores.threshold.toFixed(2)}`
    : "";
  return `${decision.reply ? "REPLY" : "skip"} (${decision.source}: ${decision.reason})${scores}`;
}

/** 把 file 段的 file_id 统一成字符串；字段缺失或非法时返回 undefined。 */
function fileIdOf(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** 把一批消息压成单行摘要（每条截断 80 字符）用于日志。 */
function summarize(records: ChatRecord[]): string {
  return records.map((record) => formatLine(record, record.name, config.bot.name).slice(0, 80)).join(" | ");
}

/** 通用延时，用于发送节奏与等待上限。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
