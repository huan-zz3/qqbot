/**
 * agent-client 握手与帧加密的纯逻辑（不涉及 socket/IO）。
 *
 * 传输是明文 TCP，安全性全部落在这一层：PSK 派生会话密钥，帧载荷用 AES-256-GCM 封装。
 * 长度前缀与帧上限必须与 Go 客户端逐字对齐（见 .slim/deepwork/agent-client/protocol.md）。
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * 握手报文里的协议版本；与客户端不等即拒绝，不做兼容分支。
 * v2 新增 `run_batch`（批量执行），线协议不兼容 v1，故两端必须同为 2。
 */
export const PROTOCOL_VERSION = 2;

/** 单帧载荷上限 64 MiB：防止对端一个长度头就把内存吃光。 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** HKDF 的 info：把本协议的派生结果与其它可能复用同一 PSK 的场合隔开。 */
const HKDF_INFO = "qqbot-agent/v1";
const KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
/** 握手 nonce 长度：双方各 16 字节，拼成 32 字节 salt。 */
const HANDSHAKE_NONCE_BYTES = 16;

/** 由 PSK 与双方 nonce 派生会话密钥；salt 必须按 client||server 顺序拼接。 */
export function deriveSessionKey(psk: Uint8Array, clientNonce: Uint8Array, serverNonce: Uint8Array): Buffer {
  const salt = Buffer.concat([Buffer.from(clientNonce), Buffer.from(serverNonce)]);
  // hkdfSync 返回 ArrayBuffer（不同 Node 版本类型不一），统一包成 Buffer 便于后续 slice。
  return Buffer.from(hkdfSync("sha256", Buffer.from(psk), salt, HKDF_INFO, KEY_BYTES));
}

export function randomNonce(bytes: number = HANDSHAKE_NONCE_BYTES): Buffer {
  return randomBytes(bytes);
}

/** 每帧新取随机 12 字节 nonce：不维护计数器，双方重连后也无需同步状态。 */
export function seal(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

/** 认证失败直接抛错：调用方据此外理断开连接，绝不把空结果当成合法报文。 */
export function open(key: Buffer, payload: Buffer): Buffer {
  if (payload.length < GCM_NONCE_BYTES + GCM_TAG_BYTES) {
    throw new Error(`加密帧过短（${payload.length} 字节）`);
  }
  const nonce = payload.subarray(0, GCM_NONCE_BYTES);
  const tag = payload.subarray(payload.length - GCM_TAG_BYTES);
  const body = payload.subarray(GCM_NONCE_BYTES, payload.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** 加 4 字节大端长度头。超限即报错，而不是让对端读到一个它不会接受的帧。 */
export function encodeFrame(payload: Buffer): Buffer {
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error(`帧载荷过大：${payload.length} > ${MAX_FRAME_BYTES}`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** 把字节流切成完整帧；TCP 一次 read 可能只有半个帧，也可能粘着好几帧。 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  /** 当前尚未凑成完整帧的缓冲字节数（测试/日志用）。 */
  get pending(): number {
    return this.buf.length;
  }

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Buffer[] = [];
    while (this.buf.length >= 4) {
      const length = this.buf.readUInt32BE(0);
      // 长度头一到就先判上限：此时还不需要把整个超大帧读进内存。
      if (length > MAX_FRAME_BYTES) {
        throw new Error(`帧长度超限：${length} > ${MAX_FRAME_BYTES}`);
      }
      if (this.buf.length < 4 + length) break;
      frames.push(this.buf.subarray(4, 4 + length));
      this.buf = this.buf.subarray(4 + length);
    }
    return frames;
  }
}
