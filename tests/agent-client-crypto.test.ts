import assert from "node:assert/strict";
import { hkdfSync } from "node:crypto";
import { test } from "node:test";

import {
  FrameDecoder,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  deriveSessionKey,
  encodeFrame,
  open,
  randomNonce,
  seal,
} from "../src/agent-client/crypto.js";

const psk = Buffer.alloc(32, 7);

test("PROTOCOL_VERSION 为 1", () => {
  assert.equal(PROTOCOL_VERSION, 1);
});

test("HKDF：相同输入派生稳定，任一 nonce 变化结果不同", () => {
  const cn = randomNonce();
  const sn = randomNonce();
  const a = deriveSessionKey(psk, cn, sn);
  const b = deriveSessionKey(psk, cn, sn);
  assert.equal(a.length, 32);
  assert.deepEqual(a, b);

  const otherClient = randomNonce();
  const otherServer = randomNonce();
  assert.notDeepEqual(a, deriveSessionKey(psk, otherClient, sn));
  assert.notDeepEqual(a, deriveSessionKey(psk, cn, otherServer));

  // salt 是 client||server 的拼接，对调顺序必须得到不同的键。
  assert.notDeepEqual(deriveSessionKey(psk, cn, sn), deriveSessionKey(psk, sn, cn));
  // 换 PSK 也要变。
  assert.notDeepEqual(a, deriveSessionKey(Buffer.alloc(32, 9), cn, sn));
});

test("HKDF 与 node hkdfSync 的同一参数一致（salt/info 按协议固定）", () => {
  const cn = Buffer.alloc(16, 1);
  const sn = Buffer.alloc(16, 2);
  const key = deriveSessionKey(psk, cn, sn);
  const salt = Buffer.concat([cn, sn]);
  // 直接调用 node:crypto 作为独立参照，确认 salt/info/长度没有写错。
  const expected = Buffer.from(hkdfSync("sha256", psk, salt, "qqbot-agent/v1", 32));
  assert.deepEqual(key, expected);
});

test("seal/open 往返", () => {
  const key = deriveSessionKey(psk, randomNonce(), randomNonce());
  const plaintext = Buffer.from("你好，agent-client");
  assert.deepEqual(open(key, seal(key, plaintext)), plaintext);
  // 空载荷也要能往返（长度边界）。
  assert.deepEqual(open(key, seal(key, Buffer.alloc(0))), Buffer.alloc(0));
});

test("open：改一个字节即抛错", () => {
  const key = deriveSessionKey(psk, randomNonce(), randomNonce());
  const payload = seal(key, Buffer.from("payload"));
  for (const index of [0, 12, payload.length - 1]) {
    const tampered = Buffer.from(payload);
    tampered[index] = (tampered[index] ?? 0) ^ 0x01;
    assert.throws(() => open(key, tampered));
  }
  // 用错 key 同样失败。
  assert.throws(() => open(deriveSessionKey(psk, randomNonce(), randomNonce()), payload));
  // 过短（连 nonce+tag 都不够）也失败，不返回空 Buffer。
  assert.throws(() => open(key, Buffer.alloc(20)));
});

test("seal：相同明文每次密文不同（随机 nonce 生效）", () => {
  const key = deriveSessionKey(psk, randomNonce(), randomNonce());
  const plaintext = Buffer.from("same");
  assert.notDeepEqual(seal(key, plaintext), seal(key, plaintext));
});

test("encodeFrame + FrameDecoder：整帧、逐字节、多帧粘连都能还原", () => {
  const payloads = [Buffer.from("a"), Buffer.from("hello world"), Buffer.alloc(0), Buffer.from("尾巴")];
  const frames = payloads.map((p) => encodeFrame(p));

  const whole = new FrameDecoder();
  assert.deepEqual(whole.push(Buffer.concat(frames)), payloads);
  assert.equal(whole.pending, 0);

  const byteByByte = new FrameDecoder();
  const collected: Buffer[] = [];
  const stream = Buffer.concat(frames);
  for (let i = 0; i < stream.length; i++) {
    collected.push(...byteByByte.push(stream.subarray(i, i + 1)));
  }
  assert.deepEqual(collected, payloads);
  assert.equal(byteByByte.pending, 0);

  // 半帧时 pending 应保留未消费的字节，补齐后才吐出。
  const split = new FrameDecoder();
  const frame = frames[1] as Buffer;
  assert.deepEqual(split.push(frame.subarray(0, 2)), []);
  assert.equal(split.pending, 2);
  assert.deepEqual(split.push(frame.subarray(2)), [Buffer.from("hello world")]);
});

test("FrameDecoder：长度头超过上限即 throw", () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  const decoder = new FrameDecoder();
  assert.throws(() => decoder.push(header), /帧长度超限/);
});

test("encodeFrame：载荷超过上限即 throw", () => {
  assert.throws(() => encodeFrame(Buffer.alloc(MAX_FRAME_BYTES + 1)), /帧载荷过大/);
});
