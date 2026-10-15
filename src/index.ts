/**
 * index.ts —— 进程入口：装配依赖、接线事件、处理退出
 *
 * 流程：校验必需配置（缺 DeepSeek key 直接退出）→ 按配置创建各组件（decider 判定、
 * MCP 搜索、只读 OpenCode、表情包、图片识图、记忆、电源开关）→ 建 WS 客户端，把消息事件
 * 分发给聊天运行时与群管理 → 注册 SIGINT/SIGTERM 优雅退出（先落盘再断开）。
 *
 * 组件按需创建：配置关闭或初始化失败时对应依赖为 undefined，各模块自行降级
 * （例如无 decider 时 gate 走兜底判定、搜索不可用时不给模型挂搜索工具）。
 */
import { config } from "./config.js";
import { ChatRuntime, MEDIA_WAIT_MS } from "./chat/runtime.js";
import { extractRar } from "./chat/extract-rar.js";
import { extractZip } from "./chat/extract-zip.js";
import { FileStore, type CallAction } from "./chat/files.js";
import { ImageDescriber, describeImageWith } from "./chat/images.js";
import { Materials } from "./chat/materials.js";
import { MemoryStore } from "./chat/memory.js";
import { PowerSwitch } from "./chat/power.js";
import { StickerStore, describeSticker } from "./chat/stickers.js";
import { createDecider } from "./decider/client.js";
import { CronExecutor } from "./exec/cron-exec.js";
import { DEEPSEEK_MODEL, completeJson } from "./llm/deepseek.js";
import { VISION_MODEL, describeImage } from "./llm/vision.js";
import { logger } from "./logger.js";
import { ModerationHandoff } from "./moderation/handoff.js";
import { Moderation } from "./moderation/moderation.js";
import { NapcatClient } from "./napcat/client.js";
import { isGroupIncreaseEvent, isMessageEvent } from "./napcat/types.js";
import { OpenCodeAgent } from "./opencode/agent.js";
import { parseDirs, type DirEntry } from "./opencode/dirs.js";
import { installProxy } from "./proxy.js";
import { ScheduledMessenger } from "./schedule/scheduler.js";
import { McpSearch } from "./search/mcp-search.js";
import { Welcome } from "./welcome/welcome.js";

