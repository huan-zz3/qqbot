/**
 * memory.test.ts —— 长期记忆（MemoryStore）与会话历史（SessionHistory）的测试。
 *
 * 覆盖场景：
 * - 私聊/群聊事实的学习、按场景分区保存与每范围条数上限（MEMORY_MAX_FACTS）；
 * - 提取器提示词的格式：说话人带 QQ 号、bot 显示为「你」、已有记忆作为合并基准；
 * - 模型幻觉出的 QQ 号被忽略、畸形提取结果不产生任何改动；
 * - 落盘文件权限（0600）与重启后私聊记忆的恢复；
 * - SessionHistory 裁剪后 since(mark) 标记仍有效；被 @ 到的人也会被 describe 收录。
 *
 * 注意：config.ts 在 import 时会读取 process.env，所以先在顶部设好环境变量，
 * 再用 await import 动态引入被测模块。
 */
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// env 必须在动态 import 之前设置：config.ts 在 import 时即固化这些值。
process.env.LOG_LEVEL = "silent";
// 每个范围（群聊/私聊）最多保留 3 条事实，便于验证截断。
process.env.MEMORY_MAX_FACTS = "3";

// 动态引入被测模块，确保上面的 env 已生效。
const { MemoryStore } = await import("../src/chat/memory.js");
const { SessionHistory } = await import("../src/chat/history.js");
// 从 describe() 的参数类型取出聊天记录类型（tests 不走类型检查，仅作书写别名）。
type ChatRecord = Parameters<InstanceType<typeof MemoryStore>["describe"]>[0][number];

// 构造一条测试用聊天记录；时间固定在 2026-09-21 11:00 UTC（北京时间 19:00）。
function record(userId: number, name: string, text: string, fromBot = false): ChatRecord {
  // atBot/replyToBot/mentionsBot 默认都不成立，具体场景由各用例覆盖。
  return { userId, name, text, time: Date.UTC(2026, 8, 21, 11, 0), fromBot, atBot: false, replyToBot: false, mentionsBot: false };
}

// 建一个临时目录里的记忆文件，并注入假提取器：记录收到的提示词、返回预设的 answer。
async function store(answer: unknown, prompts: string[] = []) {
  const file = join(await mkdtemp(join(tmpdir(), "qqbot-memory-")), "memory.json");
  const memory = new MemoryStore(file, async (system, user) => {
    prompts.push(`${system}\n${user}`);
    return answer;
  });
  return { file, memory };
}

/**
 * 私聊学习只更新实际发过言的人：模型返回的未知/未发言 QQ 号一律忽略；
 * 私聊来源的事实，在群聊 describe 时标注「私聊里告诉你的」。
 */
test("private facts are learned only for real speakers and labeled in other chats", async () => {
  const prompts: string[] = [];
  // extract 返回：42 有重复和空白事实；999 是聊天记录里没出现过的幻觉 QQ 号。
  const { memory } = await store(
    { people: [{ user_id: 42, facts: ["在北京工作", "喜欢猫", "喜欢猫", " "] }, { user_id: 999, facts: ["编的"] }] },
    prompts,
  );
  const chat = [record(42, "李四", "我在北京上班，家里有只猫"), record(1, "OvO", "猫叫啥", true)];
  // 只有 42 一人的记忆被更新：999 不在本批发言者白名单里。
  assert.equal(await memory.learn("private", "李四", chat, "OvO"), 1);
  // 幻觉账号不会在记忆里留下任何痕迹。
  assert.equal(memory.get(999), undefined);
  // 事实做过去重（「喜欢猫」重复出现）与空白过滤。
  assert.deepEqual(memory.get(42)!.private, ["在北京工作", "喜欢猫"]);
  // 提示词里说话人带 QQ 号。
  assert.match(prompts[0]!, /李四（QQ 42）：我在北京上班/);
  // bot 自己的消息显示为「你」。
  assert.match(prompts[0]!, /OvO（你）：猫叫啥/);
  // bot 不会被当作 QQ 用户标注。
  assert.doesNotMatch(prompts[0]!, /QQ 1）/);

  const group = [record(7, "张三", "晚上吃啥"), record(42, "李四", "随便")];
  // 群里描述 42：私聊学到的事实带「私聊里告诉你的」前缀；没记忆的张三不出现。
  assert.deepEqual(memory.describe(group), ["李四：私聊里告诉你的：在北京工作；喜欢猫"]);
});

/**
 * 群聊与私聊事实分开保存、各自受 MEMORY_MAX_FACTS=3 截断；
 * describe 只输出该人的已有事实（本例为群聊事实）。
 */
test("group facts sit beside private ones, capped per scope", async () => {
  // extract 返回 4 条事实，超过每范围 3 条的上限。
  const { memory } = await store({ people: [{ user_id: 42, facts: ["a", "b", "c", "d"] }] });
  await memory.learn("group", "Bot测试", [record(42, "李四", "x")], "OvO");
  // 另起一个独立实例做私聊学习：两边的记忆互不影响，上限按范围各自计算。
  const { memory: other } = await store({ people: [{ user_id: 42, facts: ["私密"] }] });
  await other.learn("private", "李四", [record(42, "李四", "y")], "OvO");
  // 群聊范围只保留前 3 条，超出的 d 被丢弃。
  assert.deepEqual(memory.get(42)!.group, ["a", "b", "c"]);
  // describe 用「；」连接事实输出。
  assert.deepEqual(memory.describe([record(42, "李四", "z")]), ["李四：a；b；c"]);
});

