/**
 * decode.test.ts —— 文本字节多编码解码（src/chat/decode.ts）单元测试。
 *
 * 覆盖：UTF-8、GB18030 回退、BOM（UTF-8/UTF-16LE/BE）、BOM 与内容不符时失败且不回退、
 * 含 NUL 判二进制、全部候选拒绝时失败、候选编码标签在本机可用。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeTextFile, TEXT_ENCODINGS } from "../src/chat/decode.js";

// UTF-8 文本：命中 utf-8。
test("utf-8 bytes decode as utf-8", () => {
  const result = decodeTextFile(Buffer.from("你好", "utf8"));
  assert.deepEqual(result, { status: "text", content: "你好", encoding: "utf-8" });
});

// GB18030 字节（UTF-8 下非法）：utf-8 失败后命中 gb18030。
test("gb18030 bytes fall through to gb18030", () => {
  const bytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // "中文"
  const result = decodeTextFile(bytes);
  assert.deepEqual(result, { status: "text", content: "中文", encoding: "gb18030" });
});

// UTF-8 BOM：按 BOM 解，且 BOM 不残留在内容里。
test("utf-8 BOM is detected and stripped", () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi", "utf8")]);
  assert.deepEqual(decodeTextFile(bytes), { status: "text", content: "hi", encoding: "utf-8" });
});

// UTF-16LE BOM：内容含 NUL 字节，但 BOM 优先，正确解码。
test("utf-16le BOM is detected despite NUL bytes", () => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")]);
  assert.deepEqual(decodeTextFile(bytes), { status: "text", content: "hi", encoding: "utf-16le" });
});

// UTF-16BE BOM。
test("utf-16be BOM is detected", () => {
  const bytes = Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]);
  assert.deepEqual(decodeTextFile(bytes), { status: "text", content: "hi", encoding: "utf-16be" });
});

// BOM 指示 UTF-16 但内容非法（奇数尾字节）：失败且不回退到候选编码。
test("invalid bytes under a BOM fail without fallback", () => {
  const result = decodeTextFile(Buffer.from([0xff, 0xfe, 0x00]));
  assert.equal(result.status, "failed");
  assert.match((result as { reason: string }).reason, /BOM/);
});

// 含 NUL 且无 BOM：判二进制。
test("NUL bytes without BOM are binary", () => {
  const result = decodeTextFile(Buffer.from([0x61, 0x00, 0x62]));
  assert.equal(result.status, "binary");
  assert.match((result as { reason: string }).reason, /二进制/);
});

// 所有候选都拒绝的字节（0x8e 在五个编码下均无法单独成序列）：失败且 reason 列出编码。
test("bytes rejected by every candidate fail with the tried list", () => {
  const result = decodeTextFile(Buffer.from([0x8e]));
  assert.equal(result.status, "failed");
  assert.match((result as { reason: string }).reason, /utf-8/);
});

// 候选编码标签必须都能在本机 TextDecoder 下构造（防 full-ICU 缺失导致运行期异常）。
test("every candidate encoding label is supported by TextDecoder", () => {
  for (const encoding of TEXT_ENCODINGS) {
    assert.doesNotThrow(() => new TextDecoder(encoding, { fatal: true }));
  }
});
