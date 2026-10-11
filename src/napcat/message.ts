/**
 * message.ts —— 消息段与人类可读文本的双向转换（OneBot 消息渲染/构造层）
 * 出方向（收消息）：toSegments / renderSegments / markdownToText 与 is* 系列判断，
 *   把入站段数组渲染成一行文本（聊天记录、decider/模型输入都用它），
 *   如「@某人 你好 [doge] [图片：描述]」；未知段类型用 PLACEHOLDERS 占位。
 * 入方向（发消息）：textToSegments / facesToSegments / textSegment / replySegment，
 *   把模型输出转回消息段：@名字 → 真 @（需成员表）、[名称] → QQ 小黄脸 face 段。
 * 重要约束：渲染文本会被写进聊天记录并作为模型输入，格式需保持稳定；
 * 绝不把 QQ 号渲染进文本——模型会把它念出来（@ 优先用名字，「某人」兜底）。
 */

import { FACE_IDS, faceName } from "./faces.js";
import type { Segment } from "./types.js";

/**
 * 渲染上下文：调用方补齐渲染所需的外部信息。
 * selfId 用于识别 @自己；imageText/atName 是可选的按需查询（识图描述、群名片）。
 */
export type RenderContext = {
  // bot 自己的 QQ 号；为 undefined 时无法把 @自己 特判成 @botName。
  selfId?: number;
  // bot 的显示名（config.bot.name），用于渲染 @自己。
  botName: string;
  // 表情包/图片段的识图描述（调用方提供）；取不到时只渲染 [表情包]/[图片]。
  imageText?: (segment: Segment) => string | undefined;
  // 被 @ 用户的显示名（调用方按 QQ 号查群名片，查不到返回 undefined）。
  atName?: (userId: number) => string | undefined;
};

// 无法/无需还原成文字的消息段类型的占位文本，按段类型（type）索引。
// 这些段的细节对聊天语义价值有限，统一渲染成 [xxx]：既不丢类型信息，也不把原始 JSON 暴露给模型。
// 未列入的类型在 renderSegments 的 default 分支退化为 [类型名]。
const PLACEHOLDERS: Record<string, string> = {
  dice: "[骰子]",
  rps: "[猜拳]",
  record: "[语音]",
  video: "[视频]",
  forward: "[合并转发]",
  node: "[合并转发]",
  json: "[卡片]",
  xml: "[卡片]",
  poke: "[戳一戳]",
  contact: "[名片]",
  location: "[位置]",
  music: "[音乐]",
  share: "[链接]",
};

/**
 * 把事件里的 message 字段统一成消息段数组。
 * NapCat 配置为 messagePostFormat: "array" 时已是数组；字符串（CQ 码文本）只作兜底，
 * 整体包成一个 text 段——本项目不解析 CQ 码。
 * @param message 事件里的 message 字段（数组、字符串或缺失）
 * @returns 消息段数组；无效输入返回空数组（调用方可直接遍历）
 */
export function toSegments(message: Segment[] | string | undefined): Segment[] {
  // 数组：过滤掉 null 等没有字符串 type 的脏元素，下游可假定每段 type 合法。
  if (Array.isArray(message)) return message.filter((seg) => seg && typeof seg.type === "string");
  // 字符串：原样作为一条文本消息；空串不产生段。
  if (typeof message === "string" && message) return [{ type: "text", data: { text: message } }];
  return [];
}

/** OneBot 的 ID 字段有时是字符串（如 at 段的 qq）有时是数字；统一成 number，非法值返回 undefined。 */
function asId(value: unknown): number | undefined {
  const id = typeof value === "string" ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
}

// Markdown 消息常把文字包在 LaTeX 样式里（如 $\textcolor{red}{就}$）；这里剥掉外壳只留内容。
// 双参数命令（\textcolor{红}{内容}）：取第二个参数作为正文。
const LATEX_TWO_ARG = /\\(?:textcolor|colorbox|scalebox|color)\{[^{}]*\}\{([^{}]*)\}/g;
// 单参数命令（\text{内容} 等）：取括号内作为正文。
const LATEX_ONE_ARG = /\\(?:text|textbf|textit|mathbf|mathrm|boxed|underline)\{([^{}]*)\}/g;

/**
 * 把 markdown 段内容粗加工成纯文本：剥离 LaTeX 样式外壳、图片/链接语法、标题与加粗标记等。
 * @param content markdown 原文
 * @returns 可用于聊天记录展示的纯文本
 */
