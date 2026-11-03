# 远程 Agent 客户端（Windows）设计

2026-11-03 · v2（含软件内加密与断线重连）

## 意图

群友说"日志怎么发给你"时，现在只能传压缩包——只能看到静态文件，看不到环境、进程、事件日志这些"机器当下长什么样"。加一个 Windows 单文件客户端：群友运行 → 显示配对码 → 把码交给 opencode → opencode 经 MCP 在群友机器上读文件、跑 PowerShell，实时定位问题。

## 目标

- 群友能拿到一个 Windows x64 压缩包，解压双击即显示配对码，无需安装运行时。
- 配对码交给 opencode 后，opencode 能在那台机器上执行只读排查与 psh 命令。
- 每条远程调用在客户端窗口里可见（运行者自己审计）。
- 网络短暂中断能自动重连并保留原配对码；长时间断联才换码。

## 非目标

- 不做 GUI、托盘、开机自启、自动更新、代码签名。
- 不做鉴权、权限询问、命令白名单（只靠提示词约束——已明确取舍：模型被群聊内容带偏时会真实执行）。
- 不支持 macOS / Linux / 32 位 Windows。
- 不改压缩包流程，两者并存。

## 反目标

- 客户端变成常驻服务，或用户不点开也能被远程执行。
- 调用失败被伪装成"本地没查到"。

## 架构

三段，边界清楚：

```
群友 Windows 客户端 ──裸 TCP(公网,frp)＝AES-GCM 帧──> qqbot: 客户端入口(127.0.0.1:7801)
                                                            │
                                                  配对码注册表（内存）
                                                            │
opencode 子进程 ──MCP over HTTP(127.0.0.1:7802)──> qqbot: MCP server ──转发──> 对应 TCP 连接
```

1. **Windows 客户端（Go，单 exe，控制台程序）**
   启动即拨 `tcp://<公网入口>:<端口>`（经 frp 的 tcp 转发）→ 与服务端做 PSK 握手 → 收到配对码 → 打在窗口顶部 → 循环接收工具调用、本地执行、回包；每条命令实时打印，并区分"执行中/完成/超时"。

2. **qqbot 内的 MCP 服务端（TS）**
   `@modelcontextprotocol/sdk` 的 Streamable HTTP server，**只监听 `127.0.0.1:7802`**。维护 `配对码 → TCP 连接` 注册表，把 MCP 的 `tools/call` 转成帧请求并等待回包。

3. **opencode（现有 ACP 子进程）**
   带配对码的任务由 `opencode/env.ts` 的 `childEnv(pairing)` 覆盖注入（V2 形状；现有六条 deny 原样保留）：

   ```jsonc
   {
     "permissions": [ /* 现有六条 deny 原样保留 */ ],
     "mcp": {
       "servers": {
         "agent": {
           "type": "remote",
           "url": "http://127.0.0.1:7802/mcp",
           "headers": { "X-Pair-Code": "<码>" },
           "codemode": false,
           "timeout": { "catalog": 15000, "execution": 95000 }
         }
       }
     }
   }
   ```

   **`codemode: false` 是显式设置，不依赖 `execute` deny 这条隐式兜底**（实测结论，opencode v2.2.5，探针四轮 A/B/C/D，证据见进度文件）：`execute` 被 deny 时，**即使 `codemode: true`，opencode 也会把 MCP 工具退回原生直挂**——只读加固本身已经能兜住，`codemode` 写 `true` 也不会导致"一个远程工具都调不到"。只有 `execute` 未被 deny 时，`codemode` 才决定走向（此时 `true` 会让模型只看到 `execute` 一个入口）。仍显式写 `false`，是为了不依赖"`execute` 被 deny"这条隐式兜底——将来若放开 `execute`，这里不会跟着失效。工具以原生名字出现（`agent_run_psh` / `agent_read_file`），权限 action 是 `<server>_<tool>`，落在默认 allow 规则上，不需要额外加 allow。

配对码由**服务端生成**（不是客户端自带），避免不同群友撞码。

## 传输与加密

明文 TCP，加密在应用层。**不使用 TLS**，不走 `type = https` 的 frp vhost。

