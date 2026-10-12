/**
 * moderation.ts —— 群管理：机器人自主巡查群消息，执行撤回/禁言/回复。
 *
 * 流程：每条群消息连同它前面 MODERATION_CONTEXT_MESSAGES 条上下文交给 decider，
 * 一次问三个问题（撤回 / 禁言 / 回复）；三个操作各自独立、按各自阈值触发、无优先级，
 * 一条消息可同时命中多项，执行顺序为 撤回 → 禁言 → 回复，每项完成后 @ 对方发一条固定文本。
 *
 * 关键约定：
 * - 判定不要求机器人自身是管理员，始终进行；但撤回/禁言需要管理权限：无权限时该项
 *   命中也不执行、不发文本，只记日志。「回复」不依赖权限，始终可用；
 * - 命中并实际执行任一操作时标记该消息（handoff），普通聊天流程据此跳过同一批的 AI 回复；
 *   未命中（或因无权限而未执行）时该消息仍照常进入 chat/ 流程；
 * - 某项的 MODERATION_*_PROMPT 为空即不启用该项；三项全空则不判断；
 * - 判定撤回/禁言能否执行时用 get_group_member_info 确认机器人身份并缓存，失败按无权限处理；
 *   动作返回 retcode 1401 表示缓存身份过期，丢弃缓存、下条消息重查；
 * - 撤回/禁言失败时不发固定文本（不谎报已处理）；
 * - 依赖可缺省的 Decider（未配置 decider 时模块不生效）；power 为管理员 /启动 /停止 的持久化开关。
 */
import { noul, type DeciderQuestions, type DeciderState } from "../decider/questions.js";

import { config } from "../config.js";
import type { Decider } from "../decider/client.js";
import { logger } from "../logger.js";
import type { NapcatClient } from "../napcat/client.js";
import { renderSegments, textSegment, toSegments } from "../napcat/message.js";
import type { MessageEvent, Segment } from "../napcat/types.js";
import type { ModerationHandoff } from "./handoff.js";

/** 三个管理操作名；同时用作 decider 问题名与分数键。 */
export type OpName = "recall" | "ban" | "reply";

/** 单个管理操作：判定问题名、提示词、触发阈值与命中后 @ 对方发送的固定文本。 */
export type ModerationOp = {
  name: OpName;
  // 提示词为空表示该项未配置，直接跳过。
  prompt: string;
  threshold: number;
  text: string;
};

/**
 * 依赖注入：只列出本模块用到的客户端能力，外加 decider 判定与可选的电源开关。
 * decider 为 undefined（未配置 DECIDER_API_KEY）时群管理不生效；power 关闭（管理员发 /停止）时跳过。
 */
export type ModerationDeps = {
  client: Pick<NapcatClient, "selfId" | "sendMessage" | "callAction" | "deleteMsg" | "setGroupBan">;
  decider: Decider | undefined;
  power?: { readonly on: boolean };
  // 命中一条消息后据此标记，聊天运行时查同一对象以跳过对应批次的 AI 回复；未启用该项时为 undefined。
  handoff?: ModerationHandoff;
};

/**
 * 按各自阈值筛出要执行的操作：分数达到阈值即触发，未配置提示词的操作跳过，分数缺失按 0 计。
 * 纯函数；三个操作相互独立、无优先级，一条消息可同时命中多项。返回顺序与传入 ops 一致。
 */
export function selectActions(
  scores: Record<string, number>,
  ops: readonly ModerationOp[],
): ModerationOp[] {
  return ops.filter((op) => op.prompt && (scores[op.name] ?? 0) >= op.threshold);
}

/** 群聊上下文的一行：说话人显示名 + 已渲染文本。 */
type ContextLine = { from: string; text: string };

/** 群管理主体：监听群消息并交给 decider 判断是否撤回/禁言/回复，与 chat/ 流程互不影响。 */
export class Moderation {
  // 机器人在每个群的身份（owner/admin/member…），进程内缓存；收到 retcode 1401 时删除重查。
  private readonly roles = new Map<number, string>();
  // 每个群最近的消息上下文；appendContext 负责维持条数上限。
  private readonly context = new Map<number, ContextLine[]>();
  // 两个「只告警一次」标记，避免配置缺失时每条消息都刷日志。
  private warnedNoDecider = false;
  private warnedNoPrompt = false;

  constructor(private readonly deps: ModerationDeps) {}

  /** 事件入口：同步返回，实际处理在后台异步进行，不阻塞 WebSocket 回调。 */
  handle(event: MessageEvent): void {
    void this.process(event);
  }