export function markdownToText(content: string): string {
  let text = content;
  // 反复替换直到一轮没有任何变化：样式命令可以嵌套（如 \textcolor{red}{\text{就}}），一次替换剥不干净。
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(LATEX_TWO_ARG, "$1").replace(LATEX_ONE_ARG, "$1");
  }
  // 图片与链接语法先处理：图片换成 [图片]，链接只保留可点击文字。
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // 再清掉残留的反斜杠命令与 LaTeX 语法符号（$ { }）。
    .replace(/\\[a-zA-Z]+\s?/g, "")
    .replace(/[${}]/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * 字节数转人类可读大小（B/KB/MB），用于文件占位文本；均为纯函数便于单测。
 * @param bytes 字节数（非负数）
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 把消息段数组渲染成一行人类可读文本（聊天记录与模型输入共用）。
 * 规则：
 * - text 直接保留（跳过与 markdown 段重复的 fallback 文本）；
 * - at：@全体成员 保留；@自己 显示为 @botName；其他人优先用段里的 name，
 *   再查 ctx.atName，最后用「某人」——绝不输出 QQ 号；
 * - image/mface：按 isSticker 分为 [表情包]/[图片]，有识图描述时带「：描述」；
 * - face：查表显示 [名称]，未知 ID 显示 [表情]；
 * - file：有文件名时渲染成 [文件：名字（大小）]，无名字回退 [文件]；
 * - reply：不渲染（引用关系由上层另取）；其余类型查 PLACEHOLDERS 占位。
 * @param segments 入站消息段数组（通常来自 toSegments）
 * @param ctx 渲染上下文
 * @returns 拼接、清理行尾空白后的整行文本
 */
export function renderSegments(segments: Segment[], ctx: RenderContext): string {
  // Markdown 消息的内容会同时出现在 markdown 段与一个 fallback text 段里；
  // 先收集 markdown 内容，渲染时跳过重复的 text，避免同一段文字出现两遍。
  const markdown = new Set(
    segments.filter((seg) => seg.type === "markdown").map((seg) => String(seg.data.content ?? "")),
  );
  const parts: string[] = [];
  for (const seg of segments) {
    switch (seg.type) {
      case "text": {
        const text = String(seg.data.text ?? "");
        // 与 markdown 段重复的 fallback 文本不再渲染。
        if (!markdown.has(text)) parts.push(text);
        break;
      }
      case "markdown":
        parts.push(markdownToText(String(seg.data.content ?? "")));
        break;
      case "at": {
        if (seg.data.qq === "all") {
          parts.push("@全体成员 ");
          break;
        }
        const id = asId(seg.data.qq);
        // 段里带了显示名（群名片优先、其次昵称）就直接用。
        const name = typeof seg.data.name === "string" && seg.data.name ? seg.data.name : undefined;
        // 绝不退化成原始 QQ 号：模型会把它在群里念出来。
        // @自己 → @botName；其他人按 段内名字 > ctx.atName 反查 >「某人」依次回退。
        if (id !== undefined && id === ctx.selfId) parts.push(`@${ctx.botName} `);
        else parts.push(`@${name ?? (id !== undefined ? ctx.atName?.(id) : undefined) ?? "某人"} `);
        break;
      }
      case "image":
      case "mface": {
        // 表情包与普通图片共用渲染，区分见 isSticker。
        const sticker = isSticker(seg);
        // 识图描述可能尚未生成（图片还在异步识别），取不到时只渲染标签。
        const description = ctx.imageText?.(seg);
        const label = sticker ? "表情包" : "图片";
        parts.push(description ? `[${label}：${description}]` : `[${label}]`);
        break;
      }
      case "face": {
        // QQ 小黄脸：数字 ID 查表转名称（如 179 → doge）；查不到（新版新增等）降级为 [表情]。
        const name = faceName(Number(seg.data.id));
        parts.push(name ? `[${name}]` : "[表情]");
        break;
      }
      case "reply":
        // reply 段不进入正文：引用关系由上层用 replyTargetId 单独解析。
        break;
      case "file": {
        // 群文件/私聊文件：文件名 + 大小（协议端可能不带 file_size）。
        const name = typeof seg.data.file === "string" ? seg.data.file : "";
        const size = Number(seg.data.file_size);
        const label = name && Number.isFinite(size) && size > 0 ? `${name}（${formatSize(size)}）` : name;
        parts.push(label ? `[文件：${label}]` : "[文件]");
        break;
      }
      default:
        // 其余段类型查占位表；表里没有的用 [类型名] 兜底。
        parts.push(PLACEHOLDERS[seg.type] ?? `[${seg.type}]`);
    }
  }
  // 段拼接可能产生行尾空白（如「@全体成员 」后直接换行），统一清理并去掉首尾空白。
  return parts.join("").replace(/[ \t]+\n/g, "\n").trim();
}

/**
 * 判断一个段是否为「表情包」：mface（商城/收藏表情）一律算；
 * image 段中 sub_type=1（收藏表情）或 summary 为 [动画表情] 的也算。
 * 决定渲染标签（表情包/图片）与入站处理走 stickers 还是 images。
 */
export function isSticker(segment: Segment): boolean {
  if (segment.type === "mface") return true;
  return segment.type === "image" && (Number(segment.data.sub_type) === 1 || segment.data.summary === "[动画表情]");
}

/** 消息里是否 @ 了 bot 自己；selfId 未知（尚未取到登录信息）时返回 false，避免误判。 */
export function isAtSelf(segments: Segment[], selfId: number | undefined): boolean {
  if (selfId === undefined) return false;
  return segments.some((seg) => seg.type === "at" && asId(seg.data.qq) === selfId);
}

/** 消息 @ 到的其他群成员 QQ 号（去重、排除 bot 自己）；用于判断「在跟谁说话」。 */
export function atTargets(segments: Segment[], selfId: number | undefined): number[] {
  const ids = segments.filter((seg) => seg.type === "at").map((seg) => asId(seg.data.qq));
  return [...new Set(ids.filter((id): id is number => id !== undefined && id !== selfId))];
}

/** reply 段引用的消息 ID（被引用消息的 message_id）；没有引用时返回 undefined。 */
export function replyTargetId(segments: Segment[]): number | undefined {
  const reply = segments.find((seg) => seg.type === "reply");
  return reply ? asId(reply.data.id) : undefined;
}

/** 段数组里是否含非空白文本（纯图片/表情包消息为 false）。 */
export function hasText(segments: Segment[]): boolean {
  return segments.some((seg) => seg.type === "text" && String(seg.data.text ?? "").trim().length > 0);
}

/** 构造一个纯文本段（最常用的发送形式）。 */
export function textSegment(text: string): Segment {
  return { type: "text", data: { text } };
}

/** 把文本中已知的 [名称] 转成 QQ 小黄脸 face 段，其余原样保留为 text 段。 */
function facesToSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  // 扫描 [内容] 标记：内容限 1~8 个字符且不含方括号、空白，与真实表情名长度相当。
  for (const match of text.matchAll(/\[([^\[\]\s]{1,8})\]/g)) {
    const id = FACE_IDS[match[1]!];
    // 不在表情表里的 [xxx]（如 [链接]、[图片]）不转换，继续留在文本里。
    if (id === undefined) continue;
    // 标记之前的普通文本先落成 text 段。
    if (match.index > cursor) segments.push(textSegment(text.slice(cursor, match.index)));
    segments.push({ type: "face", data: { id: String(id) } });
    cursor = match.index + match[0].length;
  }
  // 收尾：最后一个标记之后的剩余文本。
  if (cursor < text.length) segments.push(textSegment(text.slice(cursor)));
  return segments;
}

