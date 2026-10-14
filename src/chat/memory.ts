/**
 * memory.ts —— 长期记忆：群聊与私聊分开、按 QQ 号存。
 *
 * 数据模型：每个 Person 对应一个 QQ 号，group/private 数组分别保存该人在群聊、
 * 私聊里被记住的事实；回复时私聊来源的事实标注「私聊里告诉你的」。
 * 学习流程：runtime 在 bot 实际回复后调用 learn()（范围为触发该次回复的那批消息），
 * 把「场景 + 已有记忆 + 新聊天记录」交给 extract（deepseek-flash JSON 调用）；只允许更新本批次实际发言的人，
 * 事实去重、单条截断（MAX_FACT_CHARS 字符）后写入。
 * 持久化：内存 Map 为唯一数据源，变更后 scheduleSave() 延迟 2 秒合并写盘，
 * flush() 立即落盘（临时文件 + rename 原子替换，权限 0o600）。
 * 约束：记忆文件含群友个人信息，位于 data/ 目录、不得提交公开。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { config } from "../config.js";
import { logger } from "../logger.js";
import { formatLine, type ChatRecord, type Scope } from "./history.js";

/** 一个人的长期记忆；group/private 分场景保存，回复时能区分信息从哪来。 */
export type Person = {
  /** QQ 号，同时也是 Map 的键。 */
  userId: number;
  /** 最近一次学习时记录的展示名。 */
  name: string;
  /** 群聊场景下记住的事实。 */
  group: string[];
  /** 私聊场景下记住的事实（回复时标注「私聊里告诉你的」）。 */
  private: string[];
  /** 最近一次更新记忆的时间戳（毫秒）。 */
  updatedAt: number;
};

/** 注入的 JSON 抽取器：传入 system/user 提示词，返回解析后的 JSON（重试策略由实现方负责）。 */
export type ExtractJson = (system: string, user: string) => Promise<unknown>;

// 单条事实最大字符数，避免模型长篇大论挤占提示词。
const MAX_FACT_CHARS = 60;

// 记录时间在提示词里的格式（HH:mm，固定上海时区，避免服务器时区不同导致时间线错乱）。
function clock(time: number): string {
  return new Date(time).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" });
}

/** 长期记忆仓库：内存 Map + 延迟批量落盘；学习由 learn() 驱动。 */
export class MemoryStore {
  private readonly people = new Map<number, Person>();
  // 延迟保存定时器；非空表示已排队一次写入，避免高频变更反复写盘
  private saveTimer: NodeJS.Timeout | undefined;

  /**
   * @param file 记忆文件路径（data/memory.json）
   * @param extract JSON 抽取器（deepseek-flash）
   */
  constructor(
    private readonly file: string,
    private readonly extract: ExtractJson,
  ) {}

