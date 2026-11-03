/**
 * agent-client 配对码登记表：生成码/token、登记在线连接、断线后的宽限期淘汰。
 *
 * 纯逻辑，时间一律由调用方传 `now`，类内部不读时钟，便于单测与统一注入。
 */
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** 配对码位数：8 位数字（含前导零），由服务端生成，避免不同群友自带码撞车。 */
export const CODE_DIGITS = 8;

/** 连续抽不到未占用码时的上限；到点就报错，绝不静默返回重复码。 */
const CODE_MAX_ATTEMPTS = 100;
const CODE_SPACE = 10 ** CODE_DIGITS;
const TOKEN_BYTES = 32;

export type PairingEntry = {
  code: string;
  token: string;
  online: boolean;
  /**
   * 是否已收到过可解密帧（证明对端确实持有 PSK）。
   * 未验证的条目只是「发过 hello」，不能兑付给 opencode；重连时重置为 false。
   */
  verified: boolean;
  /** 断线时刻；online 时不存在。 */
  offlineSince?: number;
  /** 最近一次绑定这条码的 TCP 连接标识；重连后会刷新。 */
  connectionId?: string;
};

/** 生成一个未被占用的 8 位数字码；isTaken 由调用方给出（本表内部是查 Map）。 */
export function generateCode(isTaken: (code: string) => boolean): string {
  for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) {
    const code = String(randomInt(0, CODE_SPACE)).padStart(CODE_DIGITS, "0");
    if (!isTaken(code)) return code;
  }
  throw new Error(`连续 ${CODE_MAX_ATTEMPTS} 次未能生成未被占用的配对码`);
}

export class PairingRegistry {
  private readonly entries = new Map<string, PairingEntry>();
  private readonly graceMs: number;
  private readonly maxClients: number;

  constructor(opts: { graceMs: number; maxClients: number }) {
    this.graceMs = opts.graceMs;
    this.maxClients = opts.maxClients;
  }

  /**
   * 新连接登记：名额满就报错，让调用方回错误帧，而不是挤掉正在用的客户端。
   * 名额只算「在线」条目：宽限期内的断线条目不占坑，否则静默断链会把名额永久占满。
   */
  register(now: number, connectionId: string): PairingEntry {
    if (this.onlineCount >= this.maxClients) {
      throw new Error(`在线客户端已达上限（${this.maxClients}）`);
    }
    const code = generateCode((c) => this.entries.has(c));
    // token 是客户端唯一凭证：base64 后随握手下发，客户端只留内存。
    const entry: PairingEntry = {
      code,
      token: randomBytes(TOKEN_BYTES).toString("base64"),
      online: true,
      verified: false,
      connectionId,
    };
    this.entries.set(code, entry);
    return entry;
  }

  /** 首次收到可解密帧时调用：从这一刻起这条码才「可兑付」。 */
  markVerified(code: string): void {
    const entry = this.entries.get(code);
    if (!entry) return;
    entry.verified = true;
  }

  markOffline(code: string, now: number): void {
    const entry = this.entries.get(code);
    if (!entry) return;
    entry.online = false;
    entry.offlineSince = now;
  }

  /** 重连认领：token/存在性/宽限期任一不满足都返回 undefined，由调用方回错误帧。 */
  resume(code: string, token: string, now: number, connectionId: string): PairingEntry | undefined {
    const entry = this.entries.get(code);
    if (!entry) return undefined;
    if (!timingSafeEqualString(entry.token, token)) return undefined;
    if (!entry.online && this.expired(entry, now)) return undefined;
    entry.online = true;
    // 新连接要用自己的会话密钥重新证明持有 PSK，不能沿用上一条连接的验证结果。
    entry.verified = false;
    entry.offlineSince = undefined;
    entry.connectionId = connectionId;
    return entry;
  }

  /** 按码查在线状态；宽限期内断线也返回，交给调用方提示"剩余 N 秒"。 */
  lookup(code: string, now: number): { entry: PairingEntry; remainingMs: number } | undefined {
    const entry = this.entries.get(code);
    if (!entry) return undefined;
    if (entry.online) return { entry, remainingMs: 0 };
    if (this.expired(entry, now)) return undefined;
    return { entry, remainingMs: this.remainingMs(entry, now) };
  }

  /** 清理超过宽限期的断线条目；返回被删的码。 */
  sweep(now: number): string[] {
    const removed: string[] = [];
    for (const [code, entry] of this.entries) {
      if (!entry.online && this.expired(entry, now)) {
        this.entries.delete(code);
        removed.push(code);
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }

  get onlineCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.online) n++;
    return n;
  }

  private expired(entry: PairingEntry, now: number): boolean {
    return entry.offlineSince !== undefined && now - entry.offlineSince > this.graceMs;
  }

  private remainingMs(entry: PairingEntry, now: number): number {
    if (entry.offlineSince === undefined) return this.graceMs;
    return Math.max(0, this.graceMs - (now - entry.offlineSince));
  }
}

/** token 比较用定长比较，避免按字节提前返回泄露前缀。 */
function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}
