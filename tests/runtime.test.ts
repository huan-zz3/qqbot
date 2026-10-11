/**
 * runtime.test.ts —— 聊天主流程（src/chat/runtime.ts 的 ChatRuntime）集成测试。
 *
 * 用假的 judge（jev 打分）、假 client（记录发送/动作）、假 fetch（拦截 deepseek 请求并
 * 按队列返回模型输出）驱动真实会话逻辑，覆盖：防抖批处理、被 @ 降低门槛、白名单过滤、
 * [不回复] 跳过、表情包/图片先识图再交给 jev、私聊记忆跨会话使用、@ 名字查询与缓存、
 * 搜索工具挂载条件、长回复合并转发与降级、引用消息（历史命中或 get_msg 拉取）、
 * 回复 bot 同时 @ 他人时的收件人判定等。
 *
 * 注意：config.ts 在 import 时读取 process.env，必须先设置环境变量再动态 import。
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 缩短防抖/发送间隔/记忆延迟，让异步流程在测试里快速跑完；import 后 config 已定型。
process.env.BOT_NAME = "小猫";
process.env.BOT_GROUPS = "500";
process.env.BOT_PRIVATE_USERS = "42";
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.GATE_DIRECT_DEBOUNCE_MS = "10";
process.env.GATE_GROUP_DEBOUNCE_MS = "30";
process.env.NAPCAT_SEND_INTERVAL_MS = "0";
process.env.LOG_LEVEL = "silent";
process.env.MEMORY_LEARN_DELAY_MS = "50";
process.env.REPLY_FORWARD_PARTS = "3";

// 动态 import：让上面的 env 先于 config.ts 读取（静态 import 会被提升到赋值之前）。
const { ChatRuntime } = await import("../src/chat/runtime.js");
const { MemoryStore } = await import("../src/chat/memory.js");
type Deps = ConstructorParameters<typeof ChatRuntime>[0];

const SELF = 100;
let nextId = 1000;
// 置为 true 时让假 client 的 sendForward 抛错，用于测试合并转发失败时的逐条降级。
let forwardFails = false;

// 构造群消息事件：extra 是拼在文本前面的消息段（如 at/reply/image），
// 默认发到白名单群 500、发送者 7（昵称张三）。
function groupMessage(text: string, extra: Record<string, unknown>[] = [], groupId = 500, userId = 7) {
  return {
    post_type: "message" as const,
    message_type: "group" as const,
    message_id: nextId++,
    user_id: userId,
    group_id: groupId,
    self_id: SELF,
    time: Math.floor(Date.now() / 1000),
    message: [...extra, { type: "text", data: { text } }] as { type: string; data: Record<string, unknown> }[],
    sender: { user_id: userId, nickname: "张三", card: "" },
  };
}

// 组装被测 ChatRuntime 及各种记录器：
// - sent/forwards：分别记录 sendMessage / sendForward 的输出；
// - prompts/systems：记录每次 deepseek 请求的用户消息（聊天记录）与系统提示词；
// - tools：记录每次请求携带的工具定义（undefined 表示没挂）；
// - actions：记录 callAction 名称（get_msg / get_group_member_info / get_group_info）；
// - replies：模型输出的预置队列，按请求顺序依次弹出；回复用完后返回空串。
function setup(judge: Deps["judge"], replies: string[], memory?: Deps["memory"], search?: Deps["search"]) {
  const sent: { target: unknown; message: unknown[] }[] = [];
  const prompts: string[] = [];
  const systems: string[] = [];
  const actions: string[] = [];
  const tools: unknown[] = [];
  const forwards: { target: unknown; nodes: unknown[] }[] = [];
  // fetch 桩：拦截 deepseek chat 请求——记录 tools / 系统提示词 / 转录提示词，
  // 并按 replies 队列返回模型输出，全程不触网。
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    tools.push(body.tools);
    systems.push(body.messages[0].content);
    prompts.push(body.messages.at(-1).content);
    return new Response(JSON.stringify({ choices: [{ message: { content: replies.shift() ?? "" } }] }), { status: 200 });
  }) as typeof fetch;
  // 假 NapCat 客户端：
  // - sendMessage/sendForward 记录发送，sendForward 受 forwardFails 控制（用于降级测试）；
  // - get_msg 返回固定引用消息（王五的「GitHub Trending 今日榜单」）；
  // - get_group_member_info 只有查 777 时返回群名片「路人甲」，其余为空（走「某人」兜底）。
  const client = {
    selfId: SELF,
    sendMessage: async (target: unknown, message: unknown[]) => {
      sent.push({ target, message });
      return nextId++;
    },
    sendForward: async (target: unknown, nodes: unknown[]) => {
      if (forwardFails) throw new Error("forward unsupported");
      forwards.push({ target, nodes });
      return nextId++;
    },
    callAction: async (action: string, params: { user_id?: number }) => {
      actions.push(action);
      if (action === "get_msg") {
        return {
          status: "ok" as const,
          retcode: 0,
          data: { user_id: 8, sender: { card: "王五" }, message: [{ type: "text", data: { text: "GitHub Trending 今日榜单" } }] },
        };
      }
      if (action === "get_group_member_info") {
        return { status: "ok" as const, retcode: 0, data: params.user_id === 777 ? { card: "路人甲" } : {} };
      }
      return { status: "ok" as const, retcode: 0, data: { group_name: "测试群" } };
    },
  } as unknown as Deps["client"];
  // stickers 默认不装（需要时由用例通过私有 deps 注入替身）；返回全部记录器供断言。
  return { runtime: new ChatRuntime({ client, judge, search, stickers: undefined, memory }), sent, prompts, systems, actions, tools, forwards };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 被 @ 时门槛降到 GATE_DIRECT_THRESHOLD（默认 0.45）：should_reply 0.5 低于群聊阈值 0.6
// 也会回复；回复按行拆成两条消息；传给模型的聊天记录带 ★（待回应）并标注说给「你」（bot）。
test("@bot with a modest jev score gets a reply", async () => {
  const { runtime, sent, prompts } = setup(async () => ({ should_reply: 0.5, addressed: 1 }), ["在的\n咋了"]);
  runtime.handle(groupMessage("在吗", [{ type: "at", data: { qq: String(SELF) } }]));
  await wait(2000);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0]!.target, { groupId: 500 });
  assert.deepEqual(sent[0]!.message, [{ type: "text", data: { text: "在的" } }]);
  // 记录格式：★ 标记待回应消息，→ 后是这条消息说给谁（此处是 @bot）。
  assert.match(prompts[0]!, /★\[\d\d:\d\d\] 张三 → 你：@小猫 在吗/);
});

// 防抖合并：连续两条消息作为一批（batches 依次记录每批的新消息数，应为 2、1）；
// 回复写作期间（fetch 被挂起）又来了第三人的消息，回复发出时对话已前进，
// 因此消息带 reply 引用段（segments[0].type === "reply"）；第二批判定为不回复。
test("burst of messages is judged once and quoted when others kept talking", async () => {
  const batches: number[] = [];
  let resolveReply: (() => void) | undefined;
  const { runtime, sent } = setup(async (state) => {
    batches.push((state as { new_messages: unknown[] }).new_messages.length);
    return { should_reply: batches.length === 1 ? 0.9 : 0.1, addressed: 0.5 };
  }, ["我也觉得"]);
  // 在 setup 的 fetch 桩外再包一层：模型请求被挂起，直到测试调用 resolveReply 放行，
  // 以此模拟「回复还在生成时新消息到达」的时序。
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    await new Promise<void>((resolve) => {
      resolveReply = resolve;
    });
    return origFetch(...args);
  }) as typeof fetch;

  runtime.handle(groupMessage("今天好热"));
  runtime.handle(groupMessage("是啊"));
  await wait(100);
  runtime.handle(groupMessage("别的话题", [], 500, 8));
  resolveReply?.();
  await wait(200);

  // 两条消息在防抖窗口内合并为一批一起判断；回复期间到达的消息单独作为下一批。
  // 批次长度依次为 2、1；第二批 should_reply 0.1 不回复，所以总共只发出 1 条。
  assert.deepEqual(batches, [2, 1]);
  assert.equal(sent.length, 1);
  const segments = sent[0]!.message as { type: string }[];
  assert.equal(segments[0]!.type, "reply");
});

// 边界：被 @（addressed 0.8）只是降低门槛，最终仍看 should_reply——0.1 低于 0.45 就不发言。
test("@bot with a bare reaction is left alone when jev says no", async () => {
  const { runtime, sent } = setup(async () => ({ should_reply: 0.1, addressed: 0.8 }), ["不该发"]);
  runtime.handle(groupMessage("哈哈哈", [{ type: "at", data: { qq: String(SELF) } }]));
  await wait(100);
  assert.equal(sent.length, 0);
});

// 白名单/自过滤：非白名单群（999）与 bot 自己发出的消息（user_id === selfId）
// 都在进入判断前被丢弃，jev 一次都不会被调用。
test("ignores disabled groups and the bot's own messages", async () => {
  let judged = 0;
  const { runtime, sent } = setup(async () => {
    judged++;
    return { should_reply: 1 };
  }, ["x"]);
  runtime.handle(groupMessage("hi", [], 999));
  runtime.handle(groupMessage("hi", [], 500, SELF));
  await wait(100);
  assert.equal(judged, 0);
  assert.equal(sent.length, 0);
});

// 模型输出恰好是 [不回复]：postProcess 解析为空，什么都不发。
test("model can decline with the skip marker", async () => {
  const { runtime, sent } = setup(async () => ({ should_reply: 0.9, addressed: 0.9 }), ["[不回复]"]);
  runtime.handle(groupMessage("hello"));
  await wait(150);
  assert.equal(sent.length, 0);
});

// 表情包先识图再进入判断：jev 看到的文本是 [表情包：猫猫叹气]（识图有延迟，会话会等媒体就绪）；
// 模型回复里合法编号 #3 发出对应图片段，#99 不存在被跳过，共发 2 条。
test("stickers are described before jev sees them and can be sent back", async () => {
  // 收藏库替身：observe 延迟 20ms 返回描述，模拟识图耗时；list/byId/toSegment 提供发送素材。
  const described: string[] = [];
  const store = {
    observe: async () => {
      await wait(20);
      return "猫猫叹气";
    },
    list: () => [{ id: 3, description: "猫猫叹气" }],
    byId: (id: number) => (id === 3 ? { id: 3, description: "猫猫叹气" } : undefined),
    toSegment: async () => ({ type: "image", data: { file: "base64://R0lG", sub_type: 1 } }),
  };
  const { runtime, sent, prompts } = setup(async (state) => {
    described.push((state as { new_messages: { text: string }[] }).new_messages[0]!.text);
    return { should_reply: 0.9, addressed: 0.2 };
  }, ["确实\n[表情包#3]\n[表情包#99]"]);
  // 构造后注入替身（deps 是构造参数）：直接替换私有字段以模拟真实收藏库。
  (runtime as unknown as { deps: { stickers: unknown } }).deps.stickers = store;

  runtime.handle(groupMessage("", [{ type: "image", data: { file: "a.gif", url: "https://x/a.gif", sub_type: 1 } }]));
  await wait(2500);

  assert.deepEqual(described, ["[表情包：猫猫叹气]"]);
  assert.match(prompts[0]!, /张三：\[表情包：猫猫叹气\]/);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]!.message, [{ type: "image", data: { file: "base64://R0lG", sub_type: 1 } }]);
});

// 私聊白名单：43 不在 BOT_PRIVATE_USERS（只有 42），消息直接丢弃；
// 只有 42 的消息会被判断，回复目标是 { userId: 42 }。
test("private chat only answers whitelisted users", async () => {
  const judged: number[] = [];
  const { runtime, sent } = setup(async (state) => {
    judged.push(1);
    return { should_reply: 0.9, addressed: 0.9 };
  }, ["在"]);
  const privateMessage = (userId: number) => ({
    ...groupMessage("在吗", [], 0, userId),
    message_type: "private" as const,
    group_id: undefined,
  });
  runtime.handle(privateMessage(43));
  runtime.handle(privateMessage(42));
  await wait(1700);
  assert.equal(judged.length, 1);
  assert.deepEqual(sent.map((item) => item.target), [{ userId: 42 }]);
});

// 模型写 [doge]：表情名转成真实 face 段（id 179），与同行的文字段一起发出。
test("face names in a reply are sent as real faces within the same message", async () => {
  const { runtime, sent } = setup(async () => ({ should_reply: 0.9, addressed: 0.9 }), ["不至于吧[doge]"]);
  runtime.handle(groupMessage("在吗", [{ type: "at", data: { qq: String(SELF) } }]));
  await wait(200);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.message, [
    { type: "text", data: { text: "不至于吧" } },
    { type: "face", data: { id: "179" } },
  ]);
});

// 记忆与跨会话使用：私聊里说的「在北京上班」经 MemoryStore（learn 桩）整理后，
// 群里再发言时系统提示词带上标注「私聊里告诉你的」的长期记忆。
test("what was said in private is remembered in the group", async () => {
  // 整理桩：记录传给模型的用户描述（断言含「和「张三」的QQ私聊」），返回固定记忆事实。
  const learned: string[] = [];
  const memory = new MemoryStore(join(tmpdir(), `qqbot-mem-${process.pid}.json`), async (_system, user) => {
    learned.push(user);
    return { people: [{ user_id: 42, facts: ["在北京工作"] }] };
  });
  const { runtime, systems } = setup(async () => ({ should_reply: 0.9, addressed: 0.9 }), ["好嘞", "北京打工人来了"], memory);
  runtime.handle({ ...groupMessage("我在北京上班", [], 0, 42), message_type: "private" as const, group_id: undefined });
  await wait(1800);
  assert.equal(learned.length, 1);
  assert.match(learned[0]!, /和「张三」的QQ私聊/);

  runtime.handle(groupMessage("有人吗", [{ type: "at", data: { qq: String(SELF) } }], 500, 42));
  await wait(200);
  assert.match(systems.at(-1)!, /- 张三：私聊里告诉你的：在北京工作/);
});

// @ 名字查询：777 首次出现时调 get_group_member_info 缓存群名片「路人甲」，
// 之后复用缓存（整场只查一次）；jev/模型看到的文本用名字，绝不泄露 QQ 号。
test("@ names are looked up once and shown to jev and the model", async () => {
  const seen: string[] = [];
  const { runtime, prompts, actions } = setup(async (state) => {
    seen.push((state as { new_messages: { text: string }[] }).new_messages.map((m) => m.text).join(" | "));
    return { should_reply: 0.9, addressed: 0.9 };
  }, ["记得啊", "嗯"]);
  const at = (qq: number) => ({ type: "at", data: { qq: String(qq) } });
  runtime.handle(groupMessage("吗", [at(SELF), { type: "text", data: { text: "你还记得" } }, at(777)], 500, 9));
  await wait(200);
  runtime.handle(groupMessage("呢", [at(SELF), at(777), at(9)], 500, 7));
  await wait(200);

  assert.equal(seen[0], "@小猫 你还记得@路人甲 吗");
  assert.equal(seen[1], "@小猫 @路人甲 @张三 呢");
  // 传给模型的文本里不允许出现原始 QQ 号；名字查一次后走缓存。
  assert.doesNotMatch(prompts.join("\n"), /777/);
  assert.equal(actions.filter((action) => action === "get_group_member_info").length, 1);
});

// 搜索工具挂载条件 = needs_search > 0.1 且 MCP 搜索可用：
// 0.31 达标挂 MCP 工具；0.05 不挂；不可用时哪怕 0.9 也不挂（tools[1]、tools[2] 为 undefined）。
test("search tools are offered when jev scores it above 0.1 and the MCP server is usable", async () => {
  let usable = true;
  const scores = [0.31, 0.05, 0.9];
  const search = {
    usable: () => usable,
    tools: () => [
      {
        definition: { type: "function", function: { name: "search", description: "", parameters: {} } },
        handler: async () => "",
      },
    ],
  } as unknown as Deps["search"];
  const { runtime, tools } = setup(
    async () => ({ should_reply: 0.9, addressed: 0.9, needs_search: scores.shift()! }),
    ["a", "b", "c"],
    undefined,
    search,
  );
  const at = { type: "at", data: { qq: String(SELF) } };
  runtime.handle(groupMessage("你自己去搜一下jev", [at]));
  await wait(200);
  runtime.handle(groupMessage("哈哈", [at]));
  await wait(200);
  usable = false;
  runtime.handle(groupMessage("今天比分多少", [at]));
  await wait(200);
  assert.equal((tools[0] as { function: { name: string } }[])[0]!.function.name, "search");
  assert.equal(tools[1], undefined);
  assert.equal(tools[2], undefined);
});

// 长回复（REPLY_FORWARD_PARTS=3）：首行短正文照常单发，其余打包成一条合并转发（node 用 bot 昵称）；
// 当转发失败时降级为逐行普通消息，保证内容仍送达；等待时间覆盖分条发送的打字间隔。
test("long replies are sent as one merged forward, with a plain fallback", async () => {
  const at = { type: "at", data: { qq: String(SELF) } };
  const long = "展开讲讲👇\n第一点\n第二点\n第三点\n第四点";
  const { runtime, sent, forwards } = setup(async () => ({ should_reply: 0.9, addressed: 0.9 }), [long, long]);
  runtime.handle(groupMessage("详细说说", [at]));
  await wait(2500);
  assert.deepEqual(sent.map((item) => item.message), [[{ type: "text", data: { text: "展开讲讲👇" } }]]);
  assert.equal(forwards.length, 1);
  const node = (forwards[0]!.nodes as { type: string; data: { nickname: string; content: unknown } }[])[0]!;
  assert.equal(node.type, "node");
  assert.equal(node.data.nickname, "小猫");
  assert.deepEqual(node.data.content, [{ type: "text", data: { text: "第一点\n第二点\n第三点\n第四点" } }]);

  // 转发失败降级：同样先单发首行，正文 4 行改为逐条补发；等 9 秒覆盖逐条的打字间隔。
  forwardFails = true;
  runtime.handle(groupMessage("再说一次", [at]));
  await wait(9000);
  forwardFails = false;
  assert.equal(sent.length, 1 + 1 + 4);
});

// 普通图片同样先识图：jev 看到的文本是 [图片：手机设置页面的截图] 加原文。
test("pictures are described before jev sees them", async () => {
  const seen: string[] = [];
  const { runtime } = setup(async (state) => {
    seen.push((state as { new_messages: { text: string }[] }).new_messages[0]!.text);
    return { should_reply: 0.1, addressed: 0.1 };
  }, []);
  // 普通图片识图替身：同样是构造后注入私有 deps。
  const images = { observe: async () => "手机设置页面的截图" };
  (runtime as unknown as { deps: { images: unknown } }).deps.images = images;
  runtime.handle(groupMessage("你看图片了吗", [{ type: "image", data: { file: "p.png", url: "https://x/p.png", sub_type: 0 } }]));
  await wait(300);
  assert.deepEqual(seen, ["[图片：手机设置页面的截图]你看图片了吗"]);
});

// 模型回复写 @张三：名字来自发送者缓存（第一条消息的昵称），
// 发送时转成真 @ 段（qq "7"）+ 空格文本，而不是纯文字。
test("@名字 in a reply becomes a real mention of a known member", async () => {
  const { runtime, sent } = setup(async () => ({ should_reply: 0.9, addressed: 0.9 }), ["@张三 你问的是这个？"]);
  runtime.handle(groupMessage("在吗", [{ type: "at", data: { qq: String(SELF) } }], 500, 7));
  await wait(200);
  assert.deepEqual(sent.at(-1)!.message.slice(0, 2), [
    { type: "at", data: { qq: "7" } },
    { type: "text", data: { text: " " } },
  ]);
});

// 引用消息两种来源：历史里有的直接用（「同意」引张三的「今晚吃火锅」）；
// 历史没有的（id 999999）调一次 get_msg 拉取（王五的「GitHub Trending 今日榜单」）。
// 提示词里引用格式为「说话人 → 对象：正文（引用某人的「原文」）」。
test("quoted messages are shown, from history or fetched via get_msg", async () => {
  const seen: Record<string, unknown>[] = [];
  const { runtime, actions, prompts } = setup(async (state) => {
    seen.push((state as { new_messages: Record<string, unknown>[] }).new_messages[0]!);
    return { should_reply: seen.length === 3 ? 0.9 : 0.1, addressed: 0.1 };
  }, ["嗯"]);
  const first = groupMessage("今晚吃火锅");
  runtime.handle(first);
  await wait(100);
  runtime.handle(groupMessage("同意", [{ type: "reply", data: { id: String(first.message_id) } }], 500, 8));
  await wait(100);
  runtime.handle(groupMessage("这些都是干什么的", [{ type: "reply", data: { id: "999999" } }]));
  await wait(200);
  assert.equal(seen[1]!.text, "同意");
  assert.deepEqual(seen[1]!.to, ["张三"]);
  assert.equal(seen[1]!.quoting, "张三的「今晚吃火锅」");
  assert.equal(seen[2]!.quoting, "王五的「GitHub Trending 今日榜单」");
  assert.match(prompts.at(-1)!, /张三 → 王五：这些都是干什么的（引用王五的「GitHub Trending 今日榜单」）/);
  assert.equal(actions.filter((action) => action === "get_msg").length, 1);
});

// 收件人判定：回复 bot 的消息却又 @ 了别人（qq 9，昵称张三），则 to 指向张三；
// 同时记录 replies_to_bot = true，表示群里是在跟被 @ 的人说话。
test("replying to the bot while @-ing someone else is addressed to that person", async () => {
  const seen: Record<string, unknown>[] = [];
  const { runtime } = setup(async (state) => {
    seen.push((state as { new_messages: Record<string, unknown>[] }).new_messages[0]!);
    return { should_reply: 0.9, addressed: 0.9 };
  }, ["嗯嗯"]);
  runtime.handle(groupMessage("在吗", [{ type: "at", data: { qq: String(SELF) } }], 500, 9));
  await wait(200);
  const botMessageId = nextId - 1;
  runtime.handle(
    groupMessage("没绷住", [{ type: "reply", data: { id: String(botMessageId) } }, { type: "at", data: { qq: "9" } }], 500, 7),
  );
  await wait(200);
  assert.deepEqual(seen[1]!.to, ["张三"]);
  assert.equal(seen[1]!.replies_to_bot, true);
  assert.equal(seen[1]!.quoting, "小猫的「嗯嗯」");
});

// 群管理优先：本批里若有消息被群管理处理过（handoff.handled 命中），整批跳过 AI 回复——
// jev 与模型都不调用，也不发送任何消息。
test("a batch with a moderation-handled message skips the AI reply", async () => {
  let judged = 0;
  const { runtime, sent, prompts } = setup(async () => {
    judged++;
    return { should_reply: 0.9, addressed: 0.9 };
  }, ["不该发"]);
  const handled = new Set<number>();
  (runtime as unknown as { deps: { handoff: unknown } }).deps.handoff = {
    handled: (id: number) => handled.has(id),
    mark: () => undefined,
  };
  const msg = groupMessage("广告消息");
  handled.add(msg.message_id); // 模拟该消息已被群管理命中
  runtime.handle(msg);
  await wait(200);
  assert.equal(judged, 0);
  assert.equal(sent.length, 0);
  assert.equal(prompts.length, 0);
});

// 对照组：装了 handoff 但没有命中（handled 恒 false）时，回复流程照常进行。
test("a batch with no moderation hit replies as usual", async () => {
  const { runtime, sent } = setup(async () => ({ should_reply: 0.9, addressed: 0.9 }), ["在的"]);
  (runtime as unknown as { deps: { handoff: unknown } }).deps.handoff = {
    handled: () => false,
    mark: () => undefined,
  };
  runtime.handle(groupMessage("在吗"));
  await wait(200);
  assert.equal(sent.length, 1);
});

// 模型调用 opencode 且本批发言人带有文本文件时，把文件内容作为上下文前置注入 opencode 的 prompt。
test("a text file from the current speaker is injected into the opencode call", async () => {
  const { runtime } = setup(async () => ({ should_reply: 0.9, addressed: 0.9 }), ["看完了"]);
  // 假文件存储：记录被读取的 ref，返回文本内容。
  const readRefs: { name: string }[] = [];
  (runtime as unknown as { deps: { files: unknown } }).deps.files = {
    read: async (ref: { name: string }) => {
      readRefs.push(ref);
      return { status: "text", content: "文件正文", truncated: false };
    },
  };
  // 假 opencode：记录收到的 prompt（应含文件内容）。
  const agentPrompts: string[] = [];
  (runtime as unknown as { deps: { opencode: unknown } }).deps.opencode = {
    run: async (prompt: string) => {
      agentPrompts.push(prompt);
      return "看完了";
    },
  };
  // 第一轮返回 opencode 工具调用，第二轮收尾；模型最终输出 "看完了"。
  // 自定义 fetch 同时记录首轮 user 消息（聊天记录），替代 setup 的记录器。
  const transcripts: string[] = [];
  let round = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    round++;
    const body = JSON.parse(String(init.body));
    if (round === 1) {
      transcripts.push(body.messages.at(-1).content);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "opencode", arguments: JSON.stringify({ prompt: "查看文件" }) } },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "看完了" } }] }), { status: 200 });
  }) as typeof fetch;

  runtime.handle(
    groupMessage("帮我看看这个文件", [{ type: "file", data: { file: "报告.txt", file_id: "f1", file_size: 1024 } }]),
  );
  await wait(400);

  // 聊天记录里文件渲染为 [文件：名（大小）]，模型据此知道有可引用的文件。
  assert.match(transcripts[0]!, /\[文件：报告\.txt（1\.0KB）\]/);
  assert.deepEqual(readRefs.map((ref) => ref.name), ["报告.txt"]);
  assert.match(agentPrompts[0]!, /文件正文/);
  assert.match(agentPrompts[0]!, /查看文件/);
});

// 非文本文件：opencode 上下文里说明无法读取（带上原因），而不是静默省略。
test("an unsupported file is reported in the opencode context", async () => {
  const { runtime } = setup(async () => ({ should_reply: 0.9, addressed: 0.9 }), ["看完了"]);
  (runtime as unknown as { deps: { files: unknown } }).deps.files = {
    read: async () => ({ status: "unsupported", reason: "只支持文本类文件" }),
  };
  const agentPrompts: string[] = [];
  (runtime as unknown as { deps: { opencode: unknown } }).deps.opencode = {
    run: async (prompt: string) => {
      agentPrompts.push(prompt);
      return "看完了";
    },
  };
  let round = 0;
  globalThis.fetch = (async () => {
    round++;
    if (round === 1) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "opencode", arguments: JSON.stringify({ prompt: "看看" }) } },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "看完了" } }] }), { status: 200 });
  }) as typeof fetch;

  runtime.handle(groupMessage("看看这个包", [{ type: "file", data: { file: "archive.zip", file_id: "z1", file_size: 10 } }]));
  await wait(400);
  assert.match(agentPrompts[0]!, /无法读取：只支持文本类文件/);
});

// 只有本批发言人的文件会被注入：上一批别人发的文件不进本次 opencode 上下文。
test("files from other senders are not injected", async () => {
  let judged = 0;
  const { runtime } = setup(async () => {
    judged++;
    return { should_reply: judged === 1 ? 0.1 : 0.9, addressed: 0.9 };
  }, ["看完了"]);
  (runtime as unknown as { deps: { files: unknown } }).deps.files = {
    read: async () => ({ status: "text", content: "机密内容", truncated: false }),
  };
  const agentPrompts: string[] = [];
  (runtime as unknown as { deps: { opencode: unknown } }).deps.opencode = {
    run: async (prompt: string) => {
      agentPrompts.push(prompt);
      return "看完了";
    },
  };
  let round = 0;
  globalThis.fetch = (async () => {
    round++;
    if (round === 1) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "opencode", arguments: JSON.stringify({ prompt: "看看" }) } },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "看完了" } }] }), { status: 200 });
  }) as typeof fetch;

  // 第一批：用户 8 只发文件，jev 说不回复（不触发 opencode）。
  runtime.handle(groupMessage("", [{ type: "file", data: { file: "机密.txt", file_id: "s1", file_size: 10 } }], 500, 8));
  await wait(200);
  // 第二批：用户 7 提问，opencode 上下文里不应包含 8 的文件内容。
  runtime.handle(groupMessage("看看代码", [{ type: "at", data: { qq: String(SELF) } }], 500, 7));
  await wait(300);
  assert.equal(agentPrompts.length, 1);
  assert.doesNotMatch(agentPrompts[0]!, /机密内容/);
});
