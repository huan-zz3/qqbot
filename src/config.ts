/**
 * config.ts —— 环境变量读取（含 BOT_PERSONA_FILE 指向的人设文件），导出全项目唯一的配置常量 config
 *
 * 重要约束（坑）：
 * - 本模块在 **import 时** 就把 process.env 读进常量（含 dotenv.config()），
 *   之后再改环境变量不会影响 config。测试要先设置 process.env，再用动态
 *   import 引入被测模块（见 tests/gate.test.ts）。
 * - `node --test` 会给测试子进程置位 NODE_TEST_CONTEXT：此时故意不加载本地
 *   .env，避免测试读到开发者机器上的真实配置。
 * - dotenv 默认不覆盖已存在的环境变量。
 * - BOT_PERSONA_FILE（可空）指向的行为准则文件也在 import 时读取，相对路径相对
 *   进程启动目录；读不到直接抛错终止启动，绝不静默回退。人设分两层：BOT_PERSONA
 *   是内联身份，文件是行为准则；config.bot.persona 是二者合并值，仅 decider 用。
 *
 * 每个配置项对应一个环境变量（命名与 .env.example/README 一致），经 str/num/
 * bool/list/idSet/textFile 读取并给出默认值；默认值即「什么都不配」时的保守配置。
 */
import { readFileSync } from "node:fs";
import dotenv from "dotenv";

// node --test 会给子进程置位 NODE_TEST_CONTEXT；此时跳过 .env，
// 免得测试捡到开发者本地的真实配置。
if (!process.env.NODE_TEST_CONTEXT) dotenv.config();

/** 读字符串：去首尾空白；未设置或为空则用 fallback。 */
function str(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

/** 读数字：解析结果非有限数（NaN/Infinity）按未设置处理，回退 fallback。 */
function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** 读布尔：接受 1/true/yes/on 与 0/false/no/off（大小写不敏感）；其余值回退 fallback。 */
function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

/** 读列表：按英文/中文逗号或空白切分，逐项去空白、丢弃空项。 */
function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 读 QQ 号集合：在 list 基础上转数字，只保留安全正整数（挡住错值/0/负数）。 */
function idSet(name: string): Set<number> {
  return new Set(list(name).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0));
}

/**
 * 读「定时执行命令」任务：扫描 process.env 里形如 EXEC_<n>_CRON / EXEC_<n>_SHELL 的键，
 * 收集去重后的编号并按升序组装成任务数组（允许跳号）。
 * 空值原样保留（trim 后为空串），交由 index.ts 逐项校验，绝不在此静默丢弃。
 */
function execJobs(): { index: number; cron: string; shell: string }[] {
  const indices = new Set<number>();
  for (const key of Object.keys(process.env)) {
    const match = /^EXEC_(\d+)_(?:CRON|SHELL)$/.exec(key);
    if (match) indices.add(Number(match[1]));
  }
  return [...indices].sort((a, b) => a - b).map((index) => ({
    index,
    cron: str(`EXEC_${index}_CRON`),
    shell: str(`EXEC_${index}_SHELL`),
  }));
}

/**
 * 读文本文件（UTF-8）并去掉首尾空白。path 为空返回空串；
 * 读取失败直接抛错终止启动（绝不静默回退），错误信息带上变量名与原始路径以便排查。
 */
function textFile(path: string, source: string): string {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    throw new Error(`读取 ${source} 指向的文件失败：${path}（${(error as Error).message}）`);
  }
}

// 内联身份（BOT_PERSONA，可空）：回复提示词「你是「名字」，…」里的身份描述。
const personaIdentity = str("BOT_PERSONA");

// 追加式行为准则文件路径（可空，支持相对进程启动目录）；读不到即启动失败，绝不静默回退。
const personaFile = str("BOT_PERSONA_FILE");

// 行为准则：BOT_PERSONA_FILE 的内容（可空）。
const personaRules = textFile(personaFile, "BOT_PERSONA_FILE");