- **PSK**：服务端从 `AGENT_CLIENT_PSK` 读 32 字节 hex；构建 exe 时用 `-ldflags -X` 烧进二进制；日志里永不打印。
- **握手（两段式：先证 PSK，再交换码与凭证）**：
  明文只交换版本与 16 字节 nonce：客户端 → `{v:1, kind:"hello", nonce:<16B>}`，服务端 → `{v:1, kind:"hello-ack", nonce:<16B>}`；版本 / kind / nonce 非法则改发明文 `{v:1, kind:"error", message, retry}` 后关闭。
  双方 nonce 拼接作为 HKDF-SHA256(psk, salt, info="qqbot-agent/v1") 的输入，派生 32 字节会话密钥。
  此后全部密文：服务端 → `{kind:"ready"}`（服务端证明自己持有 PSK），客户端 → `{kind:"open"}`（重连时带 `{code, token}`），服务端 → `{kind:"paired", code, token}` 或 `{kind:"error", message, retry}`。**token 从不出现在任何明文帧里**；收到合法 `open` 才注册 / 恢复配对码并置 `verified`（`open` 也是客户端持有 PSK 的证明）。
- **帧**：`4 字节大端长度 + 载荷`；握手后每帧载荷 = `12 字节随机 nonce + AES-256-GCM 密文`。单帧上限 64MB（防止对端一个长度头就把内存吃光）。
- **版本不匹配**（exe 与 bot 的 `v` 不同）→ 明确报错并要求重发 exe，不做兼容分支。

## 安全边界（记录，不实现拦截）

- 公网只暴露"客户端拨入"这一条 TCP（经 frp）；MCP 与静态文件服务只听本机/容器可及的地址。
- **PSK 会随 exe 一起被下载**，所以这层加密的真实效果是：挡住链路上不持有 exe 的旁观者，挡不住能拿到 exe 的人做主动 MITM，也挡不住任何人自己跑一个客户端。设计如实标注，不宣称"安全通信"。
- 配对码在群里公开泄露无害：外部连不进 MCP，码只对 bot 自身可兑付。
- 码贴到哪个会话，哪个会话（含群里所有人）就能驱动那台机器——这是"不做鉴权"的直接后果，不做跨会话绑定。换会话就重开客户端拿新码。
- 危险面在于**运行者自己**：模型会在他的机器上真实执行 psh。缓解只有"客户端窗口逐条显示"，这是运行者的人肉审计。

## 工具面（2 个，越少越好）

- `run_psh(command, timeout_ms?)` → `{exit, stdout, stderr, timedOut, truncated}`。执行 `powershell -NoProfile -NonInteractive -Command <command>`，输出按 `AGENT_CLIENT_MAX_OUTPUT_CHARS` 截断并注明原始长度。
- `read_file(path, max_bytes?)` → 文件文本。为什么不让模型拿 psh 读：Windows 路径 + 引号 + 编码三件事叠在一起，模型极易拼错；读日志是主路径，值得一个专用工具。解码**BOM 优先**：`FF FE` → UTF-16LE、`FE FF` → UTF-16BE、`EF BB BF` → UTF-8（剥 BOM）；无 BOM 时先严格试 UTF-8，失败按 GB18030。PowerShell 5.1 的 `Out-File` 默认写 UTF-16LE+BOM，直接按 GB18030 会变成"成功返回乱码"。

两个工具都由客户端本地实现；服务端只做转发与截断。

## 配对码、重连与生命周期

- 服务端在收到合法 `open` 后才生成 / 恢复 **8 位数字码**（唯一性检查）+ **32 字节 resumeToken**；码与 token 都在密文 `paired` 帧里下发，客户端只把 token 留在内存；重连时客户端在密文 `open` 里带 `{code, token}` 认领原码。
- 有效期 = 连接存续 + **宽限期 `AGENT_CLIENT_CODE_GRACE_MS`（默认 60000）**。
- **断线重连**：TCP 断开后服务端把码标为 `offline` 并保留 60 秒；客户端每 2s 重试（退避到 10s），握手时带 `{code, token}` 认领回原码，窗口显示"已断线，重连中…"。重连成功 → 码不变，`offline` 清除。
- **宽限期内被调用**：立即返回"客户端已断线、正在重连（剩余 N 秒）"，不排队、不等待。
- **超过宽限期**：服务端注销该码；客户端重试失败后新建连接、拿新码，窗口提示"配对码已更新，请重新发给 bot"。
- **在线客户端名额（默认 3）按在线连接计**，超出直接拒绝握手（error 帧 `retry: true`，客户端退避重试）。宽限期内的 `offline` 条目不占名额——否则静默断链会把名额永久占满。尚未收到合法 `open` 的连接（明文两帧已交换但没发 `open`）**不注册码、不占名额**，只占一条 TCP 连接，由 10s 握手闸关闭；它同样**不可兑付**——`verified` 在收到合法 `open` 时才置位，`resolveForOpencode` 与 `forward` 都要求它。
- 服务端 MCP 用 **stateless** 模式（不生成 MCP 会话 id、不开 GET SSE）：每个 POST 只靠 `X-Pair-Code` 头查连接，避免"MCP 会话与 TCP 连接对不上"的状态机。
- 同一条 TCP 上可能有两个 opencode 子进程并发：客户端单线程串行执行，响应按请求 id 回包。
- 客户端进程退出（Ctrl+C / 关窗口）→ 连接断开，60 秒后码彻底失效。

