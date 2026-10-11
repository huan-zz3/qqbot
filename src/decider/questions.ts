/**
 * questions.ts —— 通用 decider 协议：判定输入（state）与命名问题（questions）的类型，以及
 * noul（是/否）问题的构造器。与具体 provider 无关（端点/密钥/模型见 config.decider）。
 *
 * 只实现本判定层实际用到的 noul 问题；choice / score 等未用到，不在此定义。
 */

/** JSON 值（state 里可能出现的任意嵌套结构）。 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** 判定输入：每个问题都针对这份内容作答（字符串、对象或数组）。 */
export type DeciderState = JsonValue;

/** noul（是/否）问题：instructions 是问题或待核验的陈述；criteria 可选，给出是/否两面的判定标准。 */
export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
};

/** 命名问题映射：问题名 → 问题；响应按同名返回答案。 */
export type DeciderQuestions = Record<string, NoulQuestion>;

/** 构造一个 noul 问题；criteria 省略时只给 instructions。 */
export function noul(instructions: string, criteria?: { true: string; false: string }): NoulQuestion {
  return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
}