  private async process(event: MessageEvent): Promise<void> {
    // 总开关：未启用直接跳过。
    if (!config.moderation.enabled) return;
    // 管理员 /停止 期间挂起。
    if (this.deps.power && !this.deps.power.on) return;
    // 只管群消息。
    if (event.message_type !== "group") return;
    const groupId = event.group_id;
    // 只管理白名单内的群；群号取不到也跳过。
    if (groupId === undefined || !config.moderation.groups.has(groupId)) return;
    const selfId = this.deps.client.selfId ?? event.self_id;
    // 不处理机器人自己发的消息。
    if (event.user_id === selfId) return;

    const text = renderSegments(toSegments(event.message), { selfId, botName: config.bot.name });
    // 空文本（纯图片/表情包等）不参与判定，也不进上下文。
    if (!text) {
      logger.debug(`[moderation] 群 ${groupId} 消息 ${event.message_id} 无文本，跳过`);
      return;
    }
    // 显示名优先群名片，其次昵称，最后退回 QQ 号。
    const from = event.sender?.card || event.sender?.nickname || String(event.user_id);
    const role = event.sender?.role;
    // 群主/管理员的消息不判断，但仍进上下文，让 decider 看到完整对话。
    if (role === "owner" || role === "admin") {
      this.appendContext(groupId, { from, text });
      return;
    }

    // 未创建 decider（DECIDER_API_KEY 为空）时无法判定，只告警一次。
    if (!this.deps.decider) {
      if (!this.warnedNoDecider) logger.warn("[moderation] 未配置 decider，群管理不生效");
      this.warnedNoDecider = true;
      return;
    }

    // 只保留配置了提示词的操作；三项全空时模块不工作，只告警一次。
    const ops = this.ops().filter((op) => op.prompt);
    if (ops.length === 0) {
      if (!this.warnedNoPrompt) logger.warn("[moderation] 未配置任何 MODERATION_*_PROMPT，群管理跳过");
      this.warnedNoPrompt = true;
      return;
    }

    // 从这里起会真正判定这条消息：先登记，聊天运行时在回复前会等这次判定出结果，
    // 保证「群管理命中」能先于聊天回复被看到；无论命中与否都在 finally 里收尾。
    this.deps.handoff?.begin(event.message_id);
    try {
      // 取最近 contextMessages 条前置消息作为判定上下文。
      const prior = (this.context.get(groupId) ?? []).slice(-config.moderation.contextMessages);
      let scores: Record<string, number>;
      try {
        scores = await this.deps.decider(this.state(groupId, prior, from, text), this.questions(ops));
      } catch (error) {
        // 判定失败时该消息照样进上下文，保证后续判断的上下文连续。
        logger.error(`[moderation] 群 ${groupId} 消息 ${event.message_id} decider 判断失败: ${(error as Error).message}`);
        this.appendContext(groupId, { from, text });
        return;
      }
      this.appendContext(groupId, { from, text });

      // 问题名与分数键同名；缺失说明提示词与 decider 返回值对不上，按 0 处理并报错。
      for (const op of ops) {
        if (scores[op.name] === undefined) logger.error(`[moderation] 群 ${groupId} decider 未返回 ${op.name} 的概率，按 0 处理`);
      }
      // 各自独立触发，可能多项同时命中。
      const triggered = selectActions(scores, ops);
      // 撤回/禁言需要管理权限，reply 不需要；仅当命中里含撤回/禁言时才查机器人身份（带缓存）。
      const needRole = triggered.some((op) => op.name !== "reply");
      const canManage = needRole ? await this.canManage(groupId, selfId) : false;
      // 实际可执行的操作：reply 始终可执行；撤回/禁言仅在机器人是群主/管理员时可执行。
      const executable = triggered.filter((op) => op.name === "reply" || canManage);
      // 因无权限被跳过的撤回/禁言：只记日志，不执行也不发文本。
      for (const op of triggered) {
        if (op.name !== "reply" && !canManage) {
          logger.warn(`[moderation] 群 ${groupId} 机器人无管理权限，跳过 ${op.name} 消息 ${event.message_id}`);
        }
      }
      // 只有实际会执行的操作才算群管理生效：标记该消息，聊天运行时据此跳过本批 AI 回复。
      if (executable.length > 0) this.deps.handoff?.mark(event.message_id);
      // detail 记录每项「分数/阈值」便于调参；hit 记录 decider 命中的操作，exec 记录实际执行的操作。
      const detail = ops.map((op) => `${op.name}=${(scores[op.name] ?? 0).toFixed(2)}/${op.threshold}`).join(" ");
      const hit = triggered.map((op) => op.name).join(",") || "无";
      const exec = executable.map((op) => op.name).join(",") || "无";
      logger.info(`[moderation] 群 ${groupId} 用户 ${event.user_id} 消息 ${event.message_id} ${detail} -> 命中 ${hit} 执行 ${exec}`);
      // 依次执行可执行项，顺序由 ops() 决定：撤回 → 禁言 → 回复。
      for (const op of executable) await this.act(op, event, groupId);
    } finally {
      this.deps.handoff?.settle(event.message_id);
    }
  }