## 超时预算（四层必须对齐）

| 层 | 值 | 说明 |
| --- | --- | --- |
| 客户端 psh | `AGENT_CLIENT_PSH_TIMEOUT_MS`（默认 60000） | 到点 `taskkill /F /T /PID` 杀进程树 |
| 服务端一次调用 | `AGENT_CLIENT_CALL_TIMEOUT_MS`（默认 90000） | 必须大于 psh 超时，否则服务端先超时、客户端还在跑 |
| opencode MCP `timeout.execution` | CALL + 5000 | 注入配置时按任务算出 |
| ACP 总墙钟（配对任务） | `max(OPENCODE_TIMEOUT_MS, CALL × 3 + 60000)` | 一次远程排查正常有几次来回；不抬这一层，第二条 psh 就会撞上"总超时" |

带配对码的任务还要同时抬高 ACP 空闲超时：`OpencodeAgent` 的 idle 计时只在收到 `session/update` 时重置，一条跑 60 秒的 psh 期间没有任何 update，按现有默认会被判"卡死"杀掉。所以配对任务用 `max(配置的 idle, CALL + 60000)`，只向上取，不影响无配对任务。总墙钟同理用 `max(配置的 total, CALL × 3 + 60000)`——默认 180s 会在第二次远程调用前后就到点，只报"总超时"。

默认配置下的实际生效值：psh 60s / call 90s / `timeout.execution` 95s / idle 150s（`max(60s, 90+60)`）/ total 330s（`max(180s, 90×3+60)`）。

## 集成改动点

| 位置 | 改动 |
| --- | --- |
| `src/agent-client/registry.ts`（新） | 码/token 生成、连接登记、offline 标记与宽限期淘汰（纯逻辑，可单测） |
| `src/agent-client/crypto.ts`（新） | HKDF 派生、AES-GCM 帧加解密、握手报文（纯逻辑，可单测） |
| `src/agent-client/server.ts`（新） | TCP 监听、握手、MCP Streamable HTTP server、请求转发 |
| `src/agent-client/tools.ts`（新） | 两个工具的 schema 与 handler |
| `src/agent-client/file-server.ts`（新） | 给 NapCat 容器取 exe 的极小静态文件服务 |
| `src/opencode/env.ts` | `childEnv(pairing?)`：叠加 `mcp` 条目，仍保留只读加固 |
| `src/opencode/agent.ts` | `run(...)` 增加可选的配对码参数，透传到 `childEnv`；配对任务同时抬高 idle 与总墙钟超时 |
| `src/chat/reply.ts` | `opencode` 工具加可选参数 `client`（配对码）；校验存在性后再 spawn |
| `src/napcat/client.ts` | `sendFile(target, url, name)`：`upload_group_file` / `upload_private_file`，单独放宽 action 超时 |
| `src/chat/reply.ts` | 新工具 `send_client`（无参数）：把客户端压缩包发给当前会话 |
| `client-go/`（新） | Go 源码 + `go.mod`（依赖 `coder/websocket` 不需要，只有 `x/text`） |
| `scripts/build-client.sh`（新） | `GOOS=windows GOARCH=amd64 go build -ldflags "-X main.endpoint=... -X main.psk=..."`，再打 zip |

## 配置（新增 env）

`AGENT_CLIENT_ENABLED`、`AGENT_CLIENT_HOST`（默认 `127.0.0.1`，客户端入口绑定地址）、`AGENT_CLIENT_PORT`（默认 7801）、`AGENT_CLIENT_MCP_PORT`（默认 7802）、`AGENT_CLIENT_PSK`（32 字节 hex）、`AGENT_CLIENT_CODE_GRACE_MS`（默认 60000）、`AGENT_CLIENT_MAX_CLIENTS`（默认 3）、`AGENT_CLIENT_CALL_TIMEOUT_MS`（默认 90000）、`AGENT_CLIENT_PSH_TIMEOUT_MS`（默认 60000）、`AGENT_CLIENT_MAX_OUTPUT_CHARS`（默认 20000）、`AGENT_CLIENT_FILE`（zip 绝对路径）、`AGENT_CLIENT_FILE_HOST`（默认 `172.26.0.1`）、`AGENT_CLIENT_FILE_PORT`（默认 7803）、`AGENT_CLIENT_ENDPOINT`（烧进 exe 的 `tcp://host:port`）。

