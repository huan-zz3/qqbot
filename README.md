<div align="center">

# qqbot

**decider 决定该不该说话，deepseek-flash 决定说什么。**

一个跑在 [NapCat](https://github.com/NapNeko/NapCatQQ) 上的 QQ 群聊机器人：会看场合接话、会发表情包、会连发几条、会联网查资料，还记得你在私聊里说过的事。

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![OneBot](https://img.shields.io/badge/OneBot-v11-black)](https://github.com/botuniverse/onebot-11)
[![License](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)

</div>

---

## 亮点

- 像群友一样判断时机：新消息先攒一小批，交给 decider —— 一个通用的“判定接口”（本项目默认接 [Perplexity Decisions API](https://docs.perplexity.ai)，端点 / 密钥 / 模型都在 `.env` 里配）—— 给出“该不该接话”的概率。被 @ 或被回复只是降低门槛，“哈哈哈”之类的收尾照样可以不回。
- 只用 deepseek-flash 说话：提示词只交代事实（QQ 不渲染 Markdown、每行是一条消息、可以选择不说），不规定长度语气，也不给示例句。
- 表情包：自动收藏群友发的表情包，用识图模型（独立后端，SiliconFlow 的 DeepSeek-OCR）写描述；模型想发时自己挑。识别与发送可分开开关（`STICKERS_RECOGNIZE_ENABLED`），积累够了可关掉识别、只读现有库继续发送。QQ 小黄脸按名字收发（`[doge]` 会发成真表情）。
- 看得懂图片：普通图片也交给识图模型识别，以 `[图片：描述]` 出现在聊天记录里。
- 连发多条，长了就合并转发：每行一条消息，按打字速度间隔发出；回复长到超过 5 行或 300 字时，第一条文本单独发出，从第二条起合并成一条转发，不刷屏。
- 联网搜索：decider 觉得可能需要查资料时，把一个远程 MCP 搜索服务器（多引擎搜索 + 抓取网页正文）暴露的工具挂给模型，搜不搜、抓不抓由模型决定。
- 只读问代码（可选）：让模型在预定义的代码仓库里检索、阅读并回答问题（`opencode acp`，可用短名切换仓库）。只读由三重保障：不声明 fs 能力、拒绝一切权限请求、子进程注入只读配置 deny 掉写/命令/联网类工具。群友发来的 zip/rar 日志会被解压到本地目录，模型可让 opencode 去读（见「聊天压缩包联动」）。
- 长期记忆：按人记住聊过的事，群聊和私聊分开记；私聊里说的，到群里它也知道，提不提由它自己判断。
- @ 显示名字：被 @ 的人显示群名片，不会把 QQ 号念出来；它回复里写的 `@名字` 会发成真正的 @。
- 分得清谁在对谁说：聊天记录写成 `说话人 → 对象：正文（引用 某人的「原文」）`，对象来自 @、再退到被引用消息的作者；decider 的输入里也有 `to` / `quoting`。回复机器人的消息却在 @ 别人，就是在跟那个人说。
- 不复读结尾：同一个结尾 emoji / 小黄脸在它最近几条里已经用了两次，这次就去掉。

## 工作原理

```
NapCat ──WS──> 收消息 ──防抖合并──> decider 判断 ──是──> deepseek-flash 生成 ──> 分条发送 / 合并转发
                 │                   │                  │
                 ├─图片/表情包─> 识图   └─否─> 不发言       ├─needs_search > 0.1 ─> 挂上 MCP 搜索工具
                 └─@某人─> 查群名片                        └─提示词带上相关的人的长期记忆
```

每一批新消息，decider 回答三个是非题（概率 0–1）：

| 问题 | 用途 |
| --- | --- |
| `should_reply` | 达到阈值才发言：群聊 0.6、私聊 0.35、被 @ 或回复 0.45（`GATE_DIRECT_USERS` 名单里的 QQ 被 @ 或回复同样按 0.45） |
| `addressed` | 是不是在跟机器人说话，记录在日志里便于调参 |
| `needs_search` | 高于 0.1 就给模型挂上 MCP 搜索工具（前提是 MCP 服务器可用） |

机器人最近 5 分钟发了多少言、距上次发言多久，也一起放进 decider 的输入里，让它自己权衡别刷屏，代码里没有硬性冷却。`should_reply` 的正文与 true/false 判定标准都支持追加自定义提示词（`GATE_REPLY_QUESTION_PROMPT` / `GATE_REPLY_TRUE_PROMPT` / `GATE_REPLY_FALSE_PROMPT`，留空不追加），用来补充「什么情况下该回复」。decider 不可用时退化为：私聊、被 @、被回复、被点名才回复，纯反应消息不回。

可选地，对 `GATE_FORCE_REPLY_GROUPS` 里指定的群，各自累计「自机器人上次发言以来收到的群消息数」；达到 `GATE_FORCE_REPLY_MESSAGES` 时，该群下一批判定**强制回复一次**（跳过 `should_reply` 阈值，搜索建议仍照常由 decider 给出），随后该群计数清零。机器人自身在群里发言、强制判定作出、或 `/停止` 时都会清零。私聊与未列出的群不受影响。

## 快速开始

### 准备

- Node.js ≥ 22、pnpm
- 一个已登录的 NapCat（推荐 [NapCat-Docker](https://github.com/NapNeko/NapCat-Docker)）
- [DeepSeek API key](https://platform.deepseek.com/)（回复模型）
- [SiliconFlow API key](https://cloud.siliconflow.cn/)（图像识别，独立于回复模型；开图片识图、或表情包识别才需要，表情包只发送不识别时不需要）
- [Perplexity API key](https://console.perplexity.ai)（decider，可选）

### 1. 在 NapCat 里开 WebSocket 服务端

在 NapCat WebUI 的“网络配置”里新建一个 WebSocket 服务端，或者直接写进 `onebot11_<QQ号>.json`：

```json
{
  "network": {
    "websocketServers": [
      {
        "name": "qqbot",
        "enable": true,
        "host": "0.0.0.0",
        "port": 3001,
        "messagePostFormat": "array",
        "reportSelfMessage": false,
        "token": "换成一个随机字符串",
        "enableForcePush": true,
        "debug": false,
        "heartInterval": 30000
      }
    ]
  }
}
```

端口不要暴露到公网；Docker 部署时映射成 `127.0.0.1:3001:3001`。

### 2. 安装配置

```bash
git clone https://github.com/Mist-wu/qqbot.git && cd qqbot
pnpm install
cp .env.example .env
```

至少填这几项：

```ini
NAPCAT_TOKEN=和 NapCat 里一致
DEEPSEEK_API_KEY=sk-...
DECIDER_API_URL=https://api.perplexity.ai/v1/decisions
DECIDER_MODEL=pplx-decider-v1.1-27b
DECIDER_API_KEY=pplx-key1,pplx-key2
BOT_NAME=机器人的名字
BOT_GROUPS=要发言的群号,逗号分隔
BOT_PRIVATE_USERS=允许私聊的QQ号,逗号分隔
```

`BOT_GROUPS` 和 `BOT_PRIVATE_USERS` 是白名单，为空就不在群里 / 私聊里说话。

`BOT_ADMIN_USERS` 里的 QQ 号可以在私聊里发 `/停止` 让 bot 暂停（不判断、不回复、不收藏表情包、不整理记忆），发 `/启动` 恢复；状态存在 `data/state.json`，重启后保持。进程本身不会退出，所以随时能再 `/启动`。

### 3. 运行

```bash
pnpm build        # tsc 编译 + 打成单文件可执行 dist/qqbot
pnpm start        # 用 node 跑 dist/index.js（开发/调试仍可用）
```

`pnpm build` 会先用 `tsc` 编到 `dist/`，再用 esbuild + Node SEA 把它连同依赖汇成单文件可执行 `dist/qqbot`。它自包含、不需要 `node_modules` 和 Node 运行时，但仍要在 cwd 下读到 `data/` 与 `.env`（或环境变量）。

```bash
./dist/qqbot      # 直接跑可执行文件
```

只想要 `dist/` 里的 JS（不打可执行）时用 `pnpm build:js`。

长期运行可以用 `deploy/qqbot.service`（按注释改好用户和路径，已默认指向 `dist/qqbot`）：

```bash
sudo install -m 644 deploy/qqbot.service /etc/systemd/system/
sudo systemctl enable --now qqbot
journalctl -u qqbot -f -o cat   # 看每条消息的 decider 分数和决定
```

单元里显式设了 `Environment=PATH=...`：systemd 的默认 PATH 不含 nvm 的 bin 目录，而 `opencode` 子进程（spawn 时继承本进程环境，见 `src/opencode/env.ts`）里，CodeGraph 的 MCP server 与模型自己的 bash 工具都按 PATH 找 `codegraph`/`node`，缺了就会 `codegraph: command not found`。把装了 `opencode`/`node`/`codegraph` 的那个目录（本机是 nvm 的 bin）写进 PATH 即可；改用别的方式安装时相应替换该目录。改完单元要 `sudo install -m 644 deploy/qqbot.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart qqbot`。

### 4. 联网搜索（可选）

搜索走一个远程 MCP 服务器（streamable HTTP）：进程启动时连一次，把服务器 `tools/list` 返回的全部工具（多引擎搜索，以及抓取网页正文 / README / 掘金 / CSDN / linux.do 文章等）挂给模型，搜不搜、抓不抓由模型决定。每个 JSON-RPC 调用都是一次独立的 HTTP POST；启动时连不上、或运行中会话失效（服务器重启 / 会话过期），会按指数退避自动重连（首次 `SEARCH_MCP_RECONNECT_MIN_MS`，成长 ×2，封顶 `SEARCH_MCP_RECONNECT_MAX_MS`），重连期间搜索暂不挂载、成功后自动恢复，无需重启。

默认 `SEARCH_MCP_URL=https://openwebsearch.flow-serene.life/mcp`，无需凭证；换成别的 streamable HTTP MCP 服务器也能用。`SEARCH_MCP_ENABLED=false` 完全关闭，`SEARCH_MCP_TIMEOUT_MS` 控制连接与单次工具调用的超时。

### 5. 只读 OpenCode（可选）

给模型加一个在预定义代码仓库里检索、阅读并回答问题的能力，底层是 `opencode acp`（见 [ACP 文档](https://opencode.ai/v2/docs/cli/acp/)）。它是**只读**的，一共三重保障：客户端不声明任何文件系统 / 终端能力；对所有权限请求一律拒绝；并且每个子进程都注入 `OPENCODE_CONFIG_CONTENT`，把 `edit` / `shell` / `execute`（Code Mode，能跑 JS + fetch）/ `webfetch` / `websearch` / `subagent` 直接 deny——被 deny 的工具根本不会挂给模型（实测不会弹权限询问）。因此 OpenCode 无法执行命令、改动文件或联网外传。

前提：

- 服务器上安装 [OpenCode](https://opencode.ai) 并完成 `opencode auth login`（用它自己的登录态，与本项目的 MCP 联网搜索无关）；
- `.env` 里设 `OPENCODE_ENABLED=true`，并配置**至少一个**仓库目录：主目录 `OPENCODE_CWD=/绝对路径/到/仓库`（短名固定为 `default`），或用 `OPENCODE_DIRS=短名=绝对路径 ...` 追加更多仓库（逗号/空格分隔，路径不能含空格/逗号）。任一目录非绝对路径或不是已存在的目录时，启动会报错退出，不会静默失效。

调用时由**模型用短名选择**要进入的仓库（工具参数 `directory` 为必填、取值限定为这些短名）；一次调用只进一个仓库。调用与否由模型自己决定；一次任务同步执行，超时会先取消再杀掉子进程。**同一会话（群 / 私聊）内的多次调用串行执行**（同一批里模型并发发起的多个 opencode 调用会依次跑完），**跨会话最多 `OPENCODE_MAX_CONCURRENCY` 个并发**（默认 3），超出的排队等待；排队时间不计入单次超时。白名单内的群 / 私聊都能触发，结果发在原会话。提示词里给模型的说明可用 `OPENCODE_PROMPT` 自定义，用来框定「什么情况下该调用」。可用 `OPENCODE_NOTICE_TEXT` 在探索开始时先发一条提示（例如「正在查看，请稍等…」），留空则不发；该提示会作为一条普通消息发出并写入会话历史，因此群聊里随后的正式回复可能带上对最后一条消息的引用。还可用 `OPENCODE_INPUT_PREFIX` / `OPENCODE_INPUT_SUFFIX` 把一段自定义文本拼进**送进 acp 的 prompt**（分别前置/后置，留空则不拼、不产生多余空行）；注意这与 `OPENCODE_PROMPT`（给回复模型看的工具说明）是两回事，后者不进 acp。

**超时与卡死检测**：任务有三道闸，任一到点都先协作式取消（`$/cancel_request`），宽限 5s 未恢复再硬失败并杀子进程。① 总墙钟 `OPENCODE_TIMEOUT_MS`（默认 180s）是绝对上限；② 空闲 `OPENCODE_IDLE_TIMEOUT_MS`（默认 60s）在 prompt 阶段每收到一条 ACP `session/update` 就重置，静默过久即判定 opencode 内部卡死——这是「它一直不返回、只能干等总超时」的主要兜底（正常任务会持续产生 update 当心跳）；③ 重试 `OPENCODE_RETRY_MAX`（默认 2）：opencode 在模型调用失败并排定重试时会经 `session_info_update` 的 `_meta["opencode/retry"]` 上报 `attempt`/`nextRetryAt`/`error`，活跃重试次数超过上限即提前取消。启用时若 `OPENCODE_IDLE_TIMEOUT_MS` 不为正或不小于总超时、或 `OPENCODE_RETRY_MAX` 不为正，启动即报错退出（不静默失效）。

**必须显式指定模型**：`opencode acp` 没有 `--model` 参数，也无视命令行里选中的模型，不指定就会用它自己的默认模型（可能又贵又不是你要的，且你那台机器上全局 config 写的 `DeepSeek/deepseek-v4-pro` 因 provider 大小写不匹配而没生效）。因此用 `OPENCODE_MODEL=<provider>/<model>`（如 `deepseek/deepseek-flash`）指定；bot 会在建好会话后经 ACP 的 `session/set_config_option`（`configId=model`）设置它。留空则沿用 opencode 默认（README 不推荐）。配了却不在可选模型内会在任务失败时报出可选值，不做静默回退。

bot 自身的出网走 undici `ProxyAgent`（只作用于本进程），spawn 出的子进程拿不到，因此 spawn 时会按 `PROXY_URL` 给子进程注入 `http_proxy`/`https_proxy`/`all_proxy`，并把 `127.0.0.1`/`localhost`/`::1` 加进 `no_proxy`，避免 OpenCode 的本机内部通信被代理转发而失败。

**工具轮数上限**：联网搜索与只读 OpenCode 各是一个**工具组**，两组**各自独立计轮**（`SEARCH_MAX_TOOL_ROUNDS` / `OPENCODE_MAX_TOOL_ROUNDS`，默认均 3）——某组用满只撤掉该组工具、并追加一条 user 提示告知该工具本轮起不可用，另一组不受影响。当**两组都用满**后，才不再挂任何工具，并额外向模型追加一条 user 收尾指令，明确要求纯文本作答、不得再输出工具调用语法（`function_calls`/`invoke`/`parameter` 或 `<|DSML|>` 等标记）——否则模型可能把调用语法当普通文本写出、进而被当成聊天消息发出去。该收尾轮是真正的最后一轮：若模型仍返回工具调用，不再执行，直接取其文本内容收尾（会记 warn 日志）。总轮数上限为两组上限之和；某轮同时调用两组则两组各计一轮。

**聊天压缩包联动**：群里 / 私聊里发来的压缩包在聊天记录里显示为 `[文件：文件名（大小）]`。回复批构建时，系统会把**本批发言人最近发来的 `.zip` / `.rar`**（最多 `FILES_MAX_FILES` 个）下载并解压到 `FILES_DIR/<会话>/u<发送者>-m<消息id>-<序号>/`，再把「目录 + 文件清单」写进回复提示词——模型据此知道有哪些文件，需要看内容时让 opencode 去读（解压目录会作为 ACP `additionalDirectories` 在 `session/new` 时声明，opencode 才能在仓库之外读到这些目录）。只认 zip/rar；图片、音视频、Office 文档、**松散文本文件**等一律不支持（请群友打包成压缩包再发）。解压按多编码**严格**解码：先嗅探 BOM（UTF-8 / UTF-16LE / UTF-16BE），无 BOM 再依次尝试 UTF-8 / GB18030 / Big5 / Shift_JIS / EUC-KR，取第一个成功；命中非 UTF-8 的文本文件**就地重写为 UTF-8** 并在清单里标注编码。安全：条目名净化（拒绝绝对路径 / `..` / 盘符 / 反斜杠越界）、加密与多卷包整包拒绝、条目数 / 单文件 / 解压总量限额、解压后查符号链接；失败或拒绝都写进清单由模型转告用户（不静默跳过）。清理：目录按 `FILES_KEEP_MS` 到期删除、磁盘超 `FILES_STORE_MAX_BYTES` 时删最旧，启动与每 `FILES_SWEEP_MS` 扫描一次，并清 `.tmp` 残留。`FILES_MATERIALIZE` 独立控制是否物料化（与 `OPENCODE_ENABLED` 解耦）；关掉即不下载任何压缩包。给模型的执行逻辑说明可经 `FILES_PROMPT`（解压成功/失败与失败要如实转告等）与 `FILES_READ_PROMPT`（怎么用 opencode 读解压目录，仅在挂了 opencode 时追加）覆盖，留空用内置默认；`.env.example` 里给出了示例定义。

## 配置

完整列表见 [`.env.example`](.env.example)，常用的：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BOT_PERSONA` | 是群里的一个 AI 群友。 | 内联身份，接在“你是「名字」，…”后面；留空则只有名字（代码不内置默认人设）。写具体些说话更有性格 |
| `BOT_PERSONA_FILE` | | 行为准则文件路径：内容作为回复提示词的独立“必须遵守的人设与行为准则”段落，不与身份句混写；支持相对路径（相对进程启动目录），文件读不到会直接报错退出 |
| `BOT_ALIASES` | | 群友对它的其他称呼，被叫到时 decider 能看到 |
| `GATE_GROUP_THRESHOLD` | 0.6 | 群聊发言阈值，调低更活跃 |
| `GATE_PRIVATE_THRESHOLD` | 0.35 | 私聊发言阈值 |
| `GATE_DIRECT_THRESHOLD` | 0.45 | 被 @ 或被回复时的阈值 |
| `GATE_DIRECT_USERS` | | 名单里的 QQ 被 @ 或被回复时视同机器人自己被 @/回复，同样走 0.45 这个 direct 阈值（防抖也按 direct 处理）；逗号分隔 |
| `HISTORY_CONTEXT_MESSAGES` | 40 | 给模型看的**共享**最近消息条数（所有人共用） |
| `HISTORY_USER_CONTEXT_MESSAGES` | 20 | 本批每个发言群友**各自额外保证**纳入的最近消息条数（叠加在共享窗口之上，刷屏者触发的 prompt 更完整携带其内容）；此外，模型窗口还会在「共享窗口 ∪ 逐账号保证」已触及的范围（最旧选中消息→最新）内补齐 **bot 自己**的消息（不新增配置、不改变窗口下界） |
| `DECIDER_CONTEXT_MESSAGES` | 40 | 给 decider 看的**共享**最近消息条数（与模型窗口分开配置） |
| `DECIDER_USER_CONTEXT_MESSAGES` | 0 | decider 窗口对本批每个发言群友**各自额外保证**纳入的最近消息条数（叠加在共享窗口之上，语义同 `HISTORY_USER_CONTEXT_MESSAGES`）；默认 0 时退化为只看共享窗口、与拆分前一致。decider 窗口同样会补齐区间内 **bot 自己**的消息 |
| `GATE_SEARCH_THRESHOLD` | 0.1 | `needs_search` 高于它就挂上搜索工具 |
| `GATE_REPLY_QUESTION_PROMPT` | | 追加到 `should_reply` 问题正文之后的自定义提示词 |
| `GATE_REPLY_TRUE_PROMPT` / `GATE_REPLY_FALSE_PROMPT` | | 分别追加到 `should_reply` 的 true / false 判定标准之后 |
| `GATE_FORCE_REPLY_ENABLED` | false | 启用「累计群消息强制回复」：指定群各自累计未回复的群消息，达到条数后下一次判断强制回复一次（跳过回复阈值，搜索建议照常来自 decider） |
| `GATE_FORCE_REPLY_GROUPS` | | 生效的群号，逗号分隔；各群独立计数与清零。必须都在 `BOT_GROUPS` 内，启用时不能为空，否则启动报错退出 |
| `GATE_FORCE_REPLY_MESSAGES` | 20 | 触发条数；启用时必须为正，否则启动报错退出 |
| `DECIDER_API_URL` / `DECIDER_MODEL` / `DECIDER_API_KEY` | Perplexity Decisions | 通用判定接口的端点 / 模型 / 密钥；`DECIDER_API_URL` 为空即停用 decider，退回规则兜底。`DECIDER_API_KEY` 可配多个（逗号/空格分隔），共用同一端点与模型：按顺序为优先级，某个失败就换下一个，成功者提升为最高优先级（仅进程内存，重启回到配置顺序） |
| `OPENCODE_ENABLED` / `OPENCODE_CWD` | false / | 启用只读 OpenCode；`CWD` 是可访问的主仓库绝对路径（短名固定 `default`） |
| `OPENCODE_DIRS` | | 追加的可访问仓库，每项 `短名=绝对路径`，逗号/空格分隔（路径不能含空格/逗号）；调用时模型用短名选择 |
| `OPENCODE_PROMPT` | （内置只读说明） | 提示词里给模型的 opencode 说明，用来框定「什么情况下该调用」 |
| `OPENCODE_MODEL` | | 给 ACP 会话指定的模型（`provider/model`，如 `deepseek/deepseek-flash`）；留空用 opencode 自己的默认（可能很贵） |
| `OPENCODE_TIMEOUT_MS` / `OPENCODE_IDLE_TIMEOUT_MS` / `OPENCODE_RETRY_MAX` | 180000 / 60000 / 2 | 总墙钟超时 / prompt 阶段无响应空闲超时（每收一条 `session/update` 重置，静默过久判卡死）/ 容忍的模型重试次数；空闲超时须为正且小于总超时、重试上限须为正，否则启动报错退出 |
| `OPENCODE_MAX_CONCURRENCY` | 3 | 全局同时运行的 opencode 任务数上限；同一会话始终串行，跨会话最多这么多并发，超出的排队等待（排队不计入单次超时）。须为正整数，否则启动报错退出 |
| `OPENCODE_NOTICE_TEXT` | | opencode 开始执行时先发出的提示文本；留空则不发（会写入会话历史） |
| `OPENCODE_INPUT_PREFIX` / `OPENCODE_INPUT_SUFFIX` | | 自定义文本，拼进**送进 `opencode acp` 的 prompt**：前置拼在任务前、后置拼在任务后（各自留空则不拼、不产生多余空行）；与上面的 `OPENCODE_PROMPT`（给回复模型看的工具说明）不是一回事 |
| `GATE_GROUP_DEBOUNCE_MS` | 3000 | 群里等消息停下多久再判断 |
| `DEEPSEEK_THINKING` | false | deepseek-flash 的思考模式 |
| `DEEPSEEK_TEMPERATURE` | 1.1 | 回复的采样温度；1.3 会冒出奇怪的外文标点和单词 |
| `SEARCH_MAX_TOOL_ROUNDS` / `OPENCODE_MAX_TOOL_ROUNDS` | 3 / 3 | 联网搜索组、opencode 组各自独立的工具轮数上限；某组用满只撤该组并提示该工具不可用，两组都用满才不再挂工具并追加「纯文本作答」收尾指令 |
| `REPLY_FORWARD_PARTS` / `REPLY_FORWARD_CHARS` | 5 / 300 | 回复超过这么多行或字就改发合并转发（第一条文本单独发，其余合并） |
| `VISION_API_KEY` | | 图像识别（SiliconFlow DeepSeek-OCR）的密钥，与回复模型分开；开图片识图、或表情包识别（`STICKERS_ENABLED` 且 `STICKERS_RECOGNIZE_ENABLED`）时必填，否则启动报错退出 |
| `VISION_DETAIL` | high | 传给识图接口 `image_url` 的细节级别：`low` / `high` / `auto`，非法值启动报错退出 |
| `VISION_TIMEOUT_MS` / `VISION_MAX_TOKENS` | 30000 / 512 | 识图请求超时（毫秒）与输出上限；须为正，且超时须小于媒体补全等待上限（`MEDIA_WAIT_MS`=35000），否则启动报错退出 |
| `IMAGES_ENABLED` | true | 普通图片识图（图像识别后端写死为 SiliconFlow 的 `deepseek-ai/DeepSeek-OCR`，模型名不可配） |
| `FILES_ENABLED` | true | 聊天压缩包能力：记录里显示 `[文件：…]`，并把本批发言人的 zip/rar 解压给模型 |
| `FILES_MATERIALIZE` | true | 是否下载解压压缩包（与 `OPENCODE_ENABLED` 解耦）；关掉则不下载，仅保留记录展示 |
| `FILES_DIR` / `FILES_MAX_BYTES` / `FILES_MAX_FILES` | data/uploads / 50MB / 3 | 解压根目录（相对值会在启动时解析为绝对路径）、单包下载上限（流式边读边限）、单批最多处理几个包 |
| `FILES_EXTRACT_MAX_BYTES` / `FILES_EXTRACT_MAX_ENTRIES` / `FILES_EXTRACT_MAX_FILE_BYTES` | 200MB / 1000 / 50MB | 单包解压后总字节、条目数、单文件字节上限 |
| `FILES_KEEP_MS` / `FILES_STORE_MAX_BYTES` / `FILES_SWEEP_MS` / `FILES_TIMEOUT_MS` | 24h / 1GB / 1h / 120s | 解压目录保留时长、磁盘总预算（超出删最旧）、清理扫描间隔、单包下载超时；启用物料化时都必须为正，否则启动报错退出 |
| `FILES_PROMPT` / `FILES_READ_PROMPT` | （内置说明） | 给模型的压缩包处理说明（执行逻辑：何时算成功 / 失败、失败要如实转告等）与「怎么读解压目录」说明；留空用内置默认。`FILES_READ_PROMPT` 仅在挂了 opencode 工具时追加（见 [`.env.example`](.env.example) 里的示例定义） |
| `STICKERS_ENABLED` | true | 表情包总开关：关掉则整个表情包功能停用（不建库、不展示、不发送） |
| `STICKERS_RECOGNIZE_ENABLED` | true | 是否识别并收藏新表情（下载 + 识图 + 入库，含把归档表情提升回活跃）；关闭后只读现有库，老表情照常展示与发送，新表情不下载不识图，适合「积累够了不想再轮换」 |
| `STICKERS_MAX` | 300 | 表情包收藏（活跃）上限，满了淘汰最少用的 |
| `STICKERS_ARCHIVE_MAX` | 2000 | 淘汰后保留描述的归档上限（归档无文件，可远大于收藏上限），满了淘汰最旧的 |
| `MEMORY_LEARN_DELAY_MS` | 10000 | 记忆只在 bot 实际回复后整理（范围=触发该次回复的那批消息），回复后等这么久再整理；延迟窗内的多次回复合并为一次 |
| `PROXY_URL` | | 填 HTTP 代理地址（如 `http://127.0.0.1:7890`）则所有联网请求都走它；留空直连 |
| `SCHEDULE_ENABLED` / `SCHEDULE_GROUPS` | false / | 定时群发：按 `SCHEDULE_CRON` 向这些群各发一条 `SCHEDULE_TEXT` |
| `EXEC_ENABLED` | false | 定时执行本地 shell 命令（多条，只写日志；不受 `/启动` `/停止` 约束） |

## 表情包与记忆

- 表情包：收藏表情和商城表情第一次出现时下载下来，识图模型写一句描述，存在 `data/stickers/`。聊天记录里显示为 `[表情包：描述]`；群友发得最多的 40 张打乱顺序后随系统提示词给模型（不按它自己用过的次数排，免得越用越偏向那几张），它单独一行写 `[表情包#编号]` 就会发出去。收藏超过上限时淘汰最少用的（只删图片文件），被淘汰的表情的**描述会转入归档**（`data/stickers/archive.json`）：之后它再出现时直接复用归档描述、**不会重新识图**（省 token），并在活跃收藏有空间或它的分数不低于活跃最低分时提升回收藏。识别与发送分开开关：`STICKERS_RECOGNIZE_ENABLED=false` 时只读现有库（老表情照常展示与发送，新表情不下载不识图、归档也不提升），适合积累够了不再轮换。
- 普通图片：同样识图，但只在内存里缓存描述，不保存图片。
- QQ 小黄脸：收到的显示为 `[名称]`；模型写出已知名称时发成真表情。名称表 [`src/napcat/faces.ts`](src/napcat/faces.ts) 取自 QQ NT 客户端的 `default_config.json`。
- 记忆：只在 bot 实际回复后整理，范围是触发这次回复的那批消息；延迟窗内的多次回复合并为一次，让 deepseek-flash 更新对每个发言者的记忆：只记长期有效的（身份、喜好、关系、重要经历），不记一次性的事和玩笑，也不记住址、学校、联系方式这类隐私。按 QQ 号存在 `data/memory.json`，群聊和私聊分开记。回复时带上聊天里出现的人、以及被 @ 的人的记忆，私聊学到的标注“私聊里告诉你的”。
- 已有聊天记录可以补学一遍：先停掉 bot，再运行 `pnpm learn-history [条数]`，它会从 NapCat 拉白名单私聊和群的最近记录。

`data/` 里有群友的个人信息和表情包，不要提交或公开。

## 群管理模块（可选）

独立的群管理，不需要任何指令：机器人自己看群消息，把每条消息连同它前面 `MODERATION_CONTEXT_MESSAGES` 条上下文一起交给 decider，一次问三个问题（撤回 / 禁言 / 回复）。三个操作**各自独立触发、无优先级**：只要某项分数达到自己的阈值就执行该项，一条消息可同时命中多项（执行顺序为 撤回 → 禁言 → 回复），每项各自 @ 对方发一条固定文本：

- 撤回：先 `delete_msg`，再 @ 对方发 `MODERATION_RECALL_TEXT`；
- 禁言：先 `set_group_ban` 对方 `MODERATION_BAN_SECONDS` 秒，再 @ 对方发 `MODERATION_BAN_TEXT`；
- 回复：只 @ 对方发 `MODERATION_REPLY_TEXT`。

它和普通聊天共用同一套消息流：群管理**实际执行**任一操作（撤回/禁言/回复）后，机器人会跳过同一批次消息的 AI 回复，避免一边处罚一边闲聊；**未命中**、或因无管理权限而没执行撤回/禁言时，消息照常进入聊天流程、正常回复。这个跳过由 `MODERATION_SKIP_REPLY` 控制（默认开启）。某一项的 `MODERATION_*_PROMPT` 留空即不启用该项；三项全空则不判断。

前提：

- `MODERATION_ENABLED=true`，并把要管理的群号填进 `MODERATION_GROUPS`；
- 判定始终进行，不要求机器人自身是管理员；但**撤回、禁言需要机器人是该群的群主或管理员**，无权限时这两项即使命中也不执行、不发文本（只记日志），**回复**始终可用：需要判断权限时用 `get_group_member_info` 确认自己的身份并缓存（仅在命中撤回/禁言时才查询），遇到 `retcode 1401` 时下次重查；
- 撤回受 QQ 时限与 NapCat 缓存限制，过期或未缓存的消息可能撤回失败，此时不会发出固定文本（不谎报已处理）。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MODERATION_ENABLED` | false | 是否启用群管理 |
| `MODERATION_GROUPS` | | 启用的群号，逗号分隔 |
| `MODERATION_CONTEXT_MESSAGES` | 5 | 判断一条消息时附带的前置消息条数 |
| `MODERATION_SKIP_REPLY` | true | 群管理命中后是否跳过同一批消息的 AI 回复 |
| `MODERATION_RECALL_PROMPT` / `_THRESHOLD` / `_TEXT` | / 0.85 / | 撤回问题的提示词、阈值、固定回复文本 |
| `MODERATION_BAN_PROMPT` / `_THRESHOLD` / `_TEXT` / `_SECONDS` | / 0.9 / / 600 | 禁言的提示词、阈值、固定回复文本、时长（秒） |
| `MODERATION_REPLY_PROMPT` / `_THRESHOLD` / `_TEXT` | / 0.8 / | 回复的提示词、阈值、固定回复文本 |

## 入群欢迎（可选）

当有新成员加入指定群时，机器人 `@` 该成员并发送一条固定文本，不需要任何指令。它与群管理、聊天流程完全独立：不走 decider / DeepSeek，也不写入会话历史或长期记忆，群范围由自己的 `WELCOME_GROUPS` 决定（与 `MODERATION_GROUPS` 无关）。

- 机器人自己被拉进群（入群者就是机器人自己）时不会 `@` 自己、不发言；
- 受管理员 `/启动` `/停止` 约束：`/停止` 期间跳过（日志会记一条跳过信息）。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WELCOME_ENABLED` | false | 是否启用入群欢迎 |
| `WELCOME_GROUPS` | 空 | 生效的群号，逗号分隔 |
| `WELCOME_TEXT` | 空 | 入群欢迎固定文本 |

`WELCOME_ENABLED=true` 时，`WELCOME_GROUPS` / `WELCOME_TEXT` 任一为空都会在**启动时报错退出**，避免静默不发。

## 定时群发（可选）

按一条 cron 表达式，在到点时向一组指定的群各发一条**固定的纯文本**消息，不需要任何指令。它与聊天流程完全独立：不经过 decider / DeepSeek，也不写入会话历史或长期记忆。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SCHEDULE_ENABLED` | false | 是否启用定时群发 |
| `SCHEDULE_CRON` | 空 | cron 表达式，如 `0 8 * * *`（每天 08:00） |
| `SCHEDULE_GROUPS` | 空 | 目标群号，逗号分隔 |
| `SCHEDULE_TEXT` | 空 | 固定文本（只有一条，纯文本，不解析 `@` / 小黄脸） |

说明：

- **时区固定为 `Asia/Shanghai`**，按北京时间写 cron（不开放时区配置）。
- 受管理员 `/启动` `/停止` 约束：`/停止` 期间到点会被跳过（日志会记一条跳过信息），`/启动` 后恢复。
- 发送复用 NapCat 客户端的串行节流（`NAPCAT_SEND_INTERVAL_MS`），多群发送不会瞬时爆发；某个群发送失败只记日志，不影响其它群。
- `SCHEDULE_ENABLED=true` 时，`SCHEDULE_CRON` / `SCHEDULE_GROUPS` / `SCHEDULE_TEXT` 任一为空、或 cron 表达式非法，都会在**启动时报错退出**，避免静默不发。

## 定时执行命令（可选）

按 cron 在本机执行 **shell 命令**，可配多条，每条自带一个 cron。与聊天流程完全独立：不发消息、不经过 decider / DeepSeek，也不写入会话历史或长期记忆；**不受 `/启动` `/停止` 约束**（系统级任务，与 bot 是否参与聊天无关）。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `EXEC_ENABLED` | false | 是否启用 |
| `EXEC_<n>_CRON` | 空 | 第 n 条命令的 cron（如 `0 8 * * *`，每天 08:00） |
| `EXEC_<n>_SHELL` | 空 | 第 n 条命令的 shell 命令串（经 `/bin/sh`，可用管道） |
| `EXEC_TIMEOUT_MS` | 60000 | 单条命令执行超时，超时即终止子进程 |
| `EXEC_MAX_OUTPUT_CHARS` | 2000 | 日志里每条命令 stdout/stderr 的截断上限 |

说明：

- 编号 `n` 从 1 起，**允许跳号**（组装时按编号升序）；`EXEC_<n>_CRON` 与 `EXEC_<n>_SHELL` 必须成对。
- **时区固定为 `Asia/Shanghai`**，按北京时间写 cron（与定时群发一致）。
- 命令继承 bot 进程的环境变量与工作目录（进程 cwd）。
- 到点执行时按结果写日志：开始（含完整命令）、成功、失败（退出码/信号）、超时、输出过大、重叠跳过，输出超限会注明原始字符数。
- 每条命令有重叠守卫：上一次仍在执行时本次跳过并记日志，避免长命令堆叠。
- `EXEC_ENABLED=true` 时，任务数为 0、任一条成对变量缺一、或 cron 表达式非法，都会在**启动时报错退出**，避免静默不执行。

## 项目结构

```text
src/
├── index.ts              启动、依赖组装
├── config.ts             环境变量
├── proxy.ts              网络代理（PROXY_URL）
├── napcat/               WS 客户端、OneBot 类型、消息段渲染、QQ 表情表
├── schedule/
│   └── scheduler.ts      定时群发：按 cron 向指定群发固定文本（含共用的 createCronJob / 时区）
├── exec/
│   └── cron-exec.ts      定时执行本地 shell 命令（多条，只写日志）
├── chat/
│   ├── runtime.ts        会话：防抖、判断、回复、发送、触发记忆整理
│   ├── gate.ts           decider 问题与阈值、无 decider 时的兜底
│   ├── reply.ts          提示词、输出解析（文字行 / 表情包）、分条或合并转发
│   ├── stickers.ts       表情包收藏、识图描述、重发（淘汰转入归档，重现免识图）
│   ├── images.ts         普通图片识图
│   ├── files.ts          聊天文件下载后端（解析地址 + 流式取字节）
│   ├── archive.ts        压缩包纯逻辑：类型/条目名净化/限额/目录命名/清单/清理挑选
│   ├── materials.ts      压缩包物料化编排：下载、解压、转码、原子落盘、缓存、清理
│   ├── extract-zip.ts    zip 解压驱动（yauzl，逐条流式）
│   ├── extract-rar.ts    rar 解压驱动（node-unrar-js，先预检再解压）
│   ├── decode.ts         文本字节的多编码严格解码（BOM + UTF-8/GB18030/…）
│   ├── media.ts          图片下载、格式识别、描述清理
│   ├── memory.ts         长期记忆
│   └── history.ts        会话消息记录
├── moderation/
│   └── moderation.ts     群管理：decider 三问（撤回/禁言/回复）
├── welcome/
│   └── welcome.ts        入群欢迎：@ 新成员发固定文本（独立旁路）
├── decider/
│   ├── questions.ts      判定输入/问题的类型与 noul 构造
│   └── client.ts         通用判定请求（POST state + questions）
├── llm/
│   ├── deepseek.ts       回复模型 deepseek-flash：工具循环、JSON（失败重试一次）
│   └── vision.ts         图像识别后端（写死 SiliconFlow deepseek-ai/DeepSeek-OCR）
├── search/               MCP 联网搜索客户端
├── opencode/             只读 OpenCode（ACP）：进程编排、子进程环境（代理 + 只读加固）、目录选择、模型选择、权限裁决
└── cli/learn-history.ts  从历史记录补学记忆
```

## 开发

```bash
pnpm dev         # tsx watch
pnpm test        # node:test，不读本地 .env
pnpm typecheck
```

## 注意

- NapCat 属于非官方客户端，QQ 账号有被风控的风险，建议用小号。
- 联网搜索依赖外部 MCP 服务器（streamable HTTP）的可用性；它挂掉的期间搜索暂不挂载，之后按指数退避自动重连、成功后自动恢复，无需重启。
- 记忆和表情包描述会把群友的发言交给 DeepSeek 处理，图片/表情包也会交给图像识别服务（SiliconFlow）处理，请在群里告知大家。
- 启用只读 OpenCode 后，白名单群 / 私聊里的消息都可能驱动它读取 `OPENCODE_CWD` / `OPENCODE_DIRS` 里任一仓库的内容并转发到会话里；只读约束挡的是改动与执行，挡不住信息外泄，请自行评估仓库敏感度。

## 致谢

- [NapCatQQ](https://github.com/NapNeko/NapCatQQ)：OneBot 协议端
- [MaiBot](https://github.com/Mai-with-u/MaiBot)：回复时机、表情包、人物记忆的思路
- [OvO](https://github.com/Mist-wu/OvO)：NapCat 正向 WebSocket 客户端
- [Model Context Protocol](https://modelcontextprotocol.io)：联网搜索接入
- [Perplexity](https://docs.perplexity.ai)：decider 的默认判定后端（Decisions API）

## License

[MIT](LICENSE)