async function main(): Promise<void> {
  // 最早安装代理：让后续所有 fetch（含 decider）都走 PROXY_URL；留空则直连。
  const proxyOn = installProxy(config.proxy.url);

  // 没有 DeepSeek key 无法回话，直接以非零码退出。
  if (!config.deepseek.apiKey) {
    logger.error("缺少 DEEPSEEK_API_KEY");
    process.exit(1);
  }

  // 图像识别：只要开启任一识图功能（图片 / 表情包识别），就必须配好独立的识图后端，否则启动即退出，
  // 绝不静默失效（否则会表现为「图片一直没描述」却查不出原因）。都不需要识图时（表情包识别关闭、图片关闭）无需 key。
  const visionNeeded = config.images.enabled || (config.stickers.enabled && config.stickers.recognize);
  if (visionNeeded) {
    if (!config.vision.apiKey) {
      logger.error("IMAGES_ENABLED、或 STICKERS_ENABLED 且 STICKERS_RECOGNIZE_ENABLED 已开启，但缺少 VISION_API_KEY");
      process.exit(1);
    }
    if (!["low", "high", "auto"].includes(config.vision.detail)) {
      logger.error(`VISION_DETAIL 只能是 low/high/auto（当前 ${config.vision.detail}）`);
      process.exit(1);
    }
    if (!(config.vision.timeoutMs > 0) || !(config.vision.maxTokens > 0)) {
      logger.error(
        `VISION_TIMEOUT_MS 与 VISION_MAX_TOKENS 必须为正数（当前 ${config.vision.timeoutMs} / ${config.vision.maxTokens}）`,
      );
      process.exit(1);
    }
    // 识图超时必须小于媒体补全等待上限，否则批次会先因 MEDIA_WAIT_MS 到点而放弃识图，永远等不到描述。
    if (config.vision.timeoutMs >= MEDIA_WAIT_MS) {
      logger.error(
        `VISION_TIMEOUT_MS（当前 ${config.vision.timeoutMs}）必须小于媒体补全等待上限 ${MEDIA_WAIT_MS}，否则识图会被提前截断`,
      );
      process.exit(1);
    }
  }

  // decider 是可选组件：apiUrl/apiKey/model 三项都配齐才创建，否则为 undefined，后续 gate 走无 decider 的兜底路径。
  // 缺哪项就在告警里点名，绝不静默停用。
  const missingDecider = [
    !config.decider.apiUrl && "DECIDER_API_URL",
    config.decider.apiKeys.length === 0 && "DECIDER_API_KEY",
    !config.decider.model && "DECIDER_MODEL",
  ]
    .filter(Boolean)
    .join("/");
  const decider = missingDecider ? undefined : createDecider();
  if (missingDecider) logger.warn(`未配置 ${missingDecider}：decider 不可用，只在私聊、@、回复、点名时发言`);

  // 联网搜索：启动时连一次远程 MCP 服务器并拉取工具清单；失败只告警不阻止启动，搜索停用。
  let search: McpSearch | undefined;
  if (config.search.enabled) {
    search = new McpSearch({
      url: config.search.url,
      timeoutMs: config.search.timeoutMs,
      reconnectMinMs: config.search.reconnectMinMs,
      reconnectMaxMs: config.search.reconnectMaxMs,
    });
    await search.connect().catch((error: Error) => logger.warn(`联网搜索不可用：${error.message}`));
  }

  // 只读 OpenCode（ACP）：显式启用但目录配置不合法时直接退出，绝不静默不挂工具。
  let opencode: OpenCodeAgent | undefined;
  if (config.opencode.enabled) {
    let dirs: DirEntry[];
    try {
      dirs = parseDirs(config.opencode.cwd, config.opencode.dirsRaw);
    } catch (error) {
      logger.error(`OPENCODE_ENABLED=true 但目录配置不合法：${(error as Error).message}`);
      process.exit(1);
    }
    if (dirs.length === 0) {
      logger.error("OPENCODE_ENABLED=true 但未配置任何目录（OPENCODE_CWD / OPENCODE_DIRS 均为空）");
      process.exit(1);
    }
    // 超时策略必须自洽：空闲超时要为正且短于总超时，否则它永不触发（配置无效）。
    if (config.opencode.idleTimeoutMs <= 0 || config.opencode.idleTimeoutMs >= config.opencode.timeoutMs) {
      logger.error(
        `OPENCODE_IDLE_TIMEOUT_MS 必须为正且小于 OPENCODE_TIMEOUT_MS（当前 ${config.opencode.idleTimeoutMs} / ${config.opencode.timeoutMs}）`,
      );
      process.exit(1);
    }
    if (config.opencode.retryMax < 1) {
      logger.error(`OPENCODE_RETRY_MAX 必须为正（当前 ${config.opencode.retryMax}）`);
      process.exit(1);
    }
    // 全局并发上限必须是正整数（会话内串行不受它影响），否则调度器无法工作。
    if (!Number.isInteger(config.opencode.maxConcurrency) || config.opencode.maxConcurrency < 1) {
      logger.error(`OPENCODE_MAX_CONCURRENCY 必须为正整数（当前 ${config.opencode.maxConcurrency}）`);
      process.exit(1);
    }
    opencode = new OpenCodeAgent({
      command: config.opencode.command,
      args: config.opencode.args,
      dirs,
      timeoutMs: config.opencode.timeoutMs,
      idleTimeoutMs: config.opencode.idleTimeoutMs,
      retryMax: config.opencode.retryMax,
      maxOutputChars: config.opencode.maxOutputChars,
      maxConcurrency: config.opencode.maxConcurrency,
      model: config.opencode.model,
      inputPrefix: config.opencode.inputPrefix,
      inputSuffix: config.opencode.inputSuffix,
    });
  }

  // 压缩包物料化：启用且配了物料化时，各上限必须为正、目录非空，否则启动即报错退出（不静默失效）。
  if (config.files.enabled && config.files.materialize) {
    if (!config.files.dir) {
      logger.error("FILES_MATERIALIZE=true 但 FILES_DIR 为空");
      process.exit(1);
    }
    const settings: [string, number][] = [
      ["FILES_MAX_BYTES", config.files.maxBytes],
      ["FILES_MAX_FILES", config.files.maxFiles],
      ["FILES_EXTRACT_MAX_BYTES", config.files.extractMaxBytes],
      ["FILES_EXTRACT_MAX_ENTRIES", config.files.extractMaxEntries],
      ["FILES_EXTRACT_MAX_FILE_BYTES", config.files.extractMaxFileBytes],
      ["FILES_KEEP_MS", config.files.keepMs],
      ["FILES_STORE_MAX_BYTES", config.files.storeMaxBytes],
      ["FILES_SWEEP_MS", config.files.sweepMs],
      ["FILES_TIMEOUT_MS", config.files.timeoutMs],
    ];
    const invalid = settings.filter(([, value]) => !(value > 0));
    if (invalid.length > 0) {
      logger.error(`FILES_MATERIALIZE=true 但以下配置必须为正数：${invalid.map(([name]) => name).join("、")}`);
      process.exit(1);
    }
  }

  // 表情包库：从磁盘加载已收藏的表情与描述（写描述用识图模型；识别开关关闭时只读，不写描述）。
  // 归档上限必须为正，否则归档裁剪逻辑会异常（不静默失效）。
  if (config.stickers.enabled && !(config.stickers.archiveMax > 0)) {
    logger.error(`STICKERS_ARCHIVE_MAX 必须为正数（当前 ${config.stickers.archiveMax}）`);
    process.exit(1);
  }
  let stickers: StickerStore | undefined;
  if (config.stickers.enabled) {
    stickers = new StickerStore(
      config.stickers.dir,
      describeSticker(describeImage),
      config.stickers.max,
      config.stickers.archiveMax,
      config.stickers.recognize,
    );
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

  // runtime/moderation 先声明再赋值：构造 client 时的事件回调闭包会引用它们。
  let runtime: ChatRuntime | undefined;
  let moderation: Moderation | undefined;
  // 入群欢迎同样先声明再赋值，供事件回调闭包引用。
  let welcome: Welcome | undefined;
  // 群管理命中后跳过 AI 回复的共享信号；未启用群管理、关了开关或没有 decider 时为 undefined。
  const handoff =
    decider && config.moderation.enabled && config.moderation.skipReply ? new ModerationHandoff() : undefined;
  const client = new NapcatClient((event) => {
    // 消息事件进聊天与群管理流程；入群通知交给入群欢迎；其余事件（心跳/生命周期等）忽略。
    if (isMessageEvent(event)) {
      // 同一条消息既进聊天流程也进群管理流程；群管理命中会通过 handoff 让聊天跳过该批回复。
      runtime?.handle(event);
      moderation?.handle(event);
      return;
    }
    if (isGroupIncreaseEvent(event)) welcome?.handle(event);
  });
  // 压缩包物料化：下载后端（FileStore）与解压驱动；FILES_ENABLED / FILES_MATERIALIZE 都开才创建。
  // 与 OPENCODE_ENABLED 解耦：即使没开 opencode，也按物料化开关独立决定是否下载解压。
  const callAction: CallAction = (action, params) => client.callAction(action, params);
  const downloader = config.files.enabled
    ? new FileStore(callAction, config.files.maxBytes, config.files.timeoutMs)
    : undefined;
  const materials =
    downloader && config.files.materialize
      ? new Materials(
          {
            dir: config.files.dir,
            maxBytes: config.files.maxBytes,
            limits: {
              maxBytes: config.files.extractMaxBytes,
              maxEntries: config.files.extractMaxEntries,
              maxFileBytes: config.files.extractMaxFileBytes,
            },
            keepMs: config.files.keepMs,
            storeMaxBytes: config.files.storeMaxBytes,
            sweepMs: config.files.sweepMs,
          },
          { download: (ref) => downloader.download(ref), drivers: { zip: extractZip, rar: extractRar } },
        )
      : undefined;
  materials?.start();
  runtime = new ChatRuntime({ client, decider, search, opencode, stickers, images, materials, memory, power, handoff });
  // 群管理依赖 decider；启用了却没有 decider 时明确告警，而不是静默失效。
  if (config.moderation.enabled) {
    if (decider) moderation = new Moderation({ client, decider, power, handoff });
    else logger.warn("启用了群管理（MODERATION_ENABLED）但没有 decider，群管理不生效");
  }

  // 定时群发：按 cron（固定 Asia/Shanghai）向指定群发一条固定文本；受 /启动 /停止 约束。
  // 启用时逐项校验，缺项或 cron 非法即报错退出，避免静默不发。
  let schedule: ScheduledMessenger | undefined;
  if (config.schedule.enabled) {
    if (!config.schedule.cron) {
      logger.error("SCHEDULE_ENABLED=true 但 SCHEDULE_CRON 为空");
      process.exit(1);
    }
    if (config.schedule.groups.size === 0) {
      logger.error("SCHEDULE_ENABLED=true 但 SCHEDULE_GROUPS 为空");
      process.exit(1);
    }
    if (!config.schedule.text) {
      logger.error("SCHEDULE_ENABLED=true 但 SCHEDULE_TEXT 为空");
      process.exit(1);
    }
    try {
      schedule = new ScheduledMessenger({
        client,
        power,
        groups: [...config.schedule.groups],
        cron: config.schedule.cron,
        text: config.schedule.text,
      });
    } catch (error) {
      // cron 表达式非法会在构造 CronJob 时抛出。
      logger.error(`SCHEDULE_CRON 不是合法的 cron 表达式：${config.schedule.cron}（${(error as Error).message}）`);
      process.exit(1);
    }
    schedule.start();
  }

  // 入群欢迎：独立旁路。启用时缺项即报错退出，避免「启用了却什么都不发」被无声忽略。
  if (config.welcome.enabled) {
    if (config.welcome.groups.size === 0) {
      logger.error("WELCOME_ENABLED=true 但 WELCOME_GROUPS 为空");
      process.exit(1);
    }
    if (!config.welcome.text) {
      logger.error("WELCOME_ENABLED=true 但 WELCOME_TEXT 为空");
      process.exit(1);
    }
    welcome = new Welcome({ client, power });
  }

  // 定时执行本地 shell 命令：启用时逐项校验，任务为空 / 成对变量缺一 / cron 非法即报错退出，避免静默不执行。
  let cronExec: CronExecutor | undefined;
  if (config.exec.enabled) {
    if (config.exec.jobs.length === 0) {
      logger.error("EXEC_ENABLED=true 但未配置任何 EXEC_<n>_CRON / EXEC_<n>_SHELL");
      process.exit(1);
    }
    for (const job of config.exec.jobs) {
      if (!job.cron) {
        logger.error(`EXEC_ENABLED=true 但 EXEC_${job.index}_CRON 为空`);
        process.exit(1);
      }
      if (!job.shell) {
        logger.error(`EXEC_ENABLED=true 但 EXEC_${job.index}_SHELL 为空`);
        process.exit(1);
      }
    }
    try {
      cronExec = new CronExecutor({
        jobs: config.exec.jobs,
        timeoutMs: config.exec.timeoutMs,
        maxOutputChars: config.exec.maxOutputChars,
      });
    } catch (error) {
      // cron 表达式非法会在构造时抛出（错误已点名 EXEC_<n>）。
      logger.error(`定时执行命令配置非法：${(error as Error).message}`);
      process.exit(1);
    }
    cronExec.start();
  }

  // 累计强制回复：启用时逐项校验，缺项或配错即报错退出，避免「开了却没生效」被无声忽略。
  if (config.gate.forceReply.enabled) {
    if (config.gate.forceReply.messages <= 0) {
      logger.error("GATE_FORCE_REPLY_ENABLED=true 但 GATE_FORCE_REPLY_MESSAGES 必须为正数");
      process.exit(1);
    }
    if (config.gate.forceReply.groups.size === 0) {
      logger.error("GATE_FORCE_REPLY_ENABLED=true 但 GATE_FORCE_REPLY_GROUPS 为空");
      process.exit(1);
    }
    // 生效群必须都在 BOT_GROUPS 内，否则机器人本就不参与该群，配了也不会生效。
    const outside = [...config.gate.forceReply.groups].filter((id) => !config.bot.groups.has(id));
    if (outside.length > 0) {
      logger.error(`GATE_FORCE_REPLY_GROUPS 含不在 BOT_GROUPS 内的群：${outside.join(",")}`);
      process.exit(1);
    }
  }

  // 上下文窗口不能超过会话保留环，否则会被静默裁掉、看起来「配了却没生效」。
  const historyWindows: [string, number][] = [
    ["HISTORY_CONTEXT_MESSAGES", config.history.contextMessages],
    ["DECIDER_CONTEXT_MESSAGES", config.history.deciderContextMessages],
    ["DECIDER_USER_CONTEXT_MESSAGES", config.history.deciderUserContextMessages],
    ["HISTORY_USER_CONTEXT_MESSAGES", config.history.userContextMessages],
  ];
  const overHistory = historyWindows.filter(([, size]) => size > config.history.maxMessages);
  if (overHistory.length > 0) {
    logger.error(
      `以下上下文窗口超过 HISTORY_MAX_MESSAGES=${config.history.maxMessages}，会被静默裁剪：${overHistory
        .map(([name, size]) => `${name}=${size}`)
        .join("、")}`,
    );
    process.exit(1);
  }

  // 打印一次装配结果，方便从日志确认哪些能力处于开启状态。
  const groups = [...config.bot.groups].join(",") || "（无）";
  const privateUsers = [...config.bot.privateUsers].join(",") || "（无）";
  // 已配置的回复判定追加提示词（只列位名，不打印内容）。
  const replyPrompt =
    [
      config.gate.replyPrompt.question && "question",
      config.gate.replyPrompt.true && "true",
      config.gate.replyPrompt.false && "false",
    ]
      .filter(Boolean)
      .join(",") || "off";
  // opencode 自定义输入文本的配置状态（pre/suf/off；只报位不打印内容）。
  const opencodeInput =
    [config.opencode.inputPrefix && "pre", config.opencode.inputSuffix && "suf"].filter(Boolean).join("+") || "off";
  logger.info(
    `bot=${config.bot.name} persona_file=${config.bot.personaFile || "off"} persona_inline=${config.bot.personaIdentity ? "on" : "off"} persona_rules=${config.bot.personaRules.length} model=${DEEPSEEK_MODEL} vision=${visionNeeded ? `${VISION_MODEL}/${config.vision.detail}/t${config.vision.timeoutMs}/mt${config.vision.maxTokens}/wait${MEDIA_WAIT_MS}` : "off"} proxy=${proxyOn ? config.proxy.url : "off"} decider=${decider ? `${config.decider.model}×${config.decider.apiKeys.length}` : "off"} search=${search?.usable() ? "on" : "off"} opencode=${opencode ? opencode.directories().map((dir) => `${dir.name}=${dir.path}`).join(",") : "off"} opencode_notice=${opencode && config.opencode.notice ? "on" : "off"} opencode_input=${opencode ? opencodeInput : "off"} opencode_concurrency=${opencode ? config.opencode.maxConcurrency : "off"} direct_users=${[...config.gate.directUsers].join(",") || "off"} reply_prompt=${replyPrompt} force_reply=${config.gate.forceReply.enabled ? `${[...config.gate.forceReply.groups].join(",")}@${config.gate.forceReply.messages}` : "off"} files=${materials ? `on(${config.files.dir},keep=${Math.round(config.files.keepMs / 3600000)}h)` : config.files.enabled ? "off(materialize)" : "off"} stickers=${stickers ? `${stickers.size}(archive=${stickers.archiveSize},recognize=${config.stickers.recognize ? "on" : "off"})` : "off"} memory=${memory ? memory.size : "off"} schedule=${schedule ? `${config.schedule.cron}@Asia/Shanghai` : "off"} exec=${cronExec ? `${config.exec.jobs.length}条` : "off"} welcome=${welcome ? [...config.welcome.groups].join(",") : "off"} groups=${groups} private=${privateUsers} admins=${[...config.bot.adminUsers].join(",") || "（无）"} power=${power.on ? "on" : "off"}`,
  );

  client.connect();

  // 优雅退出：先把表情包与记忆落盘（失败也继续），再断开连接退出。
  const shutdown = async () => {
    logger.info("退出中…");
    opencode?.dispose();
    materials?.dispose();
    schedule?.dispose();
    cronExec?.dispose();
    await search?.dispose().catch(() => undefined);
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
