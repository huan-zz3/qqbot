**AGENTS.md文档需实时更新**

# qqbot Agent Notes

- TypeScript QQ bot. NapCat OneBot v11 正向 WebSocket（NapCat 是服务端，bot 是客户端），参考 Mist-wu/OvO。
- decider（通用判定接口，默认接 Perplexity Decisions API）决定该不该发言、以及（`needs_search > 0.1` 这么低的门槛）要不要给模型挂上联网搜索工具；端点/密钥/模型全部由 `DECIDER_API_URL`/`DECIDER_API_KEY`/`DECIDER_MODEL`（`.env`）配置，**代码里只有通用接口**，不含任何 provider 专有常量。DeepSeek 写回复并决定是否真的搜索。只用 `deepseek-flash`（`DEEPSEEK_MODEL`，硬编码）——不要加别的模型或降级。
- 联网搜索连一个远程 MCP 服务器（`@modelcontextprotocol/sdk`，streamable HTTP），启动时 `tools/list` 拿到什么工具就挂什么，无常驻凭证。
- 个人项目：模块小且可读，优先 `type`，注释从简。
- 完整文档（中文）在 `README.md`；本文件只记 agent 容易踩的、不易从文件名看出的点。

## 命令

- `pnpm test` — `tsx --test tests/*.test.ts`，用 Node 内置 `node:test`（无测试框架）。跑单个文件：`pnpm exec tsx --test tests/gate.test.ts`。
- `pnpm typecheck` — `tsc --noEmit`。`tsconfig.json` 的 `include` 只有 `src`，**tests/ 不被类型检查**。
- `pnpm dev`（tsx watch）/ `pnpm build`（`tsc` → `dist/`，再用 esbuild+Node SEA 打成单文件可执行 `dist/qqbot`；只编 JS 用 `pnpm build:js`）/ `pnpm start`（`node dist/index.js`）。
- `pnpm learn-history [条数]` — 停掉 bot 后从 NapCat 历史补学记忆（需先 `pnpm build`）。
- 没有 linter / formatter 配置，不要假设有 `lint` 步骤。

## 容易踩的坑

- **`config.ts` 在 import 时就把 `process.env` 读进 `config` 常量**（含 `dotenv.config()`）。改 env 必须在 import 之前；测试因此先在顶部 `process.env.X = ...`，再用 `await import("../src/chat/gate.js")` 动态引入被测模块（见 `tests/gate.test.ts`）。`pnpm test` 下 `NODE_TEST_CONTEXT` 被置位，故意不读本地 `.env`。**`BOT_PERSONA_FILE` 指向的人设文件同样在 import 时读取**（相对路径相对进程启动目录），读不到即抛错终止启动，不静默回退。
- ESM + `NodeNext`：**import 必须带 `.js` 后缀**（`import { config } from "./config.js"`），即使源文件是 `.ts`。
- 挂了工具时，DeepSeek 要求把前序 assistant 回合的 `reasoning_content` 原样回传，否则 400（`llm/deepseek.ts` 的 `chatWithTools`）。
- 工具轮数用尽（`DEEPSEEK_MAX_TOOL_ROUNDS`，默认 3）那一轮起不再挂工具，并额外追加一条 user 收尾指令要求模型纯文本作答；该轮若模型仍返回 `tool_calls` 就不再执行、直接取其文本。原因：模型曾把工具调用语法（`function_calls`/`invoke`/`<|DSML|>`）当普通文本写出，被下游按行当聊天消息发了出去（联网搜索与 opencode 共用同一轮数预算）。
- 联网搜索靠外部 MCP 服务器：连接断了或服务器挂了就置为不可用并打日志，之后按指数退避自动重连（首次 `SEARCH_MCP_RECONNECT_MIN_MS`，×2 封顶 `SEARCH_MCP_RECONNECT_MAX_MS`）、成功即恢复，无需重启；工具清单在启动时拉取一次（`search/mcp-search.ts`）。
- **bot 自身出网靠 undici `ProxyAgent`（`proxy.ts`），只作用于本进程**；spawn 出的 `opencode acp` 是独立进程，拿不到那个 dispatcher，只能靠环境变量。`opencode/env.ts` 的 `childEnv` 按 `PROXY_URL` 注入 `http_proxy`/`https_proxy`/`all_proxy`，并把本机地址加进 `no_proxy`。systemd 服务环境干净（没有 `http_proxy`），若不注入，opencode 会直连 models.dev / 模型 provider / 远程 MCP 而超时，任务跑不完。
- **`opencode acp` 没有 `--model`，也无视命令行里选的模型**；不指定就用自己的默认模型。给它选模型只能经 ACP：`session/new` 响应里的 `configOptions`（id/category=`model`）→ `session/set_config_option`（`agent.ts` 调用，值来自 `OPENCODE_MODEL`，纯逻辑在 `opencode/model.ts`，配了却不在可选列表内会报错）。全局 opencode config 的 `model` 是 `providerID` 对象且 provider 名大小写必须与注册的 id 一致（本机是 `deepseek`），写 `DeepSeek/...` 不生效。
- @/回复 bot 只是给 decider **降低阈值**的提示，不是强制回复（`gate.ts` `decide`）。
- 自定义「什么情况下该回复」提示词（`GATE_REPLY_QUESTION_PROMPT`/`_TRUE_PROMPT`/`_FALSE_PROMPT`）由 `gate.ts` `buildQuestions` 分别**追加**到 `should_reply` 的正文/true/false 之后，留空不追加、不替换；启动日志 `reply_prompt=` 列出已配置的位。
- 聊天记录写成 `说话人 → 对象：正文（引用 某人的「原文」）`（`history.ts` `formatLine`/`relation`）；decider 输入、回复提示词、记忆提示词必须保持同一格式。
- 提示词只给事实，不给规则或示例句：不写长度/语气要求，不放例句（模型会照抄）（`reply.ts` `buildSystemPrompt`）。
- 模型输出约定：`[不回复]`（`SKIP_MARKER`）表示不说；`[表情包#编号]` 单独一行发收藏表情；收到的图片显示为 `[图片：描述]`，QQ 小黄脸显示/收发按 `[名称]`（名字表在 `napcat/faces.ts`）。回复里写的 `@名字` 会发成真 @。
- 定时群发（`src/schedule/scheduler.ts`）是**独立旁路**：不走 decider/DeepSeek，也不进会话历史/记忆；时区**写死 `Asia/Shanghai`**。`SCHEDULE_ENABLED=true` 时缺项或 cron 非法会在启动时 `process.exit(1)`（不静默不发）。到点受 `/启动` `/停止` 约束。用外部依赖 `cron`（`CronJob`）。
- 群管理（`src/moderation/`）的 decider 三问（撤回/禁言/回复）**始终判定**，不再以机器人在群里的身份为前提；只有撤回/禁言需要机器人是该群群主/管理员（命中时才用 `get_group_member_info` 查并缓存，失败按无权限处理），无权限时这两项命中也不执行、不发文本，只记日志；**「回复」不依赖权限，始终可用**。`handoff.mark` 以**实际执行**为准：命中却因无权限未执行的项不算数，该消息照常进聊天流程（`moderation.ts`、`handoff.ts`）。
- 入群欢迎（`src/welcome/welcome.ts`）是**独立旁路**：监听 OneBot `notice/group_increase` 事件，@ 新成员发 `WELCOME_TEXT`；群范围是独立的 `WELCOME_GROUPS`（与 `MODERATION_GROUPS` 无关），不走 decider、不进聊天历史/记忆。`WELCOME_ENABLED=true` 时 `WELCOME_GROUPS`/`WELCOME_TEXT` 任一为空会启动即 `process.exit(1)`；受 `/启动` `/停止` 约束；入群者就是机器人自己时跳过。入站事件在 `index.ts` 由 `isMessageEvent` 之外新增 `isGroupIncreaseEvent` 分流（`napcat/types.ts`）。

