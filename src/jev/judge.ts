/**
 * judge.ts —— jev 判定客户端封装：把 TypeSafe SDK 包装成项目内统一的 Judge 函数。
 *
 * 聊天（chat/gate.ts）与群管理（moderation/moderation.ts）共用该判定接口：
 * 输入判定状态 state 与一组问题 questions，输出「问题名 → 为『是』的概率（0–1）」。
 *
 * 约定：
 * - 只收集 SDK 返回中类型为 noul 的答案作为概率，其它答案类型直接忽略，
 *   因此调用方对结果里缺失的问题名需按 0 处理；
 * - TYPESAFE_API_KEY 为空时不创建 judge（见 index.ts），调用方各自处理 judge 缺失的兜底分支。
 */
import { TypeSafeClient, type EntryType, type Questions } from "@typesafe-ai/sdk";

import { config } from "../config.js";

/**
 * 判定函数：state 是本次判定的输入（EntryType，如当前消息 + 聊天记录/上下文的快照），
 * questions 是问题名到问题的映射；返回问题名到「是」概率的字典。
 */
export type Judge = (state: EntryType, questions: Questions) => Promise<Record<string, number>>;

/**
 * 用 config.jev（apiKey / model / timeoutMs）创建 SDK 客户端并返回 Judge。
 * 每次调用返回的函数都会向 jev 发起一次 systemOne 请求（SDK 内部最多重试 1 次）。
 *
 * @returns 判定函数；某个问题缺失答案时，结果字典中就没有对应键
 */
export function createJevJudge(): Judge {
  const client = new TypeSafeClient({
    apiKey: config.jev.apiKey,
    defaultModel: config.jev.model,
    timeout: config.jev.timeoutMs,
    retry: { maxRetries: 1 },
  });
  return async (state, questions) => {
    // 一次请求拿到全部问题的答案。
    const result = await client.systemOne({ state, questions });
    const probabilities: Record<string, number> = {};
    for (const [name, answer] of Object.entries(result.answers)) {
      // 只有 noul 类型才是「是」的概率；其它答案类型不参与判定。
      if (answer.type === "noul") probabilities[name] = answer.noul;
    }
    return probabilities;
  };
}