  /** 启动时读取记忆文件；文件不存在（首次运行）视为空库，其余 IO/解析错误照常抛出。 */
  async load(): Promise<void> {
    try {
      const list = JSON.parse(await readFile(this.file, "utf8")) as Person[];
      for (const person of list) this.people.set(person.userId, person);
    } catch (error) {
      // 仅吞「文件不存在」：真正的损坏/权限问题不应被静默
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  /** 已记住的人数。 */
  get size(): number {
    return this.people.size;
  }

  /** 取某人的记忆；没记录过则 undefined。 */
  get(userId: number): Person | undefined {
    return this.people.get(userId);
  }

  /**
   * 为一段聊天记录生成「相关人物记忆」提示行。
   * 收录对象：记录里发过言或被 @ 到、且已有记忆的人，每人一行。
   * @param records 当前上下文的聊天记录
   * @returns 形如「名字：事实1；事实2」的行数组；私聊来源标注「私聊里告诉你的」
   */
  describe(records: ChatRecord[]): string[] {
    const lines: string[] = [];
    // 同一个人可能既发言又被 @，只输出一次
    const seen = new Set<number>();
    const add = (userId: number, name: string) => {
      if (seen.has(userId)) return;
      seen.add(userId);
      const person = this.people.get(userId);
      // 没有记忆的人不占提示词空间
      if (!person || person.group.length + person.private.length === 0) return;
      const parts = [...person.group];
      // 私聊来源单独标注，让模型自己判断是否适合在当前场景提起
      if (person.private.length > 0) parts.push(`私聊里告诉你的：${person.private.join("；")}`);
      lines.push(`${name}：${parts.join("；")}`);
    };
    for (const record of records) {
      // bot 自己的消息不算「相关人物」
      if (!record.fromBot) add(record.userId, record.name);
      for (const userId of record.mentions ?? []) add(userId, this.people.get(userId)?.name ?? "");
    }
    return lines;
  }

  /**
   * 让模型根据新聊天记录更新本批次发言者的长期记忆。
   * 只更新 records 里实际发过言的人：模型返回的未知/未发言 QQ 号一律忽略（防幻觉）。
   * @param scope 场景（决定更新 Person 的 group 还是 private）
   * @param label 群号或私聊对方称呼，写进提示词作为场景说明
   * @param records 待整理的新消息
   * @param botName bot 的名字（提示词里 bot 以「你」出现）
   * @returns 真正被更新的用户数；0 表示无需保存
   */
  async learn(scope: Scope, label: string, records: ChatRecord[], botName: string): Promise<number> {
    // 本批次实际发言的人（userId → 展示名），同时充当允许更新的白名单
    const speakers = new Map<number, string>();
    for (const record of records) if (!record.fromBot) speakers.set(record.userId, record.name);
    // 全是 bot 自己的消息，没有可学的对象
    if (speakers.size === 0) return 0;

    // 把已有记忆按「- 名字（QQ 号）：事实」列给模型，作为更新的基准
    const known = [...speakers].map(([userId, name]) => {
      const facts = this.people.get(userId)?.[scope] ?? [];
      return `- ${name}（QQ ${userId}）：${facts.length > 0 ? facts.join("；") : "无"}`;
    });
    // 转写为统一记录行，带 [HH:mm] 时间前缀；bot 的消息标注「（你）」
    const transcript = records.map((record) => {
      const who = record.fromBot ? `${botName}（你）` : `${record.name}（QQ ${record.userId}）`;
      return `[${clock(record.time)}] ${formatLine(record, who, botName)}`;
    });
    // 系统提示词：只记长期信息、隐私不记、只输出有变化的人及其完整记忆（JSON）
    const system = [
      `你在整理「${botName}」对聊天对象的长期记忆。只记长期有效、以后聊天用得上的信息：这个人是谁、做什么、喜欢什么、和别人是什么关系、经历过的重要的事。`,
      "某一次说了什么做了什么、聊天里的玩笑、一时的情绪都不用记。住址、学校、联系方式、证件这类隐私不记。",
      "结合新的聊天记录更新已有记忆：合并重复的，改掉被纠正或过时的，去掉不再重要的，每条尽量简短。",
      '只输出 JSON，格式为 {"people":[{"user_id":数字,"facts":["…"]}]}。只列出记忆有变化的人，facts 是这个人更新后的完整记忆。',
    ].join("\n");
    // 用户消息：场景 + 已有记忆 + 新聊天记录
    const user = [
      `场景：${scope === "group" ? `QQ群「${label}」` : `和「${label}」的QQ私聊`}`,
      "已有记忆：",
      ...known,
      "",
      "新的聊天记录：",
      ...transcript,
    ].join("\n");

    const result = (await this.extract(system, user)) as { people?: unknown };
    let updated = 0;
    for (const entry of Array.isArray(result?.people) ? result.people : []) {
      const userId = Number((entry as { user_id?: unknown }).user_id);
      const rawFacts = (entry as { facts?: unknown }).facts;
      // 只允许更新本批次实际发言的人，模型幻觉出的别人的 ID 不会产生任何改动
      if (!speakers.has(userId) || !Array.isArray(rawFacts)) continue;
      // 事实清洗：去重 → 去首尾空白 → 单条截断 → 限制总条数
      const facts = [...new Set(rawFacts.filter((fact): fact is string => typeof fact === "string").map((fact) => fact.trim()))]
        .filter(Boolean)
        .map((fact) => fact.slice(0, MAX_FACT_CHARS))
        .slice(0, config.memory.maxFacts);
      // 首次出现的人先建空壳；name 以本批次看到的为准（可能改了群名片）
      const person = this.people.get(userId) ?? { userId, name: "", group: [], private: [], updatedAt: 0 };
      person.name = speakers.get(userId)!;
      person[scope] = facts;
      person.updatedAt = Date.now();
      this.people.set(userId, person);
      updated++;
      logger.info(`[memory] ${person.name}(${userId}) ${scope}: ${facts.join("；")}`);
    }
    // 有更新才排队保存，避免无变化的空写
    if (updated > 0) this.scheduleSave();
    return updated;
  }

  /**
   * 立即落盘：取消待执行的延迟保存，写临时文件后 rename 原子替换。
   * 0o600 权限因为记忆含群友个人信息。
   */
  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await mkdir(dirname(this.file), { recursive: true });
    // 临时文件名带进程号：多进程或崩溃残留时互不覆盖
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify([...this.people.values()], null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  // 延迟合并保存：2 秒内的多次变更只写一次盘；失败仅告警，不影响聊天主流程。
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush().catch((error) => logger.warn("[memory] 保存失败:", (error as Error).message));
    }, 2000);
  }
}
