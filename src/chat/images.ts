/**
 * images.ts —— 普通图片识图。
 *
 * 聊天里出现的非表情包图片交给识图模型（独立后端，见 src/llm/vision.ts）识别，结果以 `[图片：描述]` 进入聊天记录。
 * 与 stickers.ts 不同：描述只缓存在内存（进程重启即失效），图片不落盘。
 * 同一张图（按 file/url 去重）只识别一次；缓存的是 Promise，让并发请求共享同一结果；
 * 缓存上限 500 条，超限按插入顺序淘汰最旧的。
 */
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Segment } from "../napcat/types.js";
import { cleanDescription, dataUrl, downloadImage, type Describe } from "./media.js";

// 识图提示词：DeepSeek-OCR 官方推荐的「图像描述」模板（<image> 为图片占位 token）。
const DESCRIBE_PROMPT = "<image>\nDescribe this image in detail. If there are any words on the picture, write them all in. Only objective descriptions are output. Subjective evaluations are prohibited.";
// 内存缓存上限：图片描述只是临时上下文，进程重启即清空，500 条足够覆盖近期图片。
const MAX_CACHE = 500;
// 单条描述截断长度，避免超长文本挤占聊天记录。
const MAX_CHARS = 300;

/** 普通图片描述器：内存缓存 + 任务去重，图片与描述都不落盘。 */
export class ImageDescriber {
  // 缓存的是进行中/已完成的识图任务（Promise），并发同一张图只识别一次
  private readonly cache = new Map<string, Promise<string | undefined>>();

  /** @param describe 识图函数（data URL → 描述） */
  constructor(private readonly describe: Describe) {}

  /**
   * 获取图片描述；首次见到这张图时触发识图，重复出现直接返回缓存。
   * @returns 描述文本；无 URL 或识图失败时为 undefined
   */
  observe(segment: Segment): Promise<string | undefined> {
    const url = typeof segment.data.url === "string" ? segment.data.url : undefined;
    // 没有 URL 的图片（如仅本地文件标识）无法识图
    if (!url) return Promise.resolve(undefined);
    // 缓存键优先用 file 标识（同图不同 URL 时更稳定），退回 url
    const key = typeof segment.data.file === "string" && segment.data.file ? segment.data.file : url;
    let task = this.cache.get(key);
    if (!task) {
      task = this.run(url);
      this.cache.set(key, task);
      // Map 保持插入顺序：超限时删最早的一条
      if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    }
    return task;
  }

  // 实际识图：下载（按配置上限）→ 描述 → 清洗 → 截断；失败返回 undefined。
  private async run(url: string): Promise<string | undefined> {
    try {
      const image = await downloadImage(url, config.images.maxBytes);
      const description = cleanDescription(await this.describe(dataUrl(image))).slice(0, MAX_CHARS);
      if (description) logger.info(`[image] ${description}`);
      // 空字符串归一为 undefined，让调用方统一按「无描述」处理
      return description || undefined;
    } catch (error) {
      // 识图失败只记 debug：消息不带描述继续，不影响聊天
      logger.debug("[image] 跳过:", (error as Error).message);
      return undefined;
    }
  }
}

/**
 * 把「通用识图函数」适配成普通图片专用的 Describe（固定提示词）。
 * @param describeImage 底层识图函数（data URL + 指令 → 描述）
 */
export function describeImageWith(describeImage: (dataUrl: string, instruction: string) => Promise<string>): Describe {
  return (url) => describeImage(url, DESCRIBE_PROMPT);
}
