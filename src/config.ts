/**
 * config.ts —— 环境变量读取，导出全项目唯一的配置常量 config
 *
 * 重要约束（坑）：
 * - 本模块在 **import 时** 就把 process.env 读进常量（含 dotenv.config()），
 *   之后再改环境变量不会影响 config。测试要先设置 process.env，再用动态
 *   import 引入被测模块（见 tests/gate.test.ts）。
 * - `node --test` 会给测试子进程置位 NODE_TEST_CONTEXT：此时故意不加载本地
 *   .env，避免测试读到开发者机器上的真实配置。
 * - dotenv 默认不覆盖已存在的环境变量。
 *
 * 每个配置项对应一个环境变量（命名与 .env.example/README 一致），经 str/num/
 * bool/list/idSet 读取并给出默认值；默认值即「什么都不配」时的保守配置。
 */
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

// BOT_PERSONA 未配置时的默认人设。
const DEFAULT_PERSONA = "是群里的一个 AI 群友。";

// OPENCODE_PROMPT 未配置时给模型的 opencode 工具说明；只交代事实，不诱导使用。
const DEFAULT_OPENCODE_PROMPT =
  "你可以用 opencode 工具在某个代码仓库里检索、阅读代码并回答相关问题；它只能读，不能修改任何文件。";

// OPENCODE_ARGS 未配置时，默认以 `acp` 子命令启动（JSON-RPC over stdio 的 agent）。
const opencodeArgs = list("OPENCODE_ARGS");