/**
 * 把一行文本转成可发送的消息段：已知成员的 "@名字" 转成真 @（名字按长度降序匹配，
 * 群名片可能含空格）、已知的 [名称] 转成 QQ 小黄脸 face 段，其余原样保留为文本。
 * @param text 一行回复文本（可能含 @名字 与 [名称]）
 * @param members 「显示名 → QQ 号」映射（由调用方查群名片/昵称构建）；默认空表示不转换 @
 * @returns 消息段数组
 */
export function textToSegments(text: string, members: Map<string, number> = new Map()): Segment[] {
  // 按名字长度降序：保证「张三丰」先于「张三」匹配到。
  const names = [...members.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  const segments: Segment[] = [];
  let buffer = "";
  let i = 0;
  // 逐字符扫描；只在 @ 后面紧跟已知成员名时才转真 @，未命中的 @ 当普通字符。
  while (i < text.length) {
    if (text[i] === "@") {
      const name = names.find((candidate) => text.startsWith(candidate, i + 1));
      if (name) {
        // 命中前积累的普通文本先落段（其中的 [名称] 也要转成表情）。
        if (buffer) segments.push(...facesToSegments(buffer));
        buffer = "";
        segments.push({ type: "at", data: { qq: String(members.get(name)) } });
        // 跳过 @名字 本体与紧跟的一个空格，再补一个空格段，避免 @ 与后文粘连。
        i += name.length + 1;
        if (text[i] === " ") i++;
        segments.push(textSegment(" "));
        continue;
      }
    }
    buffer += text[i];
    i++;
  }
  if (buffer) segments.push(...facesToSegments(buffer));
  // 结尾的 @ 之后不留多余空格段。
  if (segments.at(-1)?.type === "text" && segments.at(-1)?.data.text === " ") segments.pop();
  return segments;
}

/** 构造 reply 段，把回复标记为引用某条消息（messageId 为被引用消息的 message_id）。 */
export function replySegment(messageId: number): Segment {
  return { type: "reply", data: { id: String(messageId) } };
}
