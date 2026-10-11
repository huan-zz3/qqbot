/**
 * mcp-search.test.ts —— MCP 搜索客户端（src/search/mcp-search.ts）的纯函数测试。
 *
 * 只覆盖不依赖网络的 contentToText：把 MCP tools/call 返回的 content 数组
 * 里的文本块拼成纯文本，忽略非文本块与非法输入。连接/调用路径需要真实 MCP
 * 服务器，不在单测范围。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { contentToText } = await import("../src/search/mcp-search.js");

// 多个文本块按顺序用换行拼接；没有文本块返回空串。
test("contentToText joins text blocks", () => {
  assert.equal(contentToText([{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }]), "第一段\n第二段");
  assert.equal(contentToText([{ type: "text", text: "只有一段" }]), "只有一段");
  assert.equal(contentToText([{ type: "image", data: "xxx" }]), "");
  assert.equal(contentToText([]), "");
});

// 非数组、缺字段、类型不匹配的块都被忽略，不抛错。
test("contentToText ignores malformed content", () => {
  assert.equal(contentToText(undefined), "");
  assert.equal(contentToText("not-an-array"), "");
  assert.equal(contentToText([null, 42, { type: "text" }, { type: "text", text: 123 }]), "");
});
