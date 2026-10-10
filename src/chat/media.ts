/**
 * media.ts —— 图片下载、格式识别与描述清洗的公共工具。
 *
 * 被 stickers.ts / images.ts 共用：
 *   - downloadImage：15 秒超时下载，校验大小上限，按字节魔数识别 MIME；
 *   - dataUrl：转 base64 data URL，供多模态识图接口消费；
 *   - cleanDescription：清理识图输出里「（图中无文字）」类噪声并压成单行。
 * Describe 是识图函数的统一契约：输入 data URL，返回描述文本。
 */

/** 识图函数契约：输入 base64 data URL，返回描述文本。 */
export type Describe = (dataUrl: string) => Promise<string>;

/**
 * 按文件头魔数识别图片格式。
 * @returns MIME 字符串；不是支持的图片（GIF/PNG/JPEG/WEBP）时 undefined
 */
export function sniffMime(bytes: Buffer): string | undefined {
  // GIF87a / GIF89a 均以 "GIF" 开头
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  // PNG 签名：首字节 0x89 后跟 "PNG"
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString("ascii") === "PNG") return "image/png";
  // JPEG 签名：FF D8（SOI 标记）
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  // WEBP：RIFF 容器，第 8–12 字节为 "WEBP"
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

/**
 * 下载图片并完成校验。
 * @param url 图片地址
 * @param maxBytes 体积上限（字节），超出抛错
 * @returns 原始字节与识别出的 MIME
 * 以下情况抛 Error：HTTP 非 2xx、15 秒超时、超过 maxBytes、格式不可识别。
 */
export async function downloadImage(url: string, maxBytes: number): Promise<{ bytes: Buffer; mime: string }> {
  // 15 秒超时兜底，防止某个图源挂起整个识图/收藏流程
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`下载失败 ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  // 先查大小再识格式：超大文件直接放弃，避免无效处理
  if (bytes.length > maxBytes) throw new Error(`太大 ${bytes.length}`);
  // 按字节内容识别格式而非响应头：既校验真是图片，也为存盘扩展名提供可靠 MIME
  const mime = sniffMime(bytes);
  if (!mime) throw new Error("不是可识别的图片");
  return { bytes, mime };
}

/** 把图片字节转成 base64 data URL（多模态识图接口的输入格式）。 */
export function dataUrl(image: { bytes: Buffer; mime: string }): string {
  return `data:${image.mime};base64,${image.bytes.toString("base64")}`;
}

/**
 * 清洗识图输出：识图模型常主动声明图里没有文字（如「（图中无文字）」），
 * 这在聊天上下文里是噪声。处理顺序：压单行 → 删「无文字」括号整句 →
 * 删句中「图中没有文字」类短语 → 去掉删除后残留的开头标点。
 */
export function cleanDescription(text: string): string {
  return text
    // 所有空白压成单空格，保证描述可嵌入单行聊天记录
    .replace(/\s+/g, " ")
    // 括号内容整体在说「没有/无文字」时，连括号一起删
    .replace(/[（(][^（）()]*(?:无|没有)[^（）()]*文字[^（）()]*[）)]/g, "")
    // 句中「图中没有文字」类短语（可选修饰词 + 可选尾随标点）
    .replace(/(?:图片|图中|图上|图内|画面)?(?:中|上|里)?(?:没有|无)(?:任何)?文字[，,、；;。]?/g, "")
    // 删除后可能残留开头的标点/空白
    .replace(/^[，,、；;\s]+/, "")
    .trim();
}
