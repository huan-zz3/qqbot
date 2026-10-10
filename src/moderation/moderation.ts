import { noul, type EntryType, type Questions } from "@typesafe-ai/sdk";

import { config } from "../config.js";
import type { Judge } from "../jev/judge.js";
import { logger } from "../logger.js";
import type { NapcatClient } from "../napcat/client.js";
import { renderSegments, textSegment, toSegments } from "../napcat/message.js";
import type { MessageEvent, Segment } from "../napcat/types.js";

export type OpName = "recall" | "ban" | "reply";

export type ModerationOp = {
  name: OpName;
  // Empty prompt means the op is not configured; it is skipped.
  prompt: string;
  threshold: number;
  text: string;
};

export type ModerationDeps = {
  client: Pick<NapcatClient, "selfId" | "sendMessage" | "callAction" | "deleteMsg" | "setGroupBan">;
  judge: Judge | undefined;
  power?: { readonly on: boolean };
};

// Every op fires independently on its own threshold; one message can trigger several at once.
export function selectActions(
  scores: Record<string, number>,
  ops: readonly ModerationOp[],
): ModerationOp[] {
  return ops.filter((op) => op.prompt && (scores[op.name] ?? 0) >= op.threshold);
}

type ContextLine = { from: string; text: string };

// Watches group messages and asks jev whether to recall, ban or reply; independent of chat/.
export class Moderation {
  // The bot's own role per group, cached for the process lifetime; a 1401 drops it.
  private readonly roles = new Map<number, string>();
  private readonly context = new Map<number, ContextLine[]>();
  private warnedNoJudge = false;
  private warnedNoPrompt = false;

  constructor(private readonly deps: ModerationDeps) {}

  handle(event: MessageEvent): void {
    void this.process(event);
  }

  private async process(event: MessageEvent): Promise<void> {
    if (!config.moderation.enabled) return;
    if (this.deps.power && !this.deps.power.on) return;
    if (event.message_type !== "group") return;
    const groupId = event.group_id;
    if (groupId === undefined || !config.moderation.groups.has(groupId)) return;
    const selfId = this.deps.client.selfId ?? event.self_id;
    if (event.user_id === selfId) return;

    const text = renderSegments(toSegments(event.message), { selfId, botName: config.bot.name });
    if (!text) {
      logger.debug(`[moderation] 群 ${groupId} 消息 ${event.message_id} 无文本，跳过`);
      return;
    }
    const from = event.sender?.card || event.sender?.nickname || String(event.user_id);
    const role = event.sender?.role;
    // admin/owner messages are not judged but still fill the context.
    if (role === "owner" || role === "admin") {
      this.appendContext(groupId, { from, text });
      return;
    }

    if (!this.deps.judge) {
      if (!this.warnedNoJudge) logger.warn("[moderation] 未配置 jev，群管理不生效");
      this.warnedNoJudge = true;
      return;
    }

    const ops = this.ops().filter((op) => op.prompt);
    if (ops.length === 0) {
      if (!this.warnedNoPrompt) logger.warn("[moderation] 未配置任何 MODERATION_*_PROMPT，群管理跳过");
      this.warnedNoPrompt = true;
      return;
    }

    const botRole = await this.botRole(groupId, selfId);
    if (botRole !== "owner" && botRole !== "admin") {
      logger.error(`[moderation] 群 ${groupId} 机器人不是管理员（role=${botRole ?? "未知"}），跳过管理`);
      return;
    }

    const prior = (this.context.get(groupId) ?? []).slice(-config.moderation.contextMessages);
    let scores: Record<string, number>;
    try {
      scores = await this.deps.judge(this.state(groupId, prior, from, text), this.questions(ops));
    } catch (error) {
      logger.error(`[moderation] 群 ${groupId} 消息 ${event.message_id} jev 判断失败: ${(error as Error).message}`);
      this.appendContext(groupId, { from, text });
      return;
    }
    this.appendContext(groupId, { from, text });

    for (const op of ops) {
      if (scores[op.name] === undefined) logger.error(`[moderation] 群 ${groupId} jev 未返回 ${op.name} 的概率，按 0 处理`);
    }
    const triggered = selectActions(scores, ops);
    const detail = ops.map((op) => `${op.name}=${(scores[op.name] ?? 0).toFixed(2)}/${op.threshold}`).join(" ");
    const hit = triggered.map((op) => op.name).join(",") || "无";
    logger.info(`[moderation] 群 ${groupId} 用户 ${event.user_id} 消息 ${event.message_id} ${detail} -> ${hit}`);
    for (const op of triggered) await this.act(op, event, groupId);
  }

  // Execution order when several ops fire; each op still triggers independently.
  private ops(): ModerationOp[] {
    const m = config.moderation;
    return [
      { name: "recall", prompt: m.recall.prompt, threshold: m.recall.threshold, text: m.recall.text },
      { name: "ban", prompt: m.ban.prompt, threshold: m.ban.threshold, text: m.ban.text },
      { name: "reply", prompt: m.reply.prompt, threshold: m.reply.threshold, text: m.reply.text },
    ];
  }

  private questions(ops: readonly ModerationOp[]): Questions {
    const questions: Questions = {};
    for (const op of ops) questions[op.name] = noul(op.prompt);
    return questions;
  }

  private state(groupId: number, context: ContextLine[], from: string, text: string): EntryType {
    return {
      group: groupId,
      message: { from, text },
      context: context.map((line) => ({ from: line.from, text: line.text })),
    };
  }

  private appendContext(groupId: number, line: ContextLine): void {
    const list = this.context.get(groupId) ?? [];
    list.push(line);
    const max = config.moderation.contextMessages;
    if (max <= 0) list.length = 0;
    else if (list.length > max) list.splice(0, list.length - max);
    this.context.set(groupId, list);
  }

  private async botRole(groupId: number, selfId: number): Promise<string | undefined> {
    const cached = this.roles.get(groupId);
    if (cached !== undefined) return cached;
    try {
      const info = await this.deps.client.callAction<{ role?: string }>("get_group_member_info", {
        group_id: groupId,
        user_id: selfId,
      });
      const role = info.data?.role;
      if (role) this.roles.set(groupId, role);
      return role;
    } catch (error) {
      logger.error(`[moderation] 群 ${groupId} 获取机器人身份失败: ${(error as Error).message}`);
      return undefined;
    }
  }

  private async act(op: ModerationOp, event: MessageEvent, groupId: number): Promise<void> {
    const { message_id: messageId, user_id: userId } = event;
    if (op.name !== "reply") {
      try {
        if (op.name === "recall") await this.deps.client.deleteMsg(messageId);
        else await this.deps.client.setGroupBan(groupId, userId, config.moderation.ban.seconds);
      } catch (error) {
        const retcode = (error as { retcode?: number }).retcode;
        // 1401 means the cached role went stale; drop it so the next message rechecks.
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

  private async reply(groupId: number, userId: number, text: string): Promise<void> {
    const segments: Segment[] = [{ type: "at", data: { qq: String(userId) } }, textSegment(" "), textSegment(text)];
    try {
      await this.deps.client.sendMessage({ groupId }, segments);
      logger.info(`[moderation] 群 ${groupId} 已回复用户 ${userId}: ${text}`);
    } catch (error) {
      logger.warn(`[moderation] 群 ${groupId} 回复用户 ${userId} 失败: ${(error as Error).message}`);
    }
  }
}
