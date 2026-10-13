/**
 * files.test.ts —— 聊天文件下载后端（src/chat/files.ts 的 FileStore.download）单元测试。
 *
 * 覆盖：按会话类型选择解析接口（群聊 get_group_file_url / 私聊 get_file）、
 * url 与 base64 两种字节来源、流式下载并限制大小、HTTP 失败、缺少地址、
 * 无 file_id 直接抛错。FileStore 通过构造参数注入 callAction 与上限，不依赖 config。
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

// 拦截下载请求：按 URL 返回预设字节内容。
function stubFetch(content: string | Buffer, status = 200) {
  globalThis.fetch = (async () => new Response(content, { status })) as typeof fetch;
}

// 群聊文件：走 get_group_file_url，流式取回字节。
test("group file is resolved via get_group_file_url and downloaded", async () => {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  stubFetch("hello group");
  const store = new FileStore(fakeCallAction({ url: "https://x/f.txt" }, calls), 1024, 10000);
  const bytes = await store.download({ fileId: "fid1", name: "a.zip", size: 11, groupId: 500 });
  assert.equal(bytes.toString("utf8"), "hello group");
  assert.deepEqual(calls, [{ action: "get_group_file_url", params: { group_id: 500, file_id: "fid1" } }]);
});

// 私聊文件：走 get_file，且只传 file_id（不传 group_id）。
test("private file is resolved via get_file and downloaded", async () => {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  stubFetch("hello private");
  const store = new FileStore(fakeCallAction({ url: "https://x/p.txt" }, calls), 1024, 10000);
  const bytes = await store.download({ fileId: "fid2", name: "b.zip" });
  assert.equal(bytes.toString("utf8"), "hello private");
  assert.deepEqual(calls, [{ action: "get_file", params: { file_id: "fid2" } }]);
});

// get_file 直接返回 base64 时不再另发下载请求。
test("base64 content is decoded without downloading", async () => {
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return new Response("");
  }) as typeof fetch;
  const store = new FileStore(fakeCallAction({ base64: Buffer.from("内联内容").toString("base64") }), 1024, 10000);
  const bytes = await store.download({ fileId: "fid3", name: "c.zip" });
  assert.equal(bytes.toString("utf8"), "内联内容");
  assert.equal(fetched, 0);
});

// 下载返回非 2xx：抛错并带上 HTTP 状态。
test("download failure throws with the HTTP status", async () => {
  stubFetch("nope", 404);
  const store = new FileStore(fakeCallAction({ url: "https://x/f.zip" }), 1024, 10000);
  await assert.rejects(() => store.download({ fileId: "fid6", name: "a.zip" }), /HTTP 404/);
});

// 解析接口既无 url 也无 base64：抛错。
test("missing url and base64 throws", async () => {
  const store = new FileStore(fakeCallAction({}), 1024, 10000);
  await assert.rejects(() => store.download({ fileId: "fid7", name: "a.zip" }), /未取得文件地址/);
});

// 内容超过 maxBytes：流式检测到即抛错。
test("oversized content throws with its byte count", async () => {
  stubFetch("1234567890");
  const store = new FileStore(fakeCallAction({ url: "https://x/f.zip" }), 5, 10000);
  await assert.rejects(() => store.download({ fileId: "fid8", name: "a.zip" }), /文件过大/);
});

// 无 file_id：不调用解析接口，直接抛错。
test("missing file_id throws without resolving", async () => {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const store = new FileStore(fakeCallAction({ url: "https://x/f.zip" }, calls), 1024, 10000);
  await assert.rejects(() => store.download({ name: "a.zip", groupId: 500 }), /缺少 file_id/);
  assert.deepEqual(calls, []);
});