// OPENCODE_PROMPT 未配置时给模型的 opencode 工具说明；只交代事实，不诱导使用。
const DEFAULT_OPENCODE_PROMPT =
  "你可以用 opencode 工具在某个代码仓库里检索、阅读代码并回答相关问题；它只能读，不能修改任何文件。";

// FILES_PROMPT 未配置时给模型的压缩包处理说明；执行逻辑可用 .env 覆盖。
const DEFAULT_FILES_PROMPT =
  "聊天记录里的 [文件：…] 是群友发来的压缩包。系统会尝试在本地解压它：成功时清单会给出目录与文件；无法解压或读取失败时，清单里会写明原因，请把原因如实告诉发文件的群友。图片、音视频、Office 文档等其他类型无法读取，可让对方打包成 zip 或 rar 再发。";

// FILES_READ_PROMPT 未配置时，给模型「怎么读解压目录」的说明（仅在挂了 opencode 工具时追加）。
const DEFAULT_FILES_READ_PROMPT = "需要查看压缩包里的内容时，可调用 opencode 读取清单里给出的解压目录。";

// OPENCODE_ARGS 未配置时，默认以 `acp` 子命令启动（JSON-RPC over stdio 的 agent）。
const opencodeArgs = list("OPENCODE_ARGS");

export const config = {
  // 日志级别：debug/info/warn/error/silent。
  logLevel: str("LOG_LEVEL", "info"),
  // 调试辅助：把实际送给 decider / 回复模型的请求体落盘成 JSON，便于核对提示词。
  debug: {
    // 落盘目录：非空则开启（每次请求一个文件），留空关闭。放 data/ 下可被 .gitignore 忽略。
    promptDumpDir: str("PROMPT_DUMP_DIR"),
  },
  // 网络代理：非空则所有 HTTP 出网走该 HTTP 代理，留空则直连。
  proxy: {
    url: str("PROXY_URL"),
  },
  // NapCat 正向 WS 连接（NapCat 是服务端）与各种超时/节流。
  napcat: {
    url: str("NAPCAT_WS_URL", "ws://127.0.0.1:3001"),
    token: str("NAPCAT_TOKEN"),
    reconnectMs: num("NAPCAT_RECONNECT_MS", 3000),
    heartbeatTimeoutMs: num("NAPCAT_HEARTBEAT_TIMEOUT_MS", 30000),
    actionTimeoutMs: num("NAPCAT_ACTION_TIMEOUT_MS", 15000),
    sendIntervalMs: num("NAPCAT_SEND_INTERVAL_MS", 800),
  },
  // 机器人身份、白名单与状态文件。
  bot: {
    name: str("BOT_NAME", "小猫"),
    // 群友对它的其他称呼（被叫到时 decider 能看到）。
    aliases: list("BOT_ALIASES"),
    // 人设身份：回复提示词里的「你是「名字」，…」部分；留空则只有名字。
    personaIdentity,
    // 行为准则：BOT_PERSONA_FILE 的内容，作为回复提示词的独立段落；留空则没有。
    personaRules,
    // 给 decider 的完整人设（身份 + 准则合并），语义与拆分前一致。
    persona: [personaIdentity, personaRules].filter(Boolean).join("\n"),
    // BOT_PERSONA_FILE 的原始路径（可空）；仅用于启动日志展示。
    personaFile,
    // 发言白名单：空集合 = 不在群里 / 私聊里说话。
    groups: idSet("BOT_GROUPS"),
    privateUsers: idSet("BOT_PRIVATE_USERS"),
    // 可以在私聊里发 /启动、/停止。
    adminUsers: idSet("BOT_ADMIN_USERS"),
    // /启动 /停止 状态的持久化位置。
    stateFile: str("BOT_STATE_FILE", "data/state.json"),
  },
  // decider 发言判定：各场景阈值、防抖窗口与「存在感」统计窗口。
  gate: {
    // 群聊发言阈值；调低更活跃。
    groupThreshold: num("GATE_GROUP_THRESHOLD", 0.6),
    // 私聊发言阈值。
    privateThreshold: num("GATE_PRIVATE_THRESHOLD", 0.35),
    // 被 @ 或被回复会降低门槛，但低于此分数的基本不是在跟 bot 说话。
    directThreshold: num("GATE_DIRECT_THRESHOLD", 0.45),
    // 名单里的 QQ 被 @ 或被回复时视同 bot 自己，也走 directThreshold（防抖同样按 direct 处理）。
    directUsers: idSet("GATE_DIRECT_USERS"),
    // 等消息停下多久再判断（私聊/直呼场景更短）。
    groupDebounceMs: num("GATE_GROUP_DEBOUNCE_MS", 3000),
    privateDebounceMs: num("GATE_PRIVATE_DEBOUNCE_MS", 1500),
    directDebounceMs: num("GATE_DIRECT_DEBOUNCE_MS", 800),
    // 防抖的最长等待：消息一直不停也不能无限等。
    maxWaitMs: num("GATE_MAX_WAIT_MS", 10000),
    // bot 最近发言次数/间隔的统计窗口，供 decider 权衡别刷屏。
    presenceWindowMs: num("GATE_PRESENCE_WINDOW_MS", 5 * 60 * 1000),
    // decider 的 needs_search 分数高于它就给模型挂上联网搜索工具。
    searchThreshold: num("GATE_SEARCH_THRESHOLD", 0.1),
    // 自定义「什么情况下该回复」提示词：分别**追加**到 decider should_reply 问题的正文、true/false
    // 判定标准之后；留空即不追加（保持内置文案）。
    replyPrompt: {
      // 追加到问题正文（instructions；注意不是 decider 的 state 对象）之后。
      question: str("GATE_REPLY_QUESTION_PROMPT"),
      // 追加到「该回复」判定标准之后。
      true: str("GATE_REPLY_TRUE_PROMPT"),
      // 追加到「不该回复」判定标准之后。
      false: str("GATE_REPLY_FALSE_PROMPT"),
    },
    // 累计强制回复：指定群内各自累计自上次发言/上次强制以来的群消息，达到条数后下一次判断强制回复一次
    // （绕过 should_reply 阈值，但搜索建议照常来自 decider）。关闭时不计数、不强制。
    // 启用时 GROUPS 必须非空、都在 BOT_GROUPS 内，且 MESSAGES 为正，否则启动即报错退出（见 index.ts）。
    forceReply: {
      enabled: bool("GATE_FORCE_REPLY_ENABLED", false),
      // 生效的群号（逗号/空白分隔），各群独立计数与清零。
      groups: idSet("GATE_FORCE_REPLY_GROUPS"),
      // 触发条数：累计这么多条群消息就强制回复一次。
      messages: num("GATE_FORCE_REPLY_MESSAGES", 20),
    },
  },
  // 通用 decider 判定服务：决定该不该发言、要不要挂联网搜索（端点/密钥/模型全部来自 .env，代码无 provider 默认值）。
  decider: {
    // 判定端点完整 URL；空则未配置。多密钥共用同一端点与模型。
    apiUrl: str("DECIDER_API_URL"),
    // 判定服务密钥；可配多个（逗号/空白分隔，顺序即优先级），空数组即未配置。
    // 每次判定按优先级尝试，失败换下一个、成功提升为最高优先级（见 decider/client.ts）。
    apiKeys: list("DECIDER_API_KEY"),
    // 判定模型名；空则未配置。
    model: str("DECIDER_MODEL"),
    timeoutMs: num("DECIDER_TIMEOUT_MS", 5000),
  },
  // 回复模型（固定 deepseek-flash）。
  deepseek: {
    apiKey: str("DEEPSEEK_API_KEY"),
    baseUrl: str("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    // deepseek-flash 的思考模式。
    thinking: bool("DEEPSEEK_THINKING", false),
    timeoutMs: num("DEEPSEEK_TIMEOUT_MS", 60000),
    maxTokens: num("DEEPSEEK_MAX_TOKENS", 800),
    // 只用于生成回复；试过 1.3，会冒出奇怪的外文标点和单词。
    temperature: num("DEEPSEEK_TEMPERATURE", 1.1),
  },
  // 图像识别（视觉理解）：与回复模型分开的独立后端，模型与端点写死在 src/llm/vision.ts。
  // 仅当 IMAGES_ENABLED 或 STICKERS_ENABLED 开启时才要求 VISION_API_KEY（校验见 index.ts）。
  vision: {
    apiKey: str("VISION_API_KEY"),
    // 传给 SiliconFlow image_url 的细节级别：low / high / auto（非法值启动即报错）。
    detail: str("VISION_DETAIL", "high"),
    // 识图超时（毫秒）：须为正且小于 MEDIA_WAIT_MS（启动校验），否则识图会被等待上限提前截断。
    timeoutMs: num("VISION_TIMEOUT_MS", 30000),
    // 输出上限：描述最终嵌进单行聊天记录，收在 512 以压低最坏延迟。
    maxTokens: num("VISION_MAX_TOKENS", 512),
  },
  // 联网搜索：连一个远程 MCP 服务器，把它暴露的全部工具挂给模型（无常驻凭证）。
  search: {
    enabled: bool("SEARCH_MCP_ENABLED", true),
    url: str("SEARCH_MCP_URL", "https://openwebsearch.flow-serene.life/mcp"),
    // 连接与单次工具调用的超时。
    timeoutMs: num("SEARCH_MCP_TIMEOUT_MS", 30000),
    // 断连后重连：首次间隔，以及指数退避（×2）的封顶。
    reconnectMinMs: num("SEARCH_MCP_RECONNECT_MIN_MS", 5000),
    reconnectMaxMs: num("SEARCH_MCP_RECONNECT_MAX_MS", 60000),
    // 联网搜索组的工具轮数上限；与 opencode 组各自独立计数。
    maxToolRounds: num("SEARCH_MAX_TOOL_ROUNDS", 3),
  },
  // 基础能力：让模型在固定仓库里只读地调用 OpenCode（ACP，见 src/opencode/agent.ts）。
  // 需要机器上已安装 opencode 并完成 `opencode auth login`；权限请求一律拒绝，因此只能读不能改。
  opencode: {
    enabled: bool("OPENCODE_ENABLED", false),
    command: str("OPENCODE_COMMAND", "opencode"),
    // 启动参数；未配置时默认 ["acp"]。
    args: opencodeArgs.length > 0 ? opencodeArgs : ["acp"],
    // 提示词里给模型的 opencode 说明，用来框定「什么情况下该调用」；留空则用默认事实说明。
    prompt: str("OPENCODE_PROMPT", DEFAULT_OPENCODE_PROMPT),
    // 给 ACP 会话指定的模型（provider/model，如 deepseek/deepseek-flash）；留空则用 opencode 自己的默认。
    // 注意：`opencode acp` 没有 --model，也无视命令行模型的指定，必须经 ACP 的 model 配置项设置。
    model: str("OPENCODE_MODEL"),
    // opencode 开始执行（模型调用该工具）时先发的一条提示文本；留空则不发，行为与未启用时一致。
    notice: str("OPENCODE_NOTICE_TEXT"),
    // 拼进送进 `opencode acp` 的 prompt 的自定义文本：前置拼在任务前、后置拼在任务后，各留空则不拼
    // （见 opencode/prompt.ts）。注意与 OPENCODE_PROMPT（给回复模型看的工具说明）不是一回事。
    inputPrefix: str("OPENCODE_INPUT_PREFIX"),
    inputSuffix: str("OPENCODE_INPUT_SUFFIX"),
    // 主仓库的绝对路径；短名固定为 "default"。与 dirsRaw 至少一个非空（启用时否则启动失败）。
    cwd: str("OPENCODE_CWD"),
    // 追加仓库列表，每项 `短名=绝对路径`，按逗号/空白切分（路径不能含空格/逗号）。
    // 原始值原样带出，解析与校验交给 src/opencode/dirs.ts，不在此静默丢弃。
    dirsRaw: str("OPENCODE_DIRS"),
    // 单次任务的总超时；超时会取消任务并杀掉子进程。
    timeoutMs: num("OPENCODE_TIMEOUT_MS", 180000),
    // prompt 阶段允许的「无 session/update」静默时长；过久即判定 opencode 卡死并取消。
    // 必须为正且小于 timeoutMs（否则启动即报错，避免静默失效）。
    idleTimeoutMs: num("OPENCODE_IDLE_TIMEOUT_MS", 60000),
    // 容忍的模型重试次数；opencode 经 _meta["opencode/retry"] 上报的活跃 attempt 超过它即提前取消。
    // 必须为正（否则启动即报错）。
    retryMax: num("OPENCODE_RETRY_MAX", 2),
    // 返回文本的截断上限，避免把超长输出整段塞给模型。
    maxOutputChars: num("OPENCODE_MAX_OUTPUT_CHARS", 4000),
    // 全局同时运行的任务数上限；同一会话始终串行，不受此值影响。必须为正整数（否则启动失败）。
    maxConcurrency: num("OPENCODE_MAX_CONCURRENCY", 3),
    // opencode 组的工具轮数上限；与联网搜索组各自独立计数。
    maxToolRounds: num("OPENCODE_MAX_TOOL_ROUNDS", 3),
  },
  // 表情包收藏与识图描述。
  stickers: {
    // 总开关：关掉则整个表情包功能停用（不建库、不展示、不发送）。
    enabled: bool("STICKERS_ENABLED", true),
    // 识别/收藏开关：总开关开启时，决定是否下载+识图新表情并入库（含把归档表情提升回活跃）。
    // 关掉后只读现有库：老表情照常展示与发送，新表情不下载、不识图，活跃集合冻结。
    recognize: bool("STICKERS_RECOGNIZE_ENABLED", true),
    dir: str("STICKERS_DIR", "data/stickers"),
    // 收藏上限，满了淘汰最少用的。
    max: num("STICKERS_MAX", 300),
    // 淘汰后保留描述的归档上限，满了淘汰最旧的（归档无文件，可远大于收藏上限）。
    archiveMax: num("STICKERS_ARCHIVE_MAX", 2000),
    // 随提示词给模型的候选表情数量（打乱顺序，避免越用越偏向某几张）。
    promptLimit: num("STICKERS_PROMPT_LIMIT", 40),
  },
  // 聊天里发来的压缩包：收到后下载解压到本地目录，把「目录 + 文件清单」交给回复模型
  // （模型可让 opencode 去读）。只认 .zip/.rar；松散文本文件不再支持，请群友自行打包。
  // 物料化与 OPENCODE_ENABLED 解耦：由 FILES_MATERIALIZE 单独控制。
  // 启用且配了物料化时，各上限必须为正，否则启动即报错退出（见 index.ts）。
  files: {
    enabled: bool("FILES_ENABLED", true),
    // 是否在回复批构建时下载解压压缩包（独立于 opencode 是否启用）。
    materialize: bool("FILES_MATERIALIZE", true),
    // 解压根目录（data/ 已被 .gitignore 忽略）。
    dir: str("FILES_DIR", "data/uploads"),
    // 单个压缩包下载上限（字节），流式边读边限。
    maxBytes: num("FILES_MAX_BYTES", 50 * 1024 * 1024),
    // 单批最多处理（下载解压）几个压缩包（按新→旧选取）。
    maxFiles: num("FILES_MAX_FILES", 3),
    // 单包解压后总字节上限。
    extractMaxBytes: num("FILES_EXTRACT_MAX_BYTES", 200 * 1024 * 1024),
    // 单包条目数上限（含目录）。
    extractMaxEntries: num("FILES_EXTRACT_MAX_ENTRIES", 1000),
    // 单个文件解压后字节上限。
    extractMaxFileBytes: num("FILES_EXTRACT_MAX_FILE_BYTES", 50 * 1024 * 1024),
    // 解压目录保留时长（毫秒）。
    keepMs: num("FILES_KEEP_MS", 24 * 60 * 60 * 1000),
    // 解压目录磁盘总预算（字节），超出按最旧优先清理。
    storeMaxBytes: num("FILES_STORE_MAX_BYTES", 1024 * 1024 * 1024),
    // 清理扫描间隔（毫秒）。
    sweepMs: num("FILES_SWEEP_MS", 60 * 60 * 1000),
    // 单个压缩包下载超时（毫秒）。
    timeoutMs: num("FILES_TIMEOUT_MS", 120000),
    // 给模型的压缩包处理说明（何时算成功/失败、失败要如实转告等执行逻辑）；留空用内置默认。
    prompt: str("FILES_PROMPT", DEFAULT_FILES_PROMPT),
    // 仅在挂了 opencode 工具时追加的「怎么读解压目录」说明；留空用内置默认。
    readPrompt: str("FILES_READ_PROMPT", DEFAULT_FILES_READ_PROMPT),
  },
  // 普通图片识图（不保存图片，只缓存描述）。
  images: {
    enabled: bool("IMAGES_ENABLED", true),
    // 超过这个大小的图片不下载。
    maxBytes: num("IMAGES_MAX_BYTES", 8 * 1024 * 1024),
  },
  // 长期记忆（按 QQ 号，群/私聊分开）。学习只发生在 bot 实际回复后，范围为该次回复的触发批。
  memory: {
    enabled: bool("MEMORY_ENABLED", true),
    file: str("MEMORY_FILE", "data/memory.json"),
    // 回复后等这么久再整理记忆，让一次对话尾巴上的连续回复合并为一次。
    learnDelayMs: num("MEMORY_LEARN_DELAY_MS", 10000),
    // 每人最多保留的记忆条数。
    maxFacts: num("MEMORY_MAX_FACTS", 20),
  },
  // 会话内存里的消息记录。
  history: {
    maxMessages: num("HISTORY_MAX_MESSAGES", 80),
    // 给模型看的共享最近消息条数（所有人共用）；bot 自己的多行回复占多条记录，要留够才能看懂上下文。
    contextMessages: num("HISTORY_CONTEXT_MESSAGES", 40),
    // 本批每个发言群友各自额外保证纳入的最近消息条数（叠加在共享窗口之上，让刷屏者的内容更完整）。
    userContextMessages: num("HISTORY_USER_CONTEXT_MESSAGES", 20),
    // 给 decider 看的共享最近消息条数（所有人共用）；与模型窗口分开配置。
    deciderContextMessages: num("DECIDER_CONTEXT_MESSAGES", 40),
    // decider 窗口对本批每个发言群友各自额外保证纳入的最近消息条数；默认 0（与未拆分前一致）。
    deciderUserContextMessages: num("DECIDER_USER_CONTEXT_MESSAGES", 0),
  },
  // 回复发送方式（分条 / 合并转发）。
  reply: {
    // 回复超过这么多行（或这么多字）就改发一条合并转发，而不是连发多条刷屏。
    forwardParts: num("REPLY_FORWARD_PARTS", 5),
    forwardChars: num("REPLY_FORWARD_CHARS", 300),
    // 只是防止输出失控的安全上限；长度本身由提示词交给模型把握。
    maxChars: num("REPLY_MAX_CHARS", 1500),
    maxParts: num("REPLY_MAX_PARTS", 40),
  },
  // 群管理：decider 三问（撤回/禁言/回复），各自独立触发；某项提示词留空即不启用该项。
  moderation: {
    enabled: bool("MODERATION_ENABLED", false),
    groups: idSet("MODERATION_GROUPS"),
    // 群管理命中后是否跳过同一批消息的 AI 回复阶段；默认开启。
    skipReply: bool("MODERATION_SKIP_REPLY", true),
    // 判断一条消息时附带多少条前置群消息当上下文。
    contextMessages: num("MODERATION_CONTEXT_MESSAGES", 5),
    // 回复：达到阈值就 @ 对方发固定文本。
    reply: {
      prompt: str("MODERATION_REPLY_PROMPT"),
      threshold: num("MODERATION_REPLY_THRESHOLD", 0.8),
      text: str("MODERATION_REPLY_TEXT"),
    },
    // 撤回：先删消息，再 @ 对方发固定文本（撤回失败则不谎报，不发文本）。
    recall: {
      prompt: str("MODERATION_RECALL_PROMPT"),
      threshold: num("MODERATION_RECALL_THRESHOLD", 0.85),
      text: str("MODERATION_RECALL_TEXT"),
    },
    // 禁言：先禁言 seconds 秒，再 @ 对方发固定文本。
    ban: {
      prompt: str("MODERATION_BAN_PROMPT"),
      threshold: num("MODERATION_BAN_THRESHOLD", 0.9),
      text: str("MODERATION_BAN_TEXT"),
      seconds: num("MODERATION_BAN_SECONDS", 600),
    },
  },
  // 定时群发：按一条 cron（时区固定 Asia/Shanghai）在到点时向指定群各发一条固定文本；
  // 受 /启动 /停止 电源开关约束。配置非法时启动即报错退出（见 index.ts）。
  schedule: {
    enabled: bool("SCHEDULE_ENABLED", false),
    // cron 表达式，如 "0 8 * * *"（每天 08:00，Asia/Shanghai）。
    cron: str("SCHEDULE_CRON"),
    // 目标群号，逗号分隔。
    groups: idSet("SCHEDULE_GROUPS"),
    // 固定文本（纯文本，只有一条）。
    text: str("SCHEDULE_TEXT"),
  },
  // 入群欢迎：新成员入群时 @ 其发送一条固定文本（群范围独立于群管理）。
  // 独立旁路：不走 decider，也不写会话历史/长期记忆；受 /启动 /停止 约束。
  welcome: {
    enabled: bool("WELCOME_ENABLED", false),
    // 生效的群号，逗号分隔；与 MODERATION_GROUPS 无关。
    groups: idSet("WELCOME_GROUPS"),
    // 入群欢迎固定文本。
    text: str("WELCOME_TEXT"),
  },
  // 定时执行本地 shell 命令（多条）：每条自带 cron（时区固定 Asia/Shanghai），到点在本机执行，只写日志。
  // 独立旁路：不发消息、不进聊天历史/记忆，也不受 /启动 /停止 约束。配置非法时启动即报错退出（见 index.ts）。
  exec: {
    enabled: bool("EXEC_ENABLED", false),
    // 扫描 EXEC_<n>_CRON / EXEC_<n>_SHELL，按编号升序；允许跳号。
    jobs: execJobs(),
    // 单条命令执行超时；超时终止子进程。
    timeoutMs: num("EXEC_TIMEOUT_MS", 60000),
    // 日志里每条命令 stdout/stderr 的截断上限（字符）。
    maxOutputChars: num("EXEC_MAX_OUTPUT_CHARS", 2000),
  },
};

/** 整个配置对象的类型；需要传递配置引用时用它。 */
export type Config = typeof config;
