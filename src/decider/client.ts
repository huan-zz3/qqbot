/**
 * client.ts —— 通用 decider 判定客户端：一次 POST，把 state + questions 交给判定服务，
 * 取回「问题名 → 为是概率（0–1）」。
 *
 * 只固化通用 decider 接口（请求体 {model,state,questions}；响应 answers[*].noul）；
 * 端点/密钥/模型/超时全部来自 config.decider（.env），代码不含任何 provider 专有常量。
 *
 * 约定：
 * - 只收集 noul 答案作为概率，其它答案类型忽略；调用方对缺失的问题名按 0 处理；
 * - 非 2xx 时先记诊断日志（状态、request-id、Retry-After、截断响应体）再抛出，交给调用方兜底；
 * - DECIDER_API_KEY 未配置时不创建判定函数（见 index.ts），调用方各自处理缺失的兜底分支。
 */
import { config } from "../config.js";
import { errorText } from "../errors.js";
import { logger } from "../logger.js";
import type { DeciderQuestions, DeciderState } from "./questions.js";

/** 判定函数：state 是本次判定输入，questions 是问题名到问题的映射；返回问题名到「是」概率的字典。 */
export type Decider = (state: DeciderState, questions: DeciderQuestions) => Promise<Record<string, number>>;

/** 判定响应里本模块用到的字段，其余忽略。 */
type DecisionsResponse = {
  answers?: Record<string, { type?: string; noul?: number }>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

/**
 * 用 config.decider（apiUrl / apiKey / model / timeoutMs）创建判定函数。
 * @returns 判定函数；某个问题缺失答案时，结果字典中就没有对应键
 */
export function createDecider(): Decider {
  const { apiUrl, apiKey, model, timeoutMs } = config.decider;
  return async (state, questions) => {
    let response: Response;
    try {
      response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        // 通用 decider 请求体：只有 model / state / questions 三个字段。
        body: JSON.stringify({ model, state, questions }),
        // 请求级超时：超时中止请求并抛错，交给调用方兜底。
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // 网络层失败（连接被拒 / 代理不可达 / 超时等）：记下真实原因再抛，避免只剩笼统的 “fetch failed”。
      logger.error(`[decider] ${model} 请求异常：${errorText(error)}`);
      throw error;
    }
    if (!response.ok) {
      // 响应体截断到 500 字符；带上 request-id / Retry-After 便于排查与限流定位。
      const text = await response.text().catch(() => "");
      const requestId = response.headers.get("x-request-id");
      const retryAfter = response.headers.get("retry-after");
      const suffix = `${requestId ? `, request-id=${requestId}` : ""}${retryAfter ? `, retry-after=${retryAfter}` : ""}`;
      logger.error(`[decider] ${model} 请求失败 (${response.status}${suffix}): ${text.slice(0, 500)}`);
      throw new Error(`decider 请求失败 (${response.status}): ${text.slice(0, 500)}`);
    }
    const result = (await response.json()) as DecisionsResponse;
    logger.debug(`[decider] ${model} 判定完成 usage=${JSON.stringify(result.usage)}`);
    const probabilities: Record<string, number> = {};
    for (const [name, answer] of Object.entries(result.answers ?? {})) {
      // 只有 noul 类型才是「是」的概率；其它答案类型不参与判定。
      if (answer.type === "noul" && typeof answer.noul === "number") probabilities[name] = answer.noul;
    }
    return probabilities;
  };
}
