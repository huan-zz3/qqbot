/**
 * client.ts —— 通用 decider 判定客户端：一次 POST，把 state + questions 交给判定服务，
 * 取回「问题名 → 为是概率（0–1）」。
 *
 * 只固化通用 decider 接口（请求体 {model,state,questions}；响应 answers[*].noul）；
 * 端点/模型/超时全部来自 config.decider（.env），代码不含任何 provider 专有常量。
 *
 * 多密钥：DECIDER_API_KEY 可配多个（逗号/空白分隔），共用同一端点与模型。每次判定按优先级
 * 从高到低依次尝试：某个密钥抛错（网络/超时/非 2xx）就换下一个，某个密钥成功即提升为最高
 * 优先级（move-to-front，仅进程内存，重启回到配置顺序）。全部失败才抛出，交调用方兜底。
 * 优先级重排与脱敏的纯逻辑见 keys.ts。
 *
 * 约定：
 * - 只收集 noul 答案作为概率，其它答案类型忽略；调用方对缺失的问题名按 0 处理；
 * - 非 2xx 时错误信息带上状态、request-id、Retry-After、截断响应体，交给调用方兜底；
 * - DECIDER_API_KEY 未配置时不创建判定函数（见 index.ts），调用方各自处理缺失的兜底分支。
 */
import { config } from "../config.js";
import { errorText } from "../errors.js";
import { logger } from "../logger.js";
import { dumpPrompt } from "../prompt-dump.js";
import { maskKey, promote, uniqueKeys } from "./keys.js";
import type { DeciderQuestions, DeciderState } from "./questions.js";

/** 判定函数：state 是本次判定输入，questions 是问题名到问题的映射；返回问题名到「是」概率的字典。 */
export type Decider = (state: DeciderState, questions: DeciderQuestions) => Promise<Record<string, number>>;

/** 判定响应里本模块用到的字段，其余忽略。 */
type DecisionsResponse = {
  answers?: Record<string, { type?: string; noul?: number }>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

/**
 * 用 config.decider（apiUrl / apiKeys / model / timeoutMs）创建判定函数。
 * @returns 判定函数；某个问题缺失答案时，结果字典中就没有对应键
 */
export function createDecider(): Decider {
  const { apiUrl, apiKeys, model, timeoutMs } = config.decider;
  // 进程内的优先级顺序：初始即配置顺序（去重后的副本），成功后 move-to-front。
  let order = uniqueKeys(apiKeys);

  /** 用指定密钥请求一次；任何失败（网络/超时/非 2xx）都抛出，不在内部记日志。 */
  async function requestOnce(
    key: string,
    state: DeciderState,
    questions: DeciderQuestions,
  ): Promise<Record<string, number>> {
    // 通用 decider 请求体：只有 model / state / questions 三个字段。
    const body = { model, state, questions };
    // 调试落盘：目录未配置时为空操作，失败不影响请求。
    dumpPrompt("decider", body);
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      // 请求级超时：超时中止请求并抛错，交给调用方兜底。
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // 响应体截断到 500 字符；带上 request-id / Retry-After 便于排查与限流定位。
      const text = await response.text().catch(() => "");
      const requestId = response.headers.get("x-request-id");
      const retryAfter = response.headers.get("retry-after");
      const suffix = `${requestId ? `, request-id=${requestId}` : ""}${retryAfter ? `, retry-after=${retryAfter}` : ""}`;
      throw new Error(`decider 请求失败 (${response.status}${suffix}): ${text.slice(0, 500)}`);
    }
    const result = (await response.json()) as DecisionsResponse;
    logger.debug(`[decider] ${model} 判定完成 usage=${JSON.stringify(result.usage)}`);
    const probabilities: Record<string, number> = {};
    for (const [name, answer] of Object.entries(result.answers ?? {})) {
      // 只有 noul 类型才是「是」的概率；其它答案类型不参与判定。
      if (answer.type === "noul" && typeof answer.noul === "number") probabilities[name] = answer.noul;
    }
    return probabilities;
  }

  return async (state, questions) => {
    let lastError: unknown;
    // 按当前优先级逐个尝试：失败换下一个，成功则（若非首选）提升到队首并返回。
    for (let i = 0; i < order.length; i += 1) {
      const key = order[i]!;
      const label = maskKey(key);
      try {
        const result = await requestOnce(key, state, questions);
        if (i > 0) {
          order = promote(order, key);
          logger.info(`[decider] ${model} 密钥 ${label} 成功，提升为最高优先级`);
        }
        return result;
      } catch (error) {
        lastError = error;
        const more = i < order.length - 1 ? "，改用下一个密钥" : "";
        logger.error(`[decider] ${model} 密钥 ${label} 请求失败${more}：${errorText(error)}`);
      }
    }
    if (lastError === undefined) throw new Error("decider 未配置任何密钥");
    logger.error(`[decider] ${model} 全部 ${order.length} 个密钥均请求失败`);
    throw lastError;
  };
}
