/**
 * stickers.test.ts —— 表情包收藏（src/chat/stickers.ts）与媒体工具（src/chat/media.ts）测试。
 *
 * 覆盖：
 * - sniffMime：按文件头魔数识别 GIF/JPEG 等图片格式；
 * - StickerStore：首次见到表情时下载 + 识图并收藏、并发/重复出现去重、按 base64 重发、
 *   商城表情按 mface 原样重发、超出上限时淘汰最少用的并从磁盘删文件、
 *   淘汰项转入归档后再次出现免识图（跨重启仍可复用）、归档按上限裁剪、mface 提升不下载、
 *   索引持久化（index.json / archive.json）与加载时清洗历史描述、候选列表按群友发送次数排序再打乱；
 * - cleanDescription：去掉识图描述里「没有文字/图中无文字」这类废话。
 *
 * 注意：config.ts 在 import 时读取 process.env，先设环境变量再动态 import 被测模块。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 静默日志，避免测试输出噪声；必须在动态 import 之前设置。
process.env.LOG_LEVEL = "silent";

// 动态 import：让上面的 env 先生效（静态 import 会被提升到赋值之前）。
const { StickerStore } = await import("../src/chat/stickers.js");
const { sniffMime, cleanDescription } = await import("../src/chat/media.js");

// 最小合法 GIF89a 字节串：既满足 sniffMime 的魔数判断，也能被 base64 重发校验。
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "binary");
// 替换全局 fetch：收藏流程的下载走这里，用计数断言「同一张表情只下载一次」。
let downloads = 0;
globalThis.fetch = (async () => {
  downloads++;
  return new Response(GIF, { status: 200 });
}) as typeof fetch;

// 构造收到的图片段：file 是去重键的一部分，url 供收藏时下载；sub_type 1 表示收藏表情。
const image = (file: string) => ({ type: "image", data: { file, url: `https://img.example/${file}`, sub_type: 1 } });

// 建隔离的临时目录 + StickerStore：每个用例自己的收藏库，互不干扰；
// describe 是识图桩（默认返回固定描述），max 用于测试淘汰上限，archiveMax 测试归档上限。
async function store(max = 300, describe = async () => "猫猫叹气", archiveMax = 2000) {
  const dir = await mkdtemp(join(tmpdir(), "qqbot-stickers-"));
  const instance = new StickerStore(dir, describe, max, archiveMax);
  await instance.load();
  return { dir, instance };
}

// sniffMime 按文件头识别：GIF89a 魔数 → image/gif；FF D8（JPEG SOI）→ image/jpeg；
// 任意字节不匹配任何签名 → undefined（调用方据此拒绝收藏）。
test("sniffs image types from bytes", () => {
  assert.equal(sniffMime(GIF), "image/gif");
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff])), "image/jpeg");
  assert.equal(sniffMime(Buffer.from("hello")), undefined);
});

// 首次见到：下载 + 识图各一次；同一张表情并发出现也复用结果，不重复下载识图；
// 再次出现计入 seen；toSegment 把原字节转成 base64 发送并计入 used；
// flush 后用新实例从磁盘读取，描述可恢复（describe 返回「不该调用」作哨兵，证明未重新识图）。
test("collects a sticker once and reuses its description", async () => {
  downloads = 0;
  let described = 0;
  const { dir, instance } = await store(300, async () => {
    described++;
    return "猫猫叹气";
  });
  const [a, b] = await Promise.all([instance.observe(image("a.gif")), instance.observe(image("a.gif"))]);
  assert.equal(a, "猫猫叹气");
  assert.equal(b, "猫猫叹气");
  assert.equal(await instance.observe(image("a.gif")), "猫猫叹气");
  assert.equal(downloads, 1);
  assert.equal(described, 1);

  const [sticker] = instance.list();
  assert.equal(sticker!.id, 1);
  assert.equal(sticker!.seen, 2);
  const segment = await instance.toSegment(sticker!);
  assert.equal(segment.type, "image");
  assert.equal(segment.data.sub_type, 1);
  assert.equal(segment.data.file, `base64://${GIF.toString("base64")}`);

  await instance.flush();
  const saved = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
  assert.equal(saved[0].used, 1);
  const reloaded = new StickerStore(dir, async () => "不该调用");
  await reloaded.load();
  assert.equal(reloaded.byId(1)?.description, "猫猫叹气");
});

// 商城表情（mface）：收藏后重发时按原字段（emoji_id / emoji_package_id / key / summary）
// 原样以 mface 段发出，不依赖本地下载的图片文件。
test("market faces are resent as mface", async () => {
  const { instance } = await store();
  const mface = {
    type: "mface",
    data: { emoji_id: "e1", emoji_package_id: 7, key: "k", summary: "[嘻嘻]", url: "https://img.example/m.gif" },
  };
  assert.equal(await instance.observe(mface), "猫猫叹气");
  const segment = await instance.toSegment(instance.list()[0]!);
  assert.deepEqual(segment, { type: "mface", data: { emoji_id: "e1", emoji_package_id: 7, key: "k", summary: "[嘻嘻]" } });
});

// 上限为 2：a 出现两次、b/c 各一次后收藏满 3 张，淘汰评分最低的 b；
// 期望只保留 image:a.gif 与 image:c.gif，且磁盘上删掉了 b 的文件（剩 2 个 .gif）。
test("evicts the least used sticker and its file when full", async () => {
  const { dir, instance } = await store(2);
  await instance.observe(image("a.gif"));
  await instance.observe(image("a.gif"));
  await instance.observe(image("b.gif"));
  await instance.observe(image("c.gif"));
  assert.equal(instance.size, 2);
  assert.deepEqual(
    instance.list().map((sticker) => sticker.key).sort(),
    ["image:a.gif", "image:c.gif"],
  );
  assert.equal((await readdir(dir)).filter((file) => file.endsWith(".gif")).length, 2);
});

// 归档：被淘汰的表情再次出现时复用归档描述、不再识图；活跃满了但分数够则提升回收藏。
// describe 用计数桩，断言「重新出现」没有第二次识图。
test("reuses an evicted sticker's archived description without re-describing", async () => {
  let described = 0;
  const { instance } = await store(1, async () => {
    described++;
    return "猫猫叹气";
  });
  await instance.observe(image("a.gif"));
  assert.equal(described, 1);
  await instance.observe(image("b.gif")); // 上限 1：a 被淘汰进归档
  assert.equal(instance.size, 1);
  assert.equal(instance.archiveSize, 1);
  const baseline = described; // b 是新表情要识图，此后不应再增加
  assert.equal(await instance.observe(image("a.gif")), "猫猫叹气"); // 命中归档
  assert.equal(described, baseline); // 复用归档，未再识图
});

// 归档跨重启：flush 后新实例 load，归档里的描述仍可直接复用，识图桩设为抛错以证明未被调用。
test("archived descriptions survive a reload without re-describing", async () => {
  const { dir, instance } = await store(1, async () => "猫猫叹气");
  await instance.observe(image("a.gif"));
  await instance.observe(image("b.gif")); // a 进归档
  await instance.flush();
  const reloaded = new StickerStore(
    dir,
    async () => {
      throw new Error("不该识图");
    },
    1,
  );
  await reloaded.load();
  assert.equal(reloaded.archiveSize, 1);
  assert.equal(await reloaded.observe(image("a.gif")), "猫猫叹气");
});

// 归档本身也有上限：超过 archiveMax 时按 lastSeen 淘汰最旧的，活跃收藏不受影响。
test("caps the archive by dropping the oldest entries", async () => {
  const { instance } = await store(1, async () => "猫猫叹气", 2);
  for (const file of ["a.gif", "b.gif", "c.gif", "d.gif"]) await instance.observe(image(file));
  assert.equal(instance.size, 1);
  assert.equal(instance.archiveSize, 2);
});

// 商城表情提升：从当前段重建 mface 原字段，无需下载图片（断言 fetch 计数不增）。
test("promotes an archived mface without downloading", async () => {
  const { instance } = await store(1, async () => "猫猫叹气");
  const face = (id: string) => ({
    type: "mface",
    data: { emoji_id: id, emoji_package_id: 7, key: "k", summary: "[嘻嘻]", url: `https://img.example/${id}.gif` },
  });
  await instance.observe(face("e1"));
  await instance.observe(face("e2")); // e1 进归档
  const before = downloads;
  assert.equal(await instance.observe(face("e1")), "猫猫叹气");
  assert.equal(downloads, before); // 提升 mface 不下载
  const promoted = instance.list().find((sticker) => sticker.key === "mface:e1")!;
  assert.deepEqual((await instance.toSegment(promoted)).data, {
    emoji_id: "e1",
    emoji_package_id: 7,
    key: "k",
    summary: "[嘻嘻]",
  });
});

// 边界：识图返回空串代表这张图没有收藏价值，observe 返回 undefined 且不入库。
test("failed description is not stored", async () => {
  const { instance } = await store(300, async () => "");
  assert.equal(await instance.observe(image("x.gif")), undefined);
  assert.equal(instance.size, 0);
});

// cleanDescription 表驱动：删除「没有文字 / 图中无文字 / 图内无文字」等描述缺字的废话，
// 保留真实语义；末例的「图片文字为…」在描述图里确有的文字，不能被误删。
test("descriptions drop remarks about missing text", () => {
  const cases: [string, string][] = [
    ["这是一个没有文字、表示开心或笑的标准黄色笑脸表情。", "这是一个表示开心或笑的标准黄色笑脸表情。"],
    ["图中无文字，这张表情包表达了极度震惊、感动或崩溃的夸张大哭。", "这张表情包表达了极度震惊、感动或崩溃的夸张大哭。"],
    ["这个表情包表达了一种面无表情、呆滞、无语或尴尬的中立情绪（图中无文字）。", "这个表情包表达了一种面无表情、呆滞、无语或尴尬的中立情绪。"],
    ["图片没有文字，它表达的是委屈地揉眼睛大哭。", "它表达的是委屈地揉眼睛大哭。"],
    ["委屈、无奈又可怜巴巴的无语感（图内无文字）。", "委屈、无奈又可怜巴巴的无语感。"],
    ["这个表情包没有文字，表达的是愤怒、咬牙切齿的情绪。", "这个表情包表达的是愤怒、咬牙切齿的情绪。"],
    ["图片文字为“上面的人是gay”，表达调侃。", "图片文字为“上面的人是gay”，表达调侃。"],
  ];
  for (const [raw, clean] of cases) assert.equal(cleanDescription(raw), clean);
});

// 双重清洗：新收藏的描述在入库前就被清洗（「开心（图中无文字）」→「开心」）；
// 手动把 index.json 改成带噪声的旧数据后重新 load，加载时同样会被清洗。
test("stored descriptions are cleaned on load", async () => {
  const { dir, instance } = await store(300, async () => "开心（图中无文字）");
  await instance.observe(image("q.gif"));
  await instance.flush();
  const raw = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
  raw[0].description = "图中无文字，一脸不爽";
  await writeFile(join(dir, "index.json"), JSON.stringify(raw));
  const reloaded = new StickerStore(dir, async () => "");
  await reloaded.load();
  assert.equal(instance.list()[0]!.description, "开心");
  assert.equal(reloaded.list()[0]!.description, "一脸不爽");
});

// 候选排序只看 seen（群友发送次数）：a 被 bot 自己用了 10 次仍排不进前 2，取前 2 应得 b/c；
// list() 每次打乱顺序——30 次调用中至少出现两种不同顺序（防止模型总挑同一批而自我强化）。
test("sticker list is ranked by what people post, not by the bot's own use, and shuffled", async () => {
  const { instance } = await store(300);
  for (const file of ["a.gif", "b.gif", "c.gif"]) await instance.observe(image(file));
  await instance.observe(image("b.gif"));
  await instance.observe(image("c.gif"));
  const a = instance.list().find((sticker) => sticker.key === "image:a.gif")!;
  for (let i = 0; i < 10; i++) await instance.toSegment(a);
  assert.deepEqual(instance.list(2).map((sticker) => sticker.key).sort(), ["image:b.gif", "image:c.gif"]);
  const orders = new Set(Array.from({ length: 30 }, () => instance.list().map((sticker) => sticker.id).join(",")));
  assert.ok(orders.size > 1);
});
