/**
 * images.test.ts —— 普通图片识图（ImageDescriber）测试。
 *
 * 覆盖：
 * - 同一文件（按 file 去重）只下载/识图一次，并发请求共享同一个结果；
 * - 识图输出经 cleanDescription 清洗（去掉「（图中无文字）」这类括号注记）；
 * - 识图函数抛错、或消息段没有 url 时返回 undefined，不抛错。
 *
 * 说明：下载与识图全部 mock，本文件不触网。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// 必须在动态 import 之前设置：config.ts 在 import 时读取 env。
process.env.LOG_LEVEL = "silent";

// 动态引入被测模块（env 已生效）。
const { ImageDescriber } = await import("../src/chat/images.js");

// 伪造的 PNG 字节：只需有 PNG 魔术头，下载逻辑不校验完整内容。
const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n")]);
// 统计下载次数，验证「同一文件只下载一次」。
let downloads = 0;
// mock 图片下载：计数并固定返回上面的 PNG。
globalThis.fetch = (async () => {
  downloads++;
  return new Response(PNG, { status: 200 });
}) as typeof fetch;

// 构造一条带 file 与 url 的图片消息段。
const picture = (file: string) => ({ type: "image", data: { file, url: `https://img.example/${file}`, sub_type: 0 } });

/**
 * 同一张图（同一 file）并发识图两次：
 * - 两次都拿到清洗后的描述（去掉「（图中无文字）」注记）；
 * - 底层只下载一次（并发共享同一个 Promise 任务）。
 * 识图函数收到的是 data URL，说明图片先被下载并转成了 base64。
 */
test("pictures are described once per file", async () => {
  // 只统计本用例的下载次数。
  downloads = 0;
  // 记录识图函数收到的参数前缀，验证拿到的是 data URL。
  const seen: string[] = [];
  // 假识图函数：返回带「（图中无文字）」注记的描述。
  const describer = new ImageDescriber(async (url) => {
    seen.push(url.slice(0, 22));
    return "一张手机设置页面的截图（图中无文字）";
  });
  // 并发识图同一张图。
  const [a, b] = await Promise.all([describer.observe(picture("x.png")), describer.observe(picture("x.png"))]);
  // 括号注记被 cleanDescription 清掉。
  assert.equal(a, "一张手机设置页面的截图");
  // 第二次返回同样的结果。
  assert.equal(b, a);
  // 两个并发请求只触发了一次下载。
  assert.equal(downloads, 1);
  // 识图函数拿到的是 PNG 的 data URL 前缀。
  assert.deepEqual(seen, ["data:image/png;base64,"]);
});

/**
 * 边界情况：
 * - 识图函数抛错时 observe 返回 undefined（消息不带描述继续）；
 * - 图片段没有 url 时直接返回 undefined，不触发识图。
 */
test("failures and missing urls yield no description", async () => {
  // 识图函数固定抛错。
  const describer = new ImageDescriber(async () => {
    throw new Error("vision down");
  });
  // 失败被吞掉，归一为 undefined。
  assert.equal(await describer.observe(picture("y.png")), undefined);
  // 没有 url 的图片段（只有本地文件标识）无法识图。
  assert.equal(await describer.observe({ type: "image", data: {} }), undefined);
});
