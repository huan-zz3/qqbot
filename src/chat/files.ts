/**
 * files.ts —— 聊天里收到的文件的懒下载与文本读取。
 *
 * 只处理「文本类」文件：按扩展名白名单判定，命中才去解析地址、下载、按 UTF-8 解码。
 * 非文本（图片、压缩包、音视频、Office 文档等）一律判不支持，由上层在上下文里说明，
 * 绝不内联二进制、也不落任何临时文件到磁盘。
 *
 * 读取结果严格三态：text（成功，含是否截断）/ unsupported（类型不支持）/ failed（解析、下载、解码或超限失败）。
 * 每个「没做到」都有明确的 reason，不存在「静默成功但内容为空」的假象。
 *
 * 依赖注入 callAction（NapCat action 调用）与两个上限，不直接依赖 config/client，
 * 便于单测注入假实现（见 tests/files.test.ts）。
 */
import { logger } from "../logger.js";
import type { ActionResponse } from "../napcat/types.js";

/** NapCat action 调用的最小契约；由 client.callAction 传入（注意需绑定 this，见 index.ts）。 */
export type CallAction = <T>(action: string, params: Record<string, unknown>) => Promise<ActionResponse<T>>;

/** 一条聊天里收到的文件引用；只保留解析所需的最小字段。 */
export type FileRef = {
  /** 协议端的 file_id；缺失时无法解析（read 直接判失败）。 */
  fileId?: string;
  /** 文件名（含扩展名）。 */
  name: string;
  /** 文件大小（字节）；协议端附带时才有。 */
  size?: number;
  /** 群文件所属群号；私聊文件缺省（据此选择 get_group_file_url 或 get_file）。 */
  groupId?: number;
};

/** 一个文件的读取结果：成功文本 / 类型不支持 / 失败，三态互斥。 */
export type FileReadResult =
  | { status: "text"; content: string; truncated: boolean }
  | { status: "unsupported"; reason: string }
  | { status: "failed"; reason: string };

// 视为文本、可以读取内容的扩展名白名单（小写、不含点）。不在其中（含无扩展名）一律不支持。
const TEXT_EXTENSIONS = new Set([
  "txt", "text", "md", "markdown", "log", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "csv", "tsv", "xml", "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "go", "rs", "java", "kt",
  "c", "h", "cpp", "hpp", "cc", "cs", "sh", "bash", "zsh", "rb", "php", "pl", "lua", "sql", "env", "srt", "vtt",
]);

// 单次文件下载超时（毫秒）；防止某个文件源挂起整个 opencode 调用。
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** 取文件名的扩展名（小写、不含点）；没有扩展名返回空串。 */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * 文件存储：按 file_id 缓存读取 Promise（同一文件一次运行只解析/下载一次），
 * 对外只暴露 read(ref)，内部完成「判定类型 → 解析地址 → 下载/解码 → 截断」。
 */
export class FileStore {
  // fileId → 读取任务；失败任务也缓存，避免同一文件反复重试拖慢调用。
  private readonly cache = new Map<string, Promise<FileReadResult>>();

  /**
   * @param callAction NapCat action 调用（已绑定 this）。
   * @param maxBytes 单文件下载上限（字节）。
   * @param maxChars 单文件注入字符上限，超出截断。
   */
  constructor(
    private readonly callAction: CallAction,
    private readonly maxBytes: number,
    private readonly maxChars: number,
  ) {}

  /** 读取一个文件的内容；同一 fileId 复用首次结果。无 file_id 直接判失败。 */
  read(ref: FileRef): Promise<FileReadResult> {
    if (!ref.fileId) {
      const reason = "缺少 file_id";
      logger.warn(`[file] ${ref.name} 失败：${reason}`);
      return Promise.resolve({ status: "failed", reason });
    }
    const cached = this.cache.get(ref.fileId);
    if (cached) return cached;
    const task = this.load(ref);
    this.cache.set(ref.fileId, task);
    return task;
  }

  /** 完整读取流程：类型判定 → 取字节 → 解码 → 截断；任一环节失败都有明确 reason。 */
  private async load(ref: FileRef): Promise<FileReadResult> {
    const extension = extensionOf(ref.name);
    if (!ref.name || !TEXT_EXTENSIONS.has(extension)) {
      logger.info(`[file] ${ref.name} 类型不支持（${extension || "无扩展名"}）`);
      return { status: "unsupported", reason: "只支持文本类文件" };
    }

    let bytes: Buffer;
    try {
      const source = await this.resolve(ref);
      if (source.kind === "base64") {
        // 私聊 get_file 可能直接返回 base64 内容，不再另下载。
        bytes = Buffer.from(source.base64, "base64");
        logger.info(`[file] 解析 ${ref.name} 方式=${ref.groupId !== undefined ? "group" : "private"} 结果=base64`);
      } else {
        logger.info(`[file] 解析 ${ref.name} 方式=${ref.groupId !== undefined ? "group" : "private"} 结果=url`);
        bytes = await this.download(source.url);
      }
      if (bytes.length > this.maxBytes) throw new Error(`文件过大 ${bytes.length} > ${this.maxBytes} 字节`);
      logger.info(`[file] 下载 ${ref.name} bytes=${bytes.length}`);
    } catch (error) {
      const reason = (error as Error).message || "未知错误";
      logger.warn(`[file] ${ref.name} 失败：${reason}`);
      return { status: "failed", reason };
    }

    // 命中文本扩展名但内容含 NUL 字节（二进制特征）或不是合法 UTF-8 时判失败，绝不当作空文本。
    let content: string;
    try {
      if (bytes.includes(0)) throw new Error("含二进制内容");
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      const reason = `无法按 UTF-8 文本解码（${(error as Error).message}）`;
      logger.warn(`[file] ${ref.name} 失败：${reason}`);
      return { status: "failed", reason };
    }

    let truncated = false;
    if (content.length > this.maxChars) {
      content = content.slice(0, this.maxChars);
      truncated = true;
      logger.warn(`[file] ${ref.name} 内容截断至 ${this.maxChars} 字符`);
    }
    logger.info(`[file] ${ref.name} 读取成功 chars=${content.length}`);
    return { status: "text", content, truncated };
  }

  /** 按会话类型解析文件地址：群聊走 get_group_file_url，私聊走 get_file；二者皆无则抛错。 */
  private async resolve(ref: FileRef): Promise<{ kind: "url"; url: string } | { kind: "base64"; base64: string }> {
    const isGroup = ref.groupId !== undefined;
    const action = isGroup ? "get_group_file_url" : "get_file";
    const params: Record<string, unknown> = isGroup
      ? { group_id: ref.groupId, file_id: ref.fileId }
      : { file_id: ref.fileId };
    const { data } = await this.callAction<{ url?: string; base64?: string }>(action, params);
    const url = typeof data?.url === "string" && data.url ? data.url : undefined;
    const base64 = typeof data?.base64 === "string" && data.base64 ? data.base64 : undefined;
    if (url) return { kind: "url", url };
    if (base64) return { kind: "base64", base64 };
    // 日志不打印完整 URL（可能带签名），只说明没拿到地址。
    throw new Error(`未取得文件地址（${action}）`);
  }

  /** 下载文件字节；校验 HTTP 状态与大小上限。 */
  private async download(url: string): Promise<Buffer> {
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
}
