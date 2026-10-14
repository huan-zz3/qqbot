/**
 * vision.test.ts —— src/llm/vision.js 的识图请求测试（与回复模型 deepseek.js 完全独立）。
 *
 * 覆盖：
 * - 请求发往写死的 SiliconFlow 端点 /v1/chat/completions，带 Bearer 鉴权；
 * - 请求体 model 恒为 deepseek-ai/DeepSeek-OCR、stream=false、max_tokens 取配置；
 * - user content 为内容块数组：图片块（data URL + detail）在前、文本指令在后；
 * - 返回 choices[0].message.content 的 trim 结果；
 * - 非 2xx 时抛错，错误信息带上状态码与截断的响应体。
 *
 * 说明：globalThis.fetch 全部 mock，不触网；env 必须在动态 import 之前设置。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// 必须在 import vision.js（间接 import config.js）之前设置。
process.env.VISION_API_KEY = "vision-test-key";
process.env.VISION_DETAIL = "high";
process.env.VISION_MAX_TOKENS = "300";

// 动态引入被测模块（env 已生效）。
const { describeImage, VISION_MODEL } = await import("../src/llm/vision.js");

// 捕获到的请求（URL、鉴权头、body），供断言。
type Capture = { url: string; auth: string | null; body: any };

// 用一次预设响应 mock fetch，并捕获请求供断言。
function mockFetch(response: unknown, status = 200): Capture[] {
  const captures: Capture[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    captures.push({ url, auth: headers.Authorization, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return captures;
}

test("sends image then text to the hardcoded SiliconFlow endpoint", async () => {
  const captures = mockFetch({ choices: [{ message: { content: "  图里是一只猫  " } }] });
  const text = await describeImage("data:image/png;base64,AAAA", "这是什么");

  // 返回值 trim 掉首尾空白。
  assert.equal(text, "图里是一只猫");
  assert.equal(captures.length, 1);
  const { url, auth, body } = captures[0]!;
  // 端点与鉴权写死/来自 env。
  assert.equal(url, "https://api.siliconflow.cn/v1/chat/completions");
  assert.equal(auth, "Bearer vision-test-key");
  // 模型硬编码。
  assert.equal(body.model, VISION_MODEL);
  assert.equal(body.model, "deepseek-ai/DeepSeek-OCR");
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 300);
  // 内容块：图片在前、文本在后。
  const content = body.messages[0].content;
  assert.equal(body.messages[0].role, "user");
  assert.equal(content[0].type, "image_url");
  assert.equal(content[0].image_url.url, "data:image/png;base64,AAAA");
  assert.equal(content[0].image_url.detail, "high");
  assert.equal(content[1].type, "text");
  assert.equal(content[1].text, "这是什么");
});

test("throws with status and body on non-2xx", async () => {
  mockFetch({ message: "Invalid token" }, 401);
  await assert.rejects(describeImage("data:image/png;base64,AAAA", "x"), /401/);
});