  // 返回顺序即多项命中时的执行顺序：撤回 → 禁言 → 回复；每项仍各自独立触发。
  private ops(): ModerationOp[] {
    const m = config.moderation;
    return [
      { name: "recall", prompt: m.recall.prompt, threshold: m.recall.threshold, text: m.recall.text },
      { name: "ban", prompt: m.ban.prompt, threshold: m.ban.threshold, text: m.ban.text },
      { name: "reply", prompt: m.reply.prompt, threshold: m.reply.threshold, text: m.reply.text },
    ];
  }

  /** 把各操作的提示词包装成 decider 问题；问题名与分数键一致（即 op.name）。 */
  private questions(ops: readonly ModerationOp[]): DeciderQuestions {
    const questions: DeciderQuestions = {};
    // noul() 表示「是/否」概率问题。
    for (const op of ops) questions[op.name] = noul(op.prompt);
    return questions;
  }

  /** 构造 decider 判定输入：群号、当前消息、以及前置上下文。 */
  private state(groupId: number, context: ContextLine[], from: string, text: string): DeciderState {
    return {
      group: groupId,
      message: { from, text },
      context: context.map((line) => ({ from: line.from, text: line.text })),
    };
  }

  /** 追加一行群上下文；超出上限丢弃最旧的，上限 <= 0 时清空（不保留上下文）。 */
  private appendContext(groupId: number, line: ContextLine): void {
    const list = this.context.get(groupId) ?? [];
    list.push(line);
    const max = config.moderation.contextMessages;
    if (max <= 0) list.length = 0;
    else if (list.length > max) list.splice(0, list.length - max);
    this.context.set(groupId, list);
  }

  /** 机器人是否为该群群主/管理员（撤回、禁言执行的前提）；身份结果带缓存，查询失败按无权限处理。 */
  private async canManage(groupId: number, selfId: number): Promise<boolean> {
    const role = await this.botRole(groupId, selfId);
    return role === "owner" || role === "admin";
  }

  /** 取机器人在该群的身份（owner/admin/member…），进程内缓存；查询失败返回 undefined 且不缓存，下条消息重试。 */
  private async botRole(groupId: number, selfId: number): Promise<string | undefined> {
    const cached = this.roles.get(groupId);
    if (cached !== undefined) return cached;
    try {
      const info = await this.deps.client.callAction<{ role?: string }>("get_group_member_info", {
        group_id: groupId,
        user_id: selfId,
      });
      const role = info.data?.role;
      // 拿到有效身份才写缓存，否则下次重查。
      if (role) this.roles.set(groupId, role);
      return role;
    } catch (error) {
      logger.error(`[moderation] 群 ${groupId} 获取机器人身份失败: ${(error as Error).message}`);
      return undefined;
    }
  }

  /**
   * 执行一个命中操作：先做动作（撤回/禁言；reply 没有动作），成功后才 @ 对方发固定文本。
   * 动作失败时不发文本，直接返回，避免谎报已处理。
   */
  private async act(op: ModerationOp, event: MessageEvent, groupId: number): Promise<void> {
    const { message_id: messageId, user_id: userId } = event;
    // reply 不需要前置动作，只有撤回与禁言要先调接口。
    if (op.name !== "reply") {
      try {
        // 撤回走 delete_msg；禁言走 set_group_ban，时长来自配置。
        if (op.name === "recall") await this.deps.client.deleteMsg(messageId);
        else await this.deps.client.setGroupBan(groupId, userId, config.moderation.ban.seconds);
      } catch (error) {
        const retcode = (error as { retcode?: number }).retcode;
        // 1401：缓存的机器人身份已过期（如被撤职），删除缓存让下条消息重查。
        if (retcode === 1401) this.roles.delete(groupId);
        const suffix = retcode === undefined ? "" : ` retcode=${retcode}`;
        logger.error(
          `[moderation] 群 ${groupId} ${op.name} 失败${suffix} 消息 ${messageId} 用户 ${userId}: ${(error as Error).message}`,
        );
        return; // 失败时不发固定回复，免得谎报已处理
      }
      logger.info(`[moderation] 群 ${groupId} ${op.name} 成功 消息 ${messageId} 用户 ${userId}`);
    }
    await this.reply(groupId, userId, op.text);
  }

  /** @ 用户后跟固定文本；发送失败只记 warn，不向上抛。 */
  private async reply(groupId: number, userId: number, text: string): Promise<void> {
    // @ 段 + 空格 + 文本，保证 @ 与正文之间有间隔。
    const segments: Segment[] = [{ type: "at", data: { qq: String(userId) } }, textSegment(" "), textSegment(text)];
    try {
      await this.deps.client.sendMessage({ groupId }, segments);
      logger.info(`[moderation] 群 ${groupId} 已回复用户 ${userId}: ${text}`);
    } catch (error) {
      logger.warn(`[moderation] 群 ${groupId} 回复用户 ${userId} 失败: ${(error as Error).message}`);
    }
  }
}