启用时取值非法（端口非正、PSK 不是 32 字节 hex、文件不存在、endpoint 非 `tcp://`）→ 启动 `exit(1)`，与项目既有风格一致。

## 分发（发文件）

- NapCat 跑在 Docker 里，容器内看不到宿主机的 `/home`（实测只有三条 bind mount，`ls /home` 为不存在），所以**不能传本地绝对路径**。
- NapCat 的 `upload_group_file` / `upload_private_file` 文档只承诺"资源路径或 URL"，实现里会自己下载 http(s) URL（容器实测能通宿主网关 `172.26.0.1`）。
- 因此：bot 起一个只读静态文件服务绑 `AGENT_CLIENT_FILE_HOST:AGENT_CLIENT_FILE_PORT`，只暴露一个文件；`sendFile` 传 `http://172.26.0.1:7803/<file>`。绑不上（docker 网桥 IP 变了）→ 启动即 `exit(1)` 报错。
- 发的是 **zip**（`qqbot-agent-0.1.0-win64.zip`），减少 QQ 对裸 exe 的拦截；`callAction` 全局超时 15s 对上传太短，`sendFile` 用单独超时（120s）。
- 若 QQ 仍拦截，再改成"发公网下载链接"，`sendFile` 签名不变。

## 失败策略

- 码不存在 / 已过宽限期 / 功能未启用 → `opencode` 工具返回可读错误文本，**绝不退化成"本地跑一次 opencode"**（否则会在一台不相干的机器上给出看似有效的结论），不 spawn、不伪造。
- 码存在但 `offline`（宽限期内）→ 返回"客户端已断线、正在重连（剩余 N 秒）"。
- opencode 侧 `timeout.execution` 到点 → 调用方收到 MCP 错误；此时客户端可能仍在跑那条命令，最多跑到自己的 psh 超时。
- 握手 PSK 不匹配 → 服务端发来的密文 `ready` 帧客户端解不开，客户端判定密钥不一致、打印原因后**直接退出（不重连）**——同一份构建的 PSK 不会自己变，重试永远不会成功。
- 心跳 45s 静默（拔网线 / 合盖 / 进程被杀，TCP 收不到 close）→ 服务端把码标为 `offline` 进宽限期，客户端按断线处理并重连；判定依据是"连续 45s 没收到任何可解密帧"，服务端每 20s 发 `ping`、客户端回 `pong`。
- 握手 error 帧的 `retry` 语义：`true` 表示暂时性（在线名额已满），客户端退避后重试；`false` 表示永久性（版本不匹配、token 错误、配对码已注销），客户端丢弃手上的码、重连一次拿新码，本来就没码可丢时才打印原因后退出。
- 错误帧分层，不混用：明文阶段（版本 / kind / nonce 非法）用明文 `{v:1, kind:"error", message, retry}`；派生会话密钥之后的任何失败（`ready` 之后、`open` 解析失败、token 失效、名额已满等）一律用密文 `{"kind":"error", message, retry}`。
- 静态文件服务或 MCP 端口绑定失败 → 启动 `exit(1)`。

## 验证

- **探针（实施第一步，先于其它代码）**：用最小 MCP server + `codemode: false` 的远程配置跑一次 opencode 任务，确认 ①工具以 `agent_*` 原生名出现 ②权限默认 allow、不弹 `ask`（`agent.ts` 的 `decidePermission` 一律拒绝 ask）③`timeout.execution` 生效。
- 纯逻辑单测：码/token 生成唯一性、宽限期淘汰、并发上限、HKDF+GCM 往返与篡改检测、输出截断（`tests/agent-client*.test.ts`）。
- 心跳与静默检测、UTF-16 BOM 解码、参数钳位现在都有自动化或实测覆盖：Go 侧 `client-go/control_test.go`（静默超时判为可重连）、`client-go/tools_test.go`（UTF-16LE/BE、`max_bytes` 与 `timeout_ms` 钳位）、TS 侧 `tests/decode.test.ts`（BOM 优先）；服务端转发的参数钳位由 `server.ts` 的 `clampArgs` 统一做，客户端再本地兜底。
- 真机验证需要一台 Windows：解压运行、读一个日志文件、跑一条 psh、拔网线看重连与换码。这一步需要你或群友配合。

## 留给构建者

帧内 JSON 字段命名、控制台输出排版、Go 侧日志（只打控制台，不落盘）、MCP server 名称（固定 `agent`）。
