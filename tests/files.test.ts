/**
 * files.test.ts —— 聊天文件懒读取（src/chat/files.ts 的 FileStore）单元测试。
 *
 * 覆盖：按会话类型选择解析接口（群聊 get_group_file_url / 私聊 get_file）、
 * url 与 base64 两种字节来源、文本读取成功（含字符截断）、类型不支持、
 * 下载/超限/解码失败等失败态、无 file_id 直接失败，以及同一 fileId 只解析一次。
 *
 * 说明：FileStore 通过构造参数注入 callAction 与两个上限，不依赖 config，
 * 故直接静态 import；下载走 globalThis.fetch，用假 Response 桩拦截。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { FileStore, type CallAction } from "../src/chat/files.js";
import type { ActionResponse } from "../src/napcat/types.js";

// 构造一个记录调用参数的假 callAction；按 action 返回预设 data。
function fakeCallAction(
  data: Record<string, unknown>,
  calls: { action: string; params: Record<string, unknown> }[] = [],
): CallAction {
  return async <T>(action: string, params: Record<string, unknown>) => {
    calls.push({ action, params });
    return { status: "ok", retcode: 0, data } as ActionResponse<T>;
  };
}

// 拦截下载请求：按 URL 返回预设字节内容（默认 UTF-8 文本）。
function stubFetch(content: string | Buffer, status = 200) {
  globalThis.fetch = (async (url: string) => {
    void url;
    return new Response(content, { status });
  }) as typeof fetch;
}

// 群聊文件：走 get_group_file_url，下载 url 内容并解出文本。
test("group file is resolved via get_group_file_url and downloaded", async () => {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  stubFetch("hello group");
  const store = new FileStore(fakeCallAction({ url: "https://x/f.txt" }, calls), 1024, 1000);
  const result = await store.read({ fileId: "fid1", name: "a.txt", size: 11, groupId: 500 });
  assert.deepEqual(result, { status: "text", content: "hello group", truncated: false });
  assert.deepEqual(calls, [{ action: "get_group_file_url", params: { group_id: 500, file_id: "fid1" } }]);
});

// 私聊文件：走 get_file，且只传 file_id（不传 group_id）；同样下载 url。
test("private file is resolved via get_file and downloaded", async () => {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  stubFetch("hello private");
  const store = new FileStore(fakeCallAction({ url: "https://x/p.txt" }, calls), 1024, 1000);
  const result = await store.read({ fileId: "fid2", name: "b.txt" });
  assert.deepEqual(result, { status: "text", content: "hello private", truncated: false });
  assert.deepEqual(calls, [{ action: "get_file", params: { file_id: "fid2" } }]);
});

// get_file 直接返回 base64 时不再另发下载请求，直接解码内容。
test("base64 content is decoded without downloading", async () => {
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return new Response("");
  }) as typeof fetch;
  const store = new FileStore(fakeCallAction({ base64: Buffer.from("内联内容").toString("base64") }), 1024, 1000);
  const result = await store.read({ fileId: "fid3", name: "c.md" });
  assert.deepEqual(result, { status: "text", content: "内联内容", truncated: false });
  assert.equal(fetched, 0);
});

// 非文本扩展名（如 .zip）判不支持，不解析、不下载。
test("non-text files are unsupported without resolving", async () => {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const store = new FileStore(fakeCallAction({ url: "https://x/z.zip" }, calls), 1024, 1000);
  const result = await store.read({ fileId: "fid4", name: "archive.zip", groupId: 500 });
  assert.deepEqual(result, { status: "unsupported", reason: "只支持文本类文件" });
  assert.deepEqual(calls, []);
});

// 无扩展名同样判不支持。
test("files without extension are unsupported", async () => {
  const store = new FileStore(fakeCallAction({ url: "https://x/x" }), 1024, 1000);
  assert.deepEqual(await store.read({ fileId: "fid5", name: "README" }), {
    status: "unsupported",
    reason: "只支持文本类文件",
  });
});

// 下载返回非 2xx：判失败并带上 HTTP 状态，reason 非空。
test("download failure is reported with a reason", async () => {
  stubFetch("nope", 404);
  const store = new FileStore(fakeCallAction({ url: "https://x/f.txt" }), 1024, 1000);
  const result = await store.read({ fileId: "fid6", name: "a.txt" });
  assert.equal(result.status, "failed");
  assert.match((result as { reason: string }).reason, /HTTP 404/);
});

// 解析接口没有 url 也没有 base64：判失败。
test("missing url and base64 fails", async () => {
  const store = new FileStore(fakeCallAction({}), 1024, 1000);
  const result = await store.read({ fileId: "fid7", name: "a.txt" });
  assert.equal(result.status, "failed");
  assert.match((result as { reason: string }).reason, /未取得文件地址/);
});

// 下载内容超过 maxBytes：判失败并记实际大小。
test("oversized file fails with its byte count", async () => {
  stubFetch("1234567890");
  const store = new FileStore(fakeCallAction({ url: "https://x/f.txt" }), 5, 1000);
  const result = await store.read({ fileId: "fid8", name: "a.txt" });
  assert.equal(result.status, "failed");
  assert.match((result as { reason: string }).reason, /文件过大/);
});

// 内容超过 maxChars：截断到上限并标记 truncated。
test("long content is truncated to maxChars", async () => {
  stubFetch("abcdefghij");
  const store = new FileStore(fakeCallAction({ url: "https://x/f.txt" }), 1024, 4);
  assert.deepEqual(await store.read({ fileId: "fid9", name: "a.txt" }), {
    status: "text",
    content: "abcd",
    truncated: true,
  });
});

// 命中文本扩展名但内容含 NUL 字节（二进制伪装）：判失败，绝不当作空文本。
test("binary content under a text extension fails", async () => {
  stubFetch(Buffer.from([0x61, 0x00, 0x62]));
  const store = new FileStore(fakeCallAction({ url: "https://x/f.txt" }), 1024, 1000);
  const result = await store.read({ fileId: "fid10", name: "a.txt" });
  assert.equal(result.status, "failed");
  assert.match((result as { reason: string }).reason, /解码|二进制/);
});

// 无 file_id：不调用解析接口，直接判失败。
test("missing file_id fails without resolving", async () => {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const store = new FileStore(fakeCallAction({ url: "https://x/f.txt" }, calls), 1024, 1000);
  const result = await store.read({ name: "a.txt", groupId: 500 });
  assert.equal(result.status, "failed");
  assert.equal((result as { reason: string }).reason, "缺少 file_id");
  assert.deepEqual(calls, []);
});

// 同一 fileId 第二次读取复用缓存：解析接口只调一次。
test("the same fileId is resolved only once", async () => {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  stubFetch("cached");
  const store = new FileStore(fakeCallAction({ url: "https://x/f.txt" }, calls), 1024, 1000);
  const first = await store.read({ fileId: "fid11", name: "a.txt", groupId: 500 });
  const second = await store.read({ fileId: "fid11", name: "a.txt", groupId: 500 });
  assert.deepEqual(first, second);
  assert.equal(calls.length, 1);
});
