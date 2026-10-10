/**
 * index.ts —— 进程入口：装配依赖、接线事件、处理退出
 *
 * 流程：校验必需配置（缺 DeepSeek key 直接退出）→ 按配置创建各组件（jev 判定、
 * Codex 搜索、表情包、图片识图、记忆、电源开关）→ 建 WS 客户端，把消息事件
 * 分发给聊天运行时与群管理 → 注册 SIGINT/SIGTERM 优雅退出（先落盘再断开）。
 *
 * 组件按需创建：配置关闭或初始化失败时对应依赖为 undefined，各模块自行降级
 * （例如无 jev 时 gate 走兜底判定、搜索不可用时不给模型挂 web_search 工具）。
 */
import { config } from "./config.js";
import { ChatRuntime } from "./chat/runtime.js";
import { ImageDescriber, describeImageWith } from "./chat/images.js";
import { MemoryStore } from "./chat/memory.js";
import { PowerSwitch } from "./chat/power.js";
import { StickerStore, describeSticker } from "./chat/stickers.js";
import { createJevJudge } from "./jev/judge.js";
import { DEEPSEEK_MODEL, completeJson, describeImage } from "./llm/deepseek.js";
import { logger } from "./logger.js";
import { Moderation } from "./moderation/moderation.js";
import { NapcatClient } from "./napcat/client.js";
import { isMessageEvent } from "./napcat/types.js";
import { installProxy } from "./proxy.js";
import { CodexAuth } from "./search/codex-auth.js";
import { CodexWebSearch } from "./search/web-search.js";

async function main(): Promise<void> {
  // 最早安装代理：让后续所有 fetch（含 jev SDK）都走 PROXY_URL；留空则直连。
  const proxyOn = installProxy(config.proxy.url);

  // 没有 DeepSeek key 无法回话，直接以非零码退出。
  if (!config.deepseek.apiKey) {
    logger.error("缺少 DEEPSEEK_API_KEY");
    process.exit(1);
  }

  // jev 是可选组件：没有 key 时为 undefined，后续 gate 走无 jev 的兜底路径。
  const judge = config.jev.apiKey ? createJevJudge() : undefined;
  if (!judge) logger.warn("未设置 TYPESAFE_API_KEY：jev 不可用，只在私聊、@、回复、点名时发言");

  // 联网搜索：启动时先取一次凭证，仅为尽早发现「不可用」；失败只告警不阻止启动。
  // 凭证之后由 runtime 每次使用时再检查（过期后重新同步即可，无需重启）。
  let search: CodexWebSearch | undefined;
  if (config.search.enabled) {
    const auth = new CodexAuth(config.search.authFile);
    search = new CodexWebSearch(auth);
    await auth.get().catch((error: Error) => logger.warn(`联网搜索暂不可用：${error.message}`));
  }

  // 表情包库：从磁盘加载已收藏的表情与描述（写描述用 deepseek 识图）。
  let stickers: StickerStore | undefined;
  if (config.stickers.enabled) {
    stickers = new StickerStore(config.stickers.dir, describeSticker(describeImage));
    await stickers.load();
  }

  // 普通图片识图：描述只在内存缓存，不保存图片文件。
  const images = config.images.enabled ? new ImageDescriber(describeImageWith(describeImage)) : undefined;

  // 长期记忆：从 data/memory.json 加载；未启用时为 undefined，回复时不带记忆。
  let memory: MemoryStore | undefined;
  if (config.memory.enabled) {
    memory = new MemoryStore(config.memory.file, completeJson);
    await memory.load();
  }

  // 管理员 /启动、/停止 的开关，状态持久化在 state.json。
  const power = new PowerSwitch(config.bot.stateFile);
  await power.load();

  // 打印一次装配结果，方便从日志确认哪些能力处于开启状态。
  const groups = [...config.bot.groups].join(",") || "（无）";
  const privateUsers = [...config.bot.privateUsers].join(",") || "（无）";
  logger.info(
    `bot=${config.bot.name} model=${DEEPSEEK_MODEL} proxy=${proxyOn ? config.proxy.url : "off"} jev=${judge ? config.jev.model : "off"} search=${search ? "on" : "off"} stickers=${stickers ? stickers.size : "off"} memory=${memory ? memory.size : "off"} groups=${groups} private=${privateUsers} admins=${[...config.bot.adminUsers].join(",") || "（无）"} power=${power.on ? "on" : "off"}`,
  );

  // runtime/moderation 先声明再赋值：构造 client 时的事件回调闭包会引用它们。
  let runtime: ChatRuntime | undefined;
  let moderation: Moderation | undefined;
  const client = new NapcatClient((event) => {
    // 非消息事件（心跳、通知等）不处理。
    if (!isMessageEvent(event)) return;
    // 同一条消息既进聊天流程也进群管理流程，两者互不影响。
    runtime?.handle(event);
    moderation?.handle(event);
  });
  runtime = new ChatRuntime({ client, judge, search, stickers, images, memory, power });
  // 群管理依赖 jev；启用了却没有 jev 时明确告警，而不是静默失效。
  if (config.moderation.enabled) {
    if (judge) moderation = new Moderation({ client, judge, power });
    else logger.warn("启用了群管理（MODERATION_ENABLED）但没有 jev，群管理不生效");
  }
  client.connect();

  // 优雅退出：先把表情包与记忆落盘（失败也继续），再断开连接退出。
  const shutdown = async () => {
    logger.info("退出中…");
    await stickers?.flush().catch(() => undefined);
    await memory?.flush().catch(() => undefined);
    await client.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

// 启动入口。
void main();
