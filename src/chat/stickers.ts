/**
 * stickers.ts —— 表情包收藏、识图描述与重发。
 *
 * 流程：群友发自定义表情（image）或商城表情（mface）时 observe() 首次入库——
 * 下载（上限 3MB）→ 识图模型写一句描述（独立后端，见 src/llm/vision.ts）→ 图片存 data/stickers/
 * （文件名取去重键的 sha1 前 16 位）→ 记入 index.json（seen/used/lastSeen 计数）。
 * 聊天记录里显示为 `[表情包：描述]`；list() 把被群友发得最多的若干张打乱后随系统
 * 提示词给模型（不按 bot 自己用的次数排，防止自我强化），模型回复 `[表情包#编号]`
 * 时 byId() 查找、toSegment() 发送。
 * 淘汰：数量超过 maxStickers 时按 seen + used*2 升序删除（用得少的先删）。
 * 两级存储：淘汰不丢描述——条目转入 archive（archive.json，只留描述与计数、无文件）；
 * 再次出现时直接复用归档描述、绝不再识图，并在「活跃未满或归档分数不低于活跃最低分」
 * 时提升回活跃收藏（image 重新下载文件；mface 从当前段重建原字段、无需下载）。
 * 约束：商城表情保存原始段字段，重发时用 mface 以保留 QQ 原生样式；普通图片以
 * base64 上传、sub_type=1 标记为动画表情；收藏失败不阻塞聊天，下次出现可重试。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Segment } from "../napcat/types.js";
import { cleanDescription, dataUrl, downloadImage, type Describe } from "./media.js";

/** 一张已收藏的表情包。 */
export type Sticker = {
  /** 递增编号，模型以 `[表情包#编号]` 引用。 */
  id: number;
  /** 去重键：mface:xxx（商城表情）或 image:源标识（图片）。 */
  key: string;
  // 商城表情提升时无需图片文件，此时缺省；普通图片与首次收藏的商城表情都有。
  file?: string;
  /** 图片 MIME 类型；仅收藏时用于生成文件名，之后不再读取。 */
  mime?: string;
  // 商城表情保存原始段字段，重发时按 mface 发送以保留 QQ 原生样式。
  mface?: Record<string, unknown>;
  /** 识图得到的一句话描述，聊天记录里展示。 */
  description: string;
  /** 被群友发送过的次数（候选排序与淘汰用）。 */
  seen: number;
  /** 被 bot 发送过的次数（淘汰时权重加倍）。 */
  used: number;
  /** 最近一次出现的时间戳（毫秒）。 */
  lastSeen: number;
};

/** 淘汰后转入归档的表情：只留描述与统计、不含文件，再次出现时据此免识图。 */
export type ArchivedSticker = {
  key: string;
  description: string;
  seen: number;
  used: number;
  lastSeen: number;
};

// 表情包下载上限 3MB：超过的动图/大图放弃收藏，控制存储与识图成本。
const MAX_BYTES = 3 * 1024 * 1024;
// 归档文件名：与 index.json 同目录，独立存放淘汰后保留的描述。
const ARCHIVE_FILE = "archive.json";
// 识图提示词：DeepSeek-OCR 官方推荐的「图像描述」模板（<image> 为图片占位 token），并要求一句话输出。
const DESCRIBE_PROMPT = "<image>\nDescribe this image in detail. Output in one sentence.";

// 生成去重键：mface 优先 emoji_id（退回 key），图片用 file（退回 url）；
// 两者都拿不到时返回 undefined，表示这张表情无法收藏。
function stickerKey(segment: Segment): string | undefined {
  if (segment.type === "mface") {
    const id = segment.data.emoji_id ?? segment.data.key;
    return id ? `mface:${String(id)}` : undefined;
  }
  const source = segment.data.file ?? segment.data.url;
  return typeof source === "string" && source ? `image:${source}` : undefined;
}

/** 表情包仓库：内存索引 + data/stickers/ 文件存储，首次见到时异步收藏。 */
export class StickerStore {
  private stickers = new Map<string, Sticker>();
  // 淘汰后保留描述与计数的归档；再次出现时据此直接复用描述、不重新识图。
  private archive = new Map<string, ArchivedSticker>();
  // 同一张表情的进行中任务（收藏或归档提升）：并发出现时复用，避免重复下载/识图
  private inflight = new Map<string, Promise<Sticker | undefined>>();
  private nextId = 1;
  // 延迟保存定时器（同 MemoryStore，2 秒合并写盘）
  private saveTimer: NodeJS.Timeout | undefined;