## 目录

- `src/index.ts` 启动、依赖组装；`src/config.ts` 环境变量（`str`/`num`/`bool`/`list`/`textFile` 助手；`textFile` 供 `BOT_PERSONA_FILE` 读追加人设）。
- `src/napcat/` WS 客户端、OneBot 类型、消息段渲染、QQ 表情表。
- `src/chat/gate.ts` decider 问题与阈值、无 decider 兜底；`runtime.ts` 会话防抖/判断/回复/发送/触发记忆。
- `src/decider/questions.ts` 通用判定输入/问题类型与 noul 构造；`client.ts` 通用判定请求（POST state + questions，端点/密钥/模型来自 `config.decider`）。
- `src/chat/reply.ts` 提示词、输出解析、分条或合并转发；`stickers.ts`/`images.ts`/`media.ts` 表情包与图片。
- `src/chat/files.ts` 聊天文件懒下载与文本读取；`decode.ts` 文本字节多编码严格解码（BOM 优先，UTF-8→GB18030→Big5→Shift_JIS→EUC-KR，首个成功；**GB18030 会吞掉多数 Big5/SJIS/EUC-KR 字节**，命中编码记日志以便排查）。
- `src/chat/memory.ts` 长期记忆（群/私聊分开，按 QQ 号）；`power.ts` 管理员 `/启动` `/停止`（持久化）；`history.ts` 会话消息记录。
- `src/llm/deepseek.ts` deepseek-flash 工具循环（含工具额度用尽时的收尾指令）、识图、JSON（失败重试一次）。
- `src/search/mcp-search.ts` MCP 联网搜索客户端（连接、工具映射、调用）；`src/cli/learn-history.ts` 历史补学。
- `src/schedule/scheduler.ts` 定时群发（cron，固定 Asia/Shanghai，受电源开关约束）。
- `src/moderation/moderation.ts` 群管理（decider 三问，判定始终进行；撤回/禁言需管理权限，回复始终可用）；`handoff.ts` 群管理与聊天运行时的协调信号。
- `src/welcome/welcome.ts` 入群欢迎（`notice/group_increase`，@ 新成员发固定文本，独立旁路）。
- `src/opencode/` 只读 OpenCode（ACP）：`agent.ts` 进程编排、`env.ts` 子进程环境（代理）、`model.ts` 模型选择、`permission.ts` 权限裁决。
- `deploy/` systemd unit；`scripts/build-sea.mjs` 打包单文件可执行。

## 约定

- `data/` 是运行时状态（`state.json`、`memory.json`、`stickers/`），已被 `.gitignore` 忽略，**不要提交或公开**（含群友个人信息）。
- `BOT_PERSONA_FILE` 指向的人设文件通常也含个人信息，放仓库根或 `data/` 并确保被 `.gitignore` 忽略（仓库已忽略根目录的 `PERSONA.txt`）。
- 代码用 `type` 而非 `interface`；模块保持小而单一。
