/**
 * voice.ts —— 语音标记解析与语音切分的纯逻辑（不涉及网络/IO）。
 *
 * 模型在行首写 [语音] 或 [语音:happy] 表示这一行要合成语音发出；
 * 本模块负责取出标记与情绪、清洗不该被念出来的成分、并按语速把文本切成片段。
 */
import { FACE_IDS } from "../napcat/faces.js";

/** MiniMax 语音情绪枚举；顺序即提示词里的列举顺序。 */
export type VoiceEmotion = "happy" | "sad" | "angry" | "fearful" | "disgusted" | "surprised" | "calm";

/** 全部已知情绪（供启动校验与提示词列举）。 */
export const VOICE_EMOTIONS: readonly VoiceEmotion[] = ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm"];

// 行首（允许前导空白）的 [语音] 或 [语音:happy]；冒号半/全角均可，后可有空格，情绪名大小写不敏感。
// 锚定行首：聊天记录里入站语音的占位符也叫 [语音]，锚定后才不会把模型复述的正文误转成语音。
const VOICE_MARKER = /^\s*\[语音(?:[:：]\s*([A-Za-z]+))?\]/i;

// [表情包#编号]：来自模型的自定义发送语法。
const STICKER_MARKER = /\[表情包#\d+\]/g;

// [名称] 形式的方括号标记；具体是不是 QQ 小黄脸由 FACE_IDS 决定。
const BRACKET_TOKEN = /\[([^[\]]+)\]/g;

/**
 * 取出并删除行首的语音标记。
 * @returns 没有行首标记时 undefined；否则为删掉该标记后的剩余原文（trim）与情绪。
 *   情绪只认已知值；纯 [语音] 或未知情绪名 → emotion 为 undefined。
 *   行中出现的 [语音] 不算标记（聊天记录里的入站语音占位符就是这个名字），原样保留。
 */
export function takeVoiceMarker(line: string): { text: string; emotion?: VoiceEmotion } | undefined {
  const match = VOICE_MARKER.exec(line);
  if (!match) return undefined;
  let emotion: VoiceEmotion | undefined;
  if (match[1]) {
    const name = match[1].toLowerCase() as VoiceEmotion;
    if (VOICE_EMOTIONS.includes(name)) emotion = name;
  }
  const text = line.slice(0, match.index) + line.slice(match.index + match[0].length);
  return { text: text.trim(), emotion };
}

/**
 * 清洗要念出来的文本：去掉表情包标记、@ 符号本身、QQ 小黄脸标记，折叠连续空白。
 * 保留 MiniMax 语气词标签（如 (laughs)）。
 */
export function cleanSpokenText(text: string): string {
  return text
    .replace(STICKER_MARKER, "")
    .replace(/@/g, "")
    .replace(BRACKET_TOKEN, (match, name: string) => (FACE_IDS[name] === undefined ? match : ""))
    .replace(/\s+/g, " ")
    .trim();
}

// 句末标点与换行：切句后标点留在句尾。
const SENTENCE_END = new Set(["。", "！", "？", "!", "?", "；", ";", "…", "\n"]);
// 单句超预算时的二次切分点（字符本身留在前一段末尾）。
const CLAUSE_END = new Set(["，", "、", ",", " "]);

/** 按句末标点与换行切句；丢弃纯空白片段。 */
function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = "";
  for (const char of text) {
    if (char === "\n") {
      if (current.trim()) sentences.push(current.trim());
      current = "";
      continue;
    }
    current += char;
    if (SENTENCE_END.has(char)) {
      if (current.trim()) sentences.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) sentences.push(current.trim());
  return sentences;
}

/** 相邻片段贪心合并：再加一片会超预算就另起一段。 */
function mergeGreedy(pieces: string[], budget: number): string[] {
  const merged: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length > budget) {
      merged.push(current);
      current = piece;
    } else {
      current += piece;
    }
  }
  if (current) merged.push(current);
  return merged;
}

/** 按固定长度硬切（兜底，绝不产出超预算片段）；按码点切，避免把代理对拆成孤立代理项。 */
function hardCut(text: string, budget: number): string[] {
  const chars = Array.from(text);
  const pieces: string[] = [];
  for (let index = 0; index < chars.length; index += budget) pieces.push(chars.slice(index, index + budget).join(""));
  return pieces;
}

/** 单句超预算时按逗号/顿号/空格二次切；仍超就硬切。 */
function splitLongSentence(sentence: string, budget: number): string[] {
  if (sentence.length <= budget) return [sentence];
  const clauses: string[] = [];
  let current = "";
  for (const char of sentence) {
    current += char;
    if (CLAUSE_END.has(char)) {
      if (current.trim()) clauses.push(current);
      current = "";
    }
  }
  if (current.trim()) clauses.push(current);
  const pieces = clauses.flatMap((clause) => (clause.length <= budget ? [clause] : hardCut(clause, budget)));
  return mergeGreedy(pieces, budget).map((piece) => piece.trim()).filter(Boolean);
}

/**
 * 按语速把文本切成若干语音片段。
 * @param maxSeconds 单条语音的时长上限（秒）。
 * @param speed MiniMax 语速倍率。
 * @returns 每段的字符数不超过 max(1, floor(maxSeconds * 4.5 * speed))；空输入返回空数组。
 */
export function planVoicePieces(text: string, maxSeconds: number, speed: number): string[] {
  const budget = Math.max(1, Math.floor(maxSeconds * 4.5 * speed));
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];
  const pieces = sentences.flatMap((sentence) => splitLongSentence(sentence, budget));
  return mergeGreedy(pieces, budget).map((piece) => piece.trim()).filter(Boolean);
}