  /**
   * @param dir 表情包存储目录（data/stickers）
   * @param describe 识图函数（data URL → 一句描述）
   * @param maxStickers 活跃收藏上限，超出按 seen + used*2 淘汰
   * @param archiveMax 归档上限，超出按 lastSeen 淘汰最旧的
   */
  constructor(
    private readonly dir: string,
    private readonly describe: Describe,
    private readonly maxStickers = config.stickers.max,
    private readonly archiveMax = config.stickers.archiveMax,
  ) {}

  /** 启动时建目录并读取 index.json / archive.json；顺带清洗历史描述、恢复递增编号。 */
  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      const list = JSON.parse(await readFile(join(this.dir, "index.json"), "utf8")) as Sticker[];
      // 旧描述可能带「（图中无文字）」类噪声，加载时统一清洗
      for (const sticker of list) this.stickers.set(sticker.key, { ...sticker, description: cleanDescription(sticker.description) });
      // 编号从历史最大值 +1 继续，避免 id 复用
      this.nextId = Math.max(0, ...list.map((sticker) => sticker.id)) + 1;
    } catch (error) {
      // 仅吞「文件不存在」；损坏的索引应当暴露
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      const archived = JSON.parse(await readFile(join(this.dir, ARCHIVE_FILE), "utf8")) as ArchivedSticker[];
      for (const entry of archived) this.archive.set(entry.key, { ...entry, description: cleanDescription(entry.description) });
    } catch (error) {
      // 首次运行没有归档文件是正常情况；损坏的归档应当暴露
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  /** 已收藏（活跃）的表情包数量。 */
  get size(): number {
    return this.stickers.size;
  }

  /** 归档中保留描述的表情包数量。 */
  get archiveSize(): number {
    return this.archive.size;
  }

  /**
   * 记录「见到这张表情」并返回其描述；首次见到时触发收藏（下载 + 识图）。
   * 已收藏过、后被淘汰的表情命中归档，直接复用归档描述、不再识图。
   * @returns 描述文本；无法识别/收藏失败时为 undefined（消息照常处理，只是没有描述）
   */
  async observe(segment: Segment): Promise<string | undefined> {
    const key = stickerKey(segment);
    // 拿不到去重键的表情不收藏
    if (!key) return undefined;
    const known = this.stickers.get(key);
    if (known) {
      // 已收藏：只更新出现统计，描述无需重算
      known.seen++;
      known.lastSeen = Date.now();
      this.scheduleSave();
      return known.description;
    }
    const archived = this.archive.get(key);
    if (archived) {
      // 归档命中：绝不重新识图，只更新统计；按规则尝试提升回活跃收藏（并发时复用同一任务）。
      archived.seen++;
      archived.lastSeen = Date.now();
      let task = this.inflight.get(key);
      if (!task) {
        task = this.promote(key, archived, segment).finally(() => this.inflight.delete(key));
        this.inflight.set(key, task);
      }
      await task;
      this.scheduleSave();
      return archived.description;
    }
    // 首次出现：复用进行中的任务；finally 清理保证失败后仍能重试
    let task = this.inflight.get(key);
    if (!task) {
      task = this.collect(key, segment).finally(() => this.inflight.delete(key));
      this.inflight.set(key, task);
    }
    return (await task)?.description;
  }

  /**
   * 取给模型的候选表情：被群友发得最多的前 limit 张，再打乱顺序。
   * 排序只看 seen/lastSeen（群友行为）；打乱避免模型总挑到同一批而自我强化。
   * @param limit 候选数量，默认取配置 promptLimit
   */
  list(limit = config.stickers.promptLimit): Sticker[] {
    const top = [...this.stickers.values()].sort((a, b) => b.seen - a.seen || b.lastSeen - a.lastSeen).slice(0, limit);
    // Fisher–Yates 洗牌
    for (let i = top.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [top[i], top[j]] = [top[j]!, top[i]!];
    }
    return top;
  }

  /** 按编号查找表情（模型输出 `[表情包#编号]` 时用）。 */
  byId(id: number): Sticker | undefined {
    for (const sticker of this.stickers.values()) if (sticker.id === id) return sticker;
    return undefined;
  }

  /** 转成可发送的消息段并记一次使用：商城表情按 mface 原样重发，图片读文件转 base64。 */
  async toSegment(sticker: Sticker): Promise<Segment> {
    sticker.used++;
    this.scheduleSave();
    if (sticker.mface) return { type: "mface", data: sticker.mface };
    // 普通图片必须有文件；缺失说明索引被手工改坏，显式报错而不是发出空图
    if (!sticker.file) throw new Error(`表情包 #${sticker.id} 缺少图片文件`);
    const bytes = await readFile(join(this.dir, sticker.file));
    // sub_type=1 让 QQ 显示为「动画表情」；summary 是客户端降级时的占位文字
    return { type: "image", data: { file: `base64://${bytes.toString("base64")}`, sub_type: 1, summary: "[动画表情]" } };
  }

  /** 立即把索引写入磁盘：临时文件 + rename 原子替换。 */
  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    // 进程号后缀避免与其它进程/残留临时文件互相覆盖
    const indexTmp = join(this.dir, `index.json.${process.pid}.tmp`);
    await writeFile(indexTmp, JSON.stringify([...this.stickers.values()], null, 2));
    await rename(indexTmp, join(this.dir, "index.json"));
    const archiveTmp = join(this.dir, `${ARCHIVE_FILE}.${process.pid}.tmp`);
    await writeFile(archiveTmp, JSON.stringify([...this.archive.values()], null, 2));
    await rename(archiveTmp, join(this.dir, ARCHIVE_FILE));
  }

  // 收藏一张新表情：下载 → 识图 → 存文件 → 入索引 → 淘汰检查；任何失败都不抛出。
  private async collect(key: string, segment: Segment): Promise<Sticker | undefined> {
    const url = typeof segment.data.url === "string" ? segment.data.url : undefined;
    // 没有可下载 URL（如只有本地文件标识）时无法收藏
    if (!url) return undefined;
    try {
      const image = await downloadImage(url, MAX_BYTES);
      const { bytes, mime } = image;
      const description = cleanDescription(await this.describe(dataUrl(image)));
      // 识图结果为空说明这张图没有收藏价值，按失败处理
      if (!description) throw new Error("描述为空");

      // 文件名 = 去重键 sha1 前 16 位 + 扩展名：同一 key 幂等，且不暴露来源 URL
      const file = `${createHash("sha1").update(key).digest("hex").slice(0, 16)}.${mime.split("/")[1]}`;
      await writeFile(join(this.dir, file), bytes);
      const sticker: Sticker = {
        id: this.nextId++,
        key,
        file,
        mime,
        description,
        seen: 1,
        used: 0,
        lastSeen: Date.now(),
      };
      if (segment.type === "mface") {
        // 保存商城表情原始字段，重发时不依赖本地图片而是按 mface 原样发送
        const { emoji_id, emoji_package_id, key: faceKey, summary } = segment.data;
        sticker.mface = { emoji_id, emoji_package_id, key: faceKey, summary };
      }
      this.stickers.set(key, sticker);
      await this.evict();
      this.scheduleSave();
      logger.info(`[sticker] 收藏 #${sticker.id} ${description}`);
      return sticker;
    } catch (error) {
      // 收藏失败只记 debug：不阻塞聊天流程，下次出现还能重试
      logger.debug(`[sticker] 跳过 ${key}:`, (error as Error).message);
      return undefined;
    }
  }

  // 归档命中后的提升：复用已有描述，不调用识图；满足条件时重新物化回活跃收藏。
  // image 需重新下载文件，mface 从当前段重建原字段（无需下载）。
  private async promote(key: string, archived: ArchivedSticker, segment: Segment): Promise<Sticker | undefined> {
    if (!this.shouldPromote(archived)) {
      logger.debug(`[sticker] 归档复用 ${key}`);
      return undefined;
    }
    const url = typeof segment.data.url === "string" ? segment.data.url : undefined;
    try {
      let file: string | undefined;
      let mime: string | undefined;
      let mface: Record<string, unknown> | undefined;
      if (segment.type === "mface") {
        // 商城表情重发用原始字段，无需下载图片
        const { emoji_id, emoji_package_id, key: faceKey, summary } = segment.data;
        mface = { emoji_id, emoji_package_id, key: faceKey, summary };
      } else {
        // 普通图片必须重新下载才能重发
        if (!url) {
          logger.debug(`[sticker] 归档 ${key} 无下载地址，无法提升`);
          return undefined;
        }
        const image = await downloadImage(url, MAX_BYTES);
        mime = image.mime;
        file = `${createHash("sha1").update(key).digest("hex").slice(0, 16)}.${mime.split("/")[1]}`;
        await writeFile(join(this.dir, file), image.bytes);
      }
      const sticker: Sticker = {
        id: this.nextId++,
        key,
        file,
        mime,
        description: archived.description,
        seen: archived.seen,
        used: archived.used,
        lastSeen: archived.lastSeen,
      };
      if (mface) sticker.mface = mface;
      this.archive.delete(key);
      this.stickers.set(key, sticker);
      await this.evict();
      logger.info(`[sticker] 归档提升 #${sticker.id} ${sticker.description}`);
      return sticker;
    } catch (error) {
      // 物化失败：保留归档条目，下次出现再试；不静默（debug 可见）
      logger.debug(`[sticker] 归档提升失败 ${key}:`, (error as Error).message);
      return undefined;
    }
  }

  // 提升判定：活跃还有空间，或该归档分数不低于活跃最低分。
  // 分数门槛避免「提升后立刻又被淘汰」的抖动：提升进来的必然不是最低分。
  private shouldPromote(archived: ArchivedSticker): boolean {
    if (this.stickers.size < this.maxStickers) return true;
    let min = Infinity;
    for (const sticker of this.stickers.values()) min = Math.min(min, sticker.seen + sticker.used * 2);
    return archived.seen + archived.used * 2 >= min;
  }

  // 超过上限时淘汰：评分 = seen + used*2，低者先删；同分再比 lastSeen 更旧的先删。
  // used 权重加倍是让 bot 自己常用的表情不容易被误删。
  // 淘汰不丢描述：条目转入归档，只删文件，供再次出现时免识图复用。
  private async evict(): Promise<void> {
    if (this.stickers.size > this.maxStickers) {
      const victims = [...this.stickers.values()]
        .sort((a, b) => a.seen + a.used * 2 - (b.seen + b.used * 2) || a.lastSeen - b.lastSeen)
        .slice(0, this.stickers.size - this.maxStickers);
      for (const victim of victims) {
        this.stickers.delete(victim.key);
        this.archive.set(victim.key, {
          key: victim.key,
          description: victim.description,
          seen: victim.seen,
          used: victim.used,
          lastSeen: victim.lastSeen,
        });
        // 文件可能已被手动清理，删除失败无需中断
        if (victim.file) await unlink(join(this.dir, victim.file)).catch(() => undefined);
        logger.debug(`[sticker] 淘汰 #${victim.id} → 归档`);
      }
    }
    this.trimArchive();
  }

  // 归档超过上限时按 lastSeen 淘汰最旧的。
  private trimArchive(): void {
    if (this.archive.size <= this.archiveMax) return;
    const victims = [...this.archive.values()]
      .sort((a, b) => a.lastSeen - b.lastSeen)
      .slice(0, this.archive.size - this.archiveMax);
    for (const victim of victims) {
      this.archive.delete(victim.key);
      logger.debug(`[sticker] 归档裁剪 ${victim.key}`);
    }
  }

  // 延迟合并保存：2 秒内多次变更只写一次索引；失败仅告警。
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush().catch((error) => logger.warn("[sticker] 保存索引失败:", (error as Error).message));
    }, 2000);
  }
}

/**
 * 把「通用识图函数」适配成表情包专用的 Describe（固定提示词）。
 * @param describeImage 底层识图函数（data URL + 指令 → 描述）
 */
export function describeSticker(describeImage: (dataUrl: string, instruction: string) => Promise<string>): Describe {
  return (dataUrl) => describeImage(dataUrl, DESCRIBE_PROMPT);
}
