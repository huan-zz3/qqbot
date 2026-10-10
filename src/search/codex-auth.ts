/**
 * codex-auth.ts —— Codex（ChatGPT OAuth）access token 的读取与有效性检查
 *
 * 凭证由 `deploy/sync-codex-auth.sh` 从持有 pi 的电脑同步到 `data/codex-auth.json`，
 * 只含 access token：**没有 refresh token、从不刷新**。这是刻意的——refresh token
 * 每次刷新都会轮换，bot 若刷新会把本机 pi 顶掉；access token 过期后搜索自动停用，
 * 重新同步即可，无需重启（过了余量后 get() 会重读磁盘）。
 *
 * 关键行为：get() 在凭证缺失或距过期不足 EXPIRY_MARGIN_MS 时重读文件，已过期则抛错；
 * usable() 是可查询版本（不抛错），供上层决定是否启用搜索。
 */
import { readFile } from "node:fs/promises";

// JWT 中存放 ChatGPT 认证信息的 claim 路径。
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
// 距过期不足该余量的缓存视为「该重读磁盘了」：既避免用到马上失效的 token，
// 也能及时换上重新同步的新 token。
const EXPIRY_MARGIN_MS = 60 * 1000;
// 凭证缺失/过期时统一的修复提示。
const SYNC_HINT = "在本机运行 deploy/sync-codex-auth.sh 同步";

/**
 * 同步到本地的 Codex 凭证。
 * expires 为毫秒时间戳；accountId 是 ChatGPT account ID。
 */
export type CodexCredential = {
  access: string;
  expires: number;
  accountId: string;
};

/**
 * 从 JWT 形式的 access token 中解析出 ChatGPT account ID。
 * 只做 base64url 解码取字段，不校验签名（信任边界是本地同步文件）。
 * @throws token 不是 JWT（没有 payload 段）、或 claims 里缺 chatgpt_account_id 时抛错
 */
export function accountIdFromToken(token: string): string {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Codex access token 不是 JWT");
  // JWT payload 是 base64url 编码的 JSON。
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  const auth = claims[JWT_CLAIM_PATH] as { chatgpt_account_id?: unknown } | undefined;
  if (typeof auth?.chatgpt_account_id !== "string" || !auth.chatgpt_account_id) {
    throw new Error("Codex access token 中没有 ChatGPT account ID");
  }
  return auth.chatgpt_account_id;
}

/**
 * 从磁盘读凭证文件。
 * @returns 凭证对象；文件不存在（ENOENT）或缺必要字段时返回 undefined
 * @throws 文件存在但内容损坏等其它错误原样抛出（不吞掉真正的异常）
 */
export async function readCredential(file: string): Promise<CodexCredential | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<CodexCredential>;
    // access 与 expires 是必要字段；accountId 可以没存，从 token 现解。
    if (!parsed.access || typeof parsed.expires !== "number") return undefined;
    return { access: parsed.access, expires: parsed.expires, accountId: parsed.accountId || accountIdFromToken(parsed.access) };
  } catch (error) {
    // 文件不存在不是错误，只是还没同步过。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Codex 凭证持有者：只持有从「refresh token 在它的 pi 上」的机器同步来的
 * access token，bot 从不刷新，所以不会把那个 token 轮换掉；磁盘上有更新的
 * 同步结果时会被重新读到。
 */
export class CodexAuth {
  private credential: CodexCredential | undefined;

  constructor(private readonly file: string) {}

  /**
   * 取一份可用凭证。
   * @returns 未过期的凭证（必要时先重读磁盘以拿到新同步的 token）
   * @throws 凭证缺失或已过期时抛错，错误信息里含同步提示
   */
  async get(): Promise<CodexCredential> {
    // 无缓存，或缓存距过期不足余量：重读磁盘。
    if (!this.credential || this.credential.expires - Date.now() < EXPIRY_MARGIN_MS) {
      this.credential = await readCredential(this.file);
    }
    if (!this.credential) throw new Error(`没有 Codex 凭证 ${this.file}，${SYNC_HINT}`);
    // 真的过期了：不刷新（没有 refresh token），抛错提示重新同步。
    if (this.credential.expires <= Date.now()) {
      const at = new Date(this.credential.expires).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
      throw new Error(`Codex access token 已于 ${at} 过期，${SYNC_HINT}`);
    }
    return this.credential;
  }

  /** 当前是否可用（吞掉 get() 的错误），供启动检查与 runtime 决定是否挂搜索工具。 */
  async usable(): Promise<boolean> {
    try {
      await this.get();
      return true;
    } catch {
      return false;
    }
  }
}