export const config = {
  // 日志级别：debug/info/warn/error/silent。
  logLevel: str("LOG_LEVEL", "info"),
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
    // 群友对它的其他称呼（被叫到时 jev 能看到）。
    aliases: list("BOT_ALIASES"),
    // 人设，接在提示词的「你是「名字」，」后面。
    persona: str("BOT_PERSONA", DEFAULT_PERSONA),
    // 发言白名单：空集合 = 不在群里 / 私聊里说话。
    groups: idSet("BOT_GROUPS"),
    privateUsers: idSet("BOT_PRIVATE_USERS"),
    // 可以在私聊里发 /启动、/停止。
    adminUsers: idSet("BOT_ADMIN_USERS"),
    // /启动 /停止 状态的持久化位置。
    stateFile: str("BOT_STATE_FILE", "data/state.json"),
  },
  // jev 发言判定：各场景阈值、防抖窗口与「存在感」统计窗口。
  gate: {
    // 群聊发言阈值；调低更活跃。
    groupThreshold: num("GATE_GROUP_THRESHOLD", 0.6),
    // 私聊发言阈值。
    privateThreshold: num("GATE_PRIVATE_THRESHOLD", 0.35),
    // 被 @ 或被回复会降低门槛，但低于此分数的基本不是在跟 bot 说话。
    directThreshold: num("GATE_DIRECT_THRESHOLD", 0.45),
    // 等消息停下多久再判断（私聊/直呼场景更短）。
    groupDebounceMs: num("GATE_GROUP_DEBOUNCE_MS", 3000),
    privateDebounceMs: num("GATE_PRIVATE_DEBOUNCE_MS", 1500),
    directDebounceMs: num("GATE_DIRECT_DEBOUNCE_MS", 800),
    // 防抖的最长等待：消息一直不停也不能无限等。
    maxWaitMs: num("GATE_MAX_WAIT_MS", 10000),
    // bot 最近发言次数/间隔的统计窗口，供 jev 权衡别刷屏。
    presenceWindowMs: num("GATE_PRESENCE_WINDOW_MS", 5 * 60 * 1000),
    // jev 的 needs_search 分数高于它就给模型挂上联网搜索工具。
    searchThreshold: num("GATE_SEARCH_THRESHOLD", 0.1),
  },
  // TypeSafe AI（jev）判定服务。
  jev: {
    apiKey: str("TYPESAFE_API_KEY"),
    model: str("JEV_MODEL", "jev-latest"),
    timeoutMs: num("JEV_TIMEOUT_MS", 5000),
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
    // 带工具时最多允许几轮工具调用。
    maxToolRounds: num("DEEPSEEK_MAX_TOOL_ROUNDS", 3),
  },
  // 联网搜索：连一个远程 MCP 服务器，把它暴露的全部工具挂给模型（无常驻凭证）。
  search: {
    enabled: bool("SEARCH_MCP_ENABLED", true),
    url: str("SEARCH_MCP_URL", "https://openwebsearch.flow-serene.life/mcp"),
    // 连接与单次工具调用的超时。
    timeoutMs: num("SEARCH_MCP_TIMEOUT_MS", 30000),
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
    // 固定仓库的绝对路径；为空则视为未配置（启用时会启动失败）。
    cwd: str("OPENCODE_CWD"),
    // 单次任务的总超时；超时会取消任务并杀掉子进程。
    timeoutMs: num("OPENCODE_TIMEOUT_MS", 180000),
    // 返回文本的截断上限，避免把超长输出整段塞给模型。
    maxOutputChars: num("OPENCODE_MAX_OUTPUT_CHARS", 4000),
  },
  // 表情包收藏与识图描述。
  stickers: {
    enabled: bool("STICKERS_ENABLED", true),
    dir: str("STICKERS_DIR", "data/stickers"),
    // 收藏上限，满了淘汰最少用的。
    max: num("STICKERS_MAX", 300),
    // 随提示词给模型的候选表情数量（打乱顺序，避免越用越偏向某几张）。
    promptLimit: num("STICKERS_PROMPT_LIMIT", 40),
  },
  // 聊天里发来的文件：文本类文件可随 opencode 调用一并交给模型分析。
  // 只处理聊天中收到的文件；不做群文件列表，也不支持非文本（图片/压缩包/音视频/Office 等）。
  files: {
    enabled: bool("FILES_ENABLED", true),
    // 单个文件下载上限（字节），超出即判失败，不截断二进制。
    maxBytes: num("FILES_MAX_BYTES", 5 * 1024 * 1024),
    // 单个文件注入 opencode 的字符上限，超出截断（截断事实会写进上下文与日志）。
    maxChars: num("FILES_MAX_CHARS", 20000),
    // 单次 opencode 调用最多注入的文件数（按新→旧选取）。
    maxFiles: num("FILES_MAX_FILES", 3),
  },
  // 普通图片识图（不保存图片，只缓存描述）。
  images: {
    enabled: bool("IMAGES_ENABLED", true),
    // 超过这个大小的图片不下载。
    maxBytes: num("IMAGES_MAX_BYTES", 8 * 1024 * 1024),
  },
  // 长期记忆（按 QQ 号，群/私聊分开）。
  memory: {
    enabled: bool("MEMORY_ENABLED", true),
    file: str("MEMORY_FILE", "data/memory.json"),
    // bot 回复后等这么久再整理记忆；未整理消息攒够 learnBatch 条则不等。
    learnDelayMs: num("MEMORY_LEARN_DELAY_MS", 10000),
    learnBatch: num("MEMORY_LEARN_BATCH", 30),
    // 没有回复触发的批量整理，仅在 bot 于该时间窗内说过话的会话进行。
    engagedWindowMs: num("MEMORY_ENGAGED_WINDOW_MS", 30 * 60 * 1000),
    // 每人最多保留的记忆条数。
    maxFacts: num("MEMORY_MAX_FACTS", 20),
  },
  // 会话内存里的消息记录。
  history: {
    maxMessages: num("HISTORY_MAX_MESSAGES", 80),
    // 给 jev 和模型看的最近消息条数；bot 自己的多行回复占多条记录，要留够才能看懂上下文。
    contextMessages: num("HISTORY_CONTEXT_MESSAGES", 40),
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
  // 群管理：jev 三问（撤回/禁言/回复），各自独立触发；某项提示词留空即不启用该项。
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
};

/** 整个配置对象的类型；需要传递配置引用时用它。 */
export type Config = typeof config;
