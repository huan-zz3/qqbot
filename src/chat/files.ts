/**
 * files.ts —— 聊天里收到的文件的下载后端：解析地址（群聊 / 私聊）并**流式**取回字节。
 *
 * 只负责「把 FileRef 变成字节」，不做类型判定、不解压、不解码——那些在 chat/archive.ts
 * 与 chat/materials.ts 里。压缩包可能很大，故流式边读边限：超过 maxBytes 立即中止并抛错，
 * 不会把整个响应先缓冲进内存。读取结果严格：成功返回 Buffer，任一环节失败抛出带原因的错。
 *
 * 依赖注入 callAction（NapCat action 调用）与两个上限（下载字节、超时），不直接依赖 config/client，
 * 便于单测注入假实现（见 tests/files.test.ts）。私聊 get_file 可能直接返回 base64，此时不再另下载。
 */
import { logger } from "../logger.js";
import type { ActionResponse } from "../napcat/types.js";

/** NapCat action 调用的最小契约；由 client.callAction 传入（注意需绑定 this，见 index.ts）。 */
export type CallAction = <T>(action: string, params: Record<string, unknown>) => Promise<ActionResponse<T>>;

/** 一条聊天里收到的文件引用；只保留解析所需的最小字段。 */
export type FileRef = {
  /** 协议端的 file_id；缺失时无法解析。 */
  fileId?: string;
  /** 文件名（含扩展名）。 */
  name: string;
  /** 文件大小（字节）；协议端附带时才有。 */
  size?: number;
  /** 群文件所属群号；私聊文件缺省（据此选择 get_group_file_url 或 get_file）。 */
  groupId?: number;
};

/** 文件下载后端：按 FileRef 取回完整字节。 */
export class FileStore {
  /**
   * @param callAction NapCat action 调用（已绑定 this）。
   * @param maxBytes 单次下载上限（字节），流式边读边限。
   * @param timeoutMs 单次下载超时（毫秒）。
   */
  constructor(
    private readonly callAction: CallAction,
    private readonly maxBytes: number,
    private readonly timeoutMs: number,
  ) {}

  /** 下载一个文件的完整字节；无 file_id 直接抛错。 */
  async download(ref: FileRef): Promise<Buffer> {
    if (!ref.fileId) throw new Error("缺少 file_id");
    const source = await this.resolve(ref);
    let bytes: Buffer;
    if (source.kind === "base64") {
      // 私聊 get_file 可能直接返回 base64 内容，不再另下载。
      bytes = Buffer.from(source.base64, "base64");
      logger.info(`[file] 解析 ${ref.name} 方式=base64`);
    } else {
      logger.info(`[file] 解析 ${ref.name} 方式=${ref.groupId !== undefined ? "group" : "private"}`);
      bytes = await this.fetchBytes(source.url);
    }
    if (bytes.length > this.maxBytes) throw new Error(`文件过大 ${bytes.length} > ${this.maxBytes} 字节`);
    return bytes;
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

  /** 流式下载：边读边累计，超过上限立即中止（不把整个响应缓冲进内存）。 */
  private async fetchBytes(url: string): Promise<Buffer> {
    const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
    const body = response.body;
    if (!body) {
      // 极少数实现不给 body：退回整体读取，但仍在读完后校验大小。
      const whole = Buffer.from(await response.arrayBuffer());
      if (whole.length > this.maxBytes) throw new Error(`文件过大 ${whole.length} > ${this.maxBytes} 字节`);
      return whole;
    }
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > this.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`文件过大 ${total} > ${this.maxBytes} 字节`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
}