/**
 * 再次学习时，提示词里要带上已有记忆作为合并基准，
 * 让模型能合并重复、纠正过时的事实（而不是从头重写）。
 */
test("existing memories are shown to the extractor for merging", async () => {
  const prompts: string[] = [];
  const { memory } = await store({ people: [{ user_id: 42, facts: ["喜欢猫"] }] }, prompts);
  // 第一次学习：写入「喜欢猫」。
  await memory.learn("private", "p", [record(42, "李四", "我养猫")], "OvO");
  await memory.learn("private", "p", [record(42, "李四", "猫丢了")], "OvO");
  // 第二次学习的提示词（prompts[1]）里应包含已有记忆。
  assert.match(prompts[1]!, /李四（QQ 42）：喜欢猫/);
});

/**
 * 提取器返回畸形结果（null、非对象字符串、people 非数组、facts 非数组）时：
 * learn 返回 0、不写入任何记忆，也不抛错。
 */
test("malformed extractor output changes nothing", async () => {
  // 四种非法形状：null、字符串、people 不是数组、facts 不是数组。
  for (const answer of [null, "oops", { people: "x" }, { people: [{ user_id: 42, facts: "x" }] }]) {
    const { memory } = await store(answer);
    // 没有有效更新，且记忆库保持为空。
    assert.equal(await memory.learn("private", "p", [record(42, "a", "b")], "OvO"), 0);
    assert.equal(memory.size, 0);
  }
});

/**
 * 落盘与恢复：flush 立即写入磁盘且文件权限为 0600（记忆含群友个人信息，
 * 不允许同机其他用户读取）；同一文件新建实例 load() 后私聊事实原样读回。
 */
test("memories persist privately across restarts", async () => {
  const { file, memory } = await store({ people: [{ user_id: 42, facts: ["喜欢猫"] }] });
  await memory.learn("private", "p", [record(42, "李四", "我养猫")], "OvO");
  // flush 绕过延迟保存，立即落盘。
  await memory.flush();
  // 权限掩码必须恰好是 0600。
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  // 同一文件新建实例并 load()，模拟进程重启后的恢复。
  const reloaded = new MemoryStore(file, async () => ({}));
  await reloaded.load();
  assert.deepEqual(reloaded.get(42)!.private, ["喜欢猫"]);
});

/**
 * SessionHistory 超限时从最旧裁剪，但累计计数 total 不因裁剪减少：
 * since(mark) 以 total 差值定位，裁剪后仍只返回窗口内保留的部分。
 */
test("history marks survive trimming", () => {
  // 上限 3 条。
  const history = new SessionHistory(3);
  // 依次加入 4 条，第 1 条被裁掉。
  for (const text of ["1", "2", "3", "4"]) history.add(record(1, "a", text));
  // mark=2：total(4)-2=2，返回最近 2 条。
  assert.deepEqual(history.since(2).map((r) => r.text), ["3", "4"]);
  // mark=0：返回窗口内保留下来的全部（被裁的 1 已取不到）。
  assert.deepEqual(history.since(0).map((r) => r.text), ["2", "3", "4"]);
  // mark 已等于当前 total：没有新增，返回空数组。
  assert.deepEqual(history.since(4), []);
});

/**
 * describe 除了发言者，也收录消息里被 @ 到的人（mentions）：
 * 被 @ 的路人甲本批没发言，其记忆同样进入提示词。
 */
test("people @-mentioned are described too", async () => {
  const { memory } = await store({ people: [{ user_id: 77, facts: ["是群主"] }] });
  await memory.learn("group", "测试群", [record(77, "路人甲", "我是群主")], "OvO");
  // 王五 @ 了路人甲（mentions 里带 77）。
  const asked = { ...record(42, "王五", "@OvO 你还记得@路人甲 吗"), mentions: [77] };
  // 输出的是被 @ 者路人甲的群聊记忆。
  assert.deepEqual(memory.describe([asked]), ["路人甲：是群主"]);
});

/**
 * 学习提示词的约束与记录格式：
 * - 系统提示词要求只记长期有效的信息，并明确避开隐私；
 * - 记录行是「说话人（QQ X） → 对象：正文（引用某人的「原文」）」，
 *   引用 bot 的消息时原文标注 bot 的名字。
 */
test("the extractor is asked for lasting facts and sees who talks to whom", async () => {
  const prompts: string[] = [];
  // extract 返回空 people：本测试只关心发给模型的提示词。
  const { memory } = await store({ people: [] }, prompts);
  // 李四引用了 bot（OvO）说过的「我喜欢猫」。
  const quoted = { ...record(42, "李四", "我也是"), quote: { name: "OvO", text: "我喜欢猫", fromBot: true } };
  await memory.learn("group", "测试群", [record(1, "OvO", "我喜欢猫", true), quoted], "OvO");
  // 系统提示词要求只记长期有效的事实。
  assert.match(prompts[0]!, /长期有效/);
  // 并要求不记隐私类信息。
  assert.match(prompts[0]!, /隐私/);
  // 记录行带收信对象（→ OvO）与引用原文（「我喜欢猫」）。
  assert.match(prompts[0]!, /李四（QQ 42） → OvO：我也是（引用OvO的「我喜欢猫」）/);
});
