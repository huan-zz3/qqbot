/**
 * vision.ts —— 图像识别（视觉理解）的底层调用封装，与回复模型完全独立。
 *
 * 后端写死：SiliconFlow 的 deepseek-ai/DeepSeek-OCR，走 OpenAI 兼容的 /chat/completions。
 * 只有 apiKey 与少量请求参数来自 config.vision（VISION_* 环境变量）。
 *
 * 与 deepseek.ts 的关系：两者仅共享同一个调用契约 (dataUrl, instruction) => Promise<string>，
 * 互不引用；识图请求体的字段（image_url 的 detail、无 DeepSeek 的 thinking）也不同于回复模型。
 *
 * 注意：模型与端点写死在代码里，与 DEEPSEEK_MODEL 一样不提供切换或降级；是否启用识图由
 * IMAGES_ENABLED / STICKERS_ENABLED 决定，缺 VISION_API_KEY 时由 index.ts 在启动时报错退出。
 */
import { config } from "../config.js";

/** 写死的识图模型：SiliconFlow 的 DeepSeek-OCR（仅用于图像识别）。 */
export const VISION_MODEL = "deepseek-ai/DeepSeek-OCR";

/** 写死的识图端点：SiliconFlow（OpenAI 兼容），末尾不带斜杠。 */
const VISION_BASE_URL = "https://api.siliconflow.cn/v1";

/** /chat/completions 原始响应中本模块用到的字段，其余忽略。 */
type VisionResponse = { choices?: Array<{ message?: { content?: string | null } }> };

/**
 * 识图：把图片（data URL）与指令一起发给识图模型，返回描述文本。
 *
 * @param dataUrl 图片的 data URL
 * @param instruction 识图指令
 * @returns 模型输出文本（trim 后）；无内容时为空字符串
 */
export async function describeImage(dataUrl: string, instruction: string): Promise<string> {
  const body: Record<string, unknown> = {
    model: VISION_MODEL,
    messages: [
      {
        role: "user",
        // 图片在前、指令文本在后。
        content: [
          { type: "image_url", image_url: { url: dataUrl, detail: config.vision.detail } },
          { type: "text", text: instruction },
        ],
      },
    ],
    max_tokens: config.vision.maxTokens,
    stream: false,
  };

  const response = await fetch(`${VISION_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.vision.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    // 请求级超时：超时中止请求并抛错。
    signal: AbortSignal.timeout(config.vision.timeoutMs),
  });
  if (!response.ok) {
    // 响应体截断到 500 字符，便于在错误信息里定位服务端问题。
    const text = await response.text().catch(() => "");
    throw new Error(`识图请求失败 (${response.status}): ${text.slice(0, 500)}`);
  }
  const result = (await response.json()) as VisionResponse;
  return result.choices?.[0]?.message?.content?.trim() ?? "";
}
