# 远程排查客户端：批量执行设计

2026-11-04 · 协议 v2

## 意图

现状是**一次 MCP 工具调用只能带一条 psh 命令或一次文件读取**。真实排查（`systeminfo` + 服务状态 + 3 个事件日志）只能让模型来回 N 次，每次都付一次 MCP 往返、一次 opencode 推理轮、若干 token。

改成：**一次调用下发一批混合项（psh + 读文件），客户端按序串行执行、按序回包，服务端编号排版后交给 opencode**。整轮只花一次往返。

不碰的东西（已确认）：只读加固、配对码/宽限/重连、传输加密、`directory` 仓库短名（里面是被参考的游戏源码）、读日志仍归 psh。

## 目标

- 模型一次调用可下发 1–16 项，`psh` 与 `read` 可混排，顺序即执行顺序即结果顺序。
- 整批共用**一个**超时预算；预算耗尽后剩余项明确标"未执行"，不静默丢。
- 每项结果独立成败；部分失败不污染整批。
- 客户端窗口逐条可见（运行者唯一的审计手段）。
- 旧 exe 直接拒绝，不做兼容分支。

## 非目标

- 不做批内并行（顺序与审计清晰优先）。
- 不改 `run_psh` / `read_file` 单条工具的任何语义与形状。
- 不给回复模型新增远端工具：远端仍只在 opencode 后面。
- 不改 MCP `timeout.execution`、ACP 三道闸、`AGENT_CLIENT_CALL_TIMEOUT_MS`。
- 不改 `.env`（`AGENT_CLIENT_MAX_OUTPUT_CHARS=1000000` 由用户自行改小）。

## 反目标

- 批量把失败伪装成"查不到"。
- 一批里静默丢掉部分项。
- 整批大输出无上限地灌进 opencode 的上下文。

## 决策

| # | 决策 | 取值 | 理由 |
| --- | --- | --- | --- |
| Q1 | 工具面 | 新增 `run_batch`，参数 `items: [{type:"psh",command,timeout_ms?} \| {type:"read",path,max_bytes?}]`；保留现有两个单条工具 | 真实动作就是"5 条命令 + 2 个日志"混在一起，单列一个数组保序；单条路径已验证，不动 |
| Q2 | 执行语义 | 严格串行保序；单条失败继续；每项独立 ok/error | 只读排查里"文件不存在/无权限"是常态，一条失败不该吞掉其余 |
| Q3 | 超时 | 整批一个 deadline（沿用 `AGENT_CLIENT_CALL_TIMEOUT_MS`）；每项取 `min(自身 timeout_ms, 剩余预算)`；耗尽后剩余项"未执行" | 每项独立 60s 会把上界推到 300s，越过 ACP 总墙钟 240s，要同时改三层才自洽 |
| Q4 | 输出 | 每项按 `maxOutputChars` 截断；服务端整批上限 `4 × maxOutputChars` | 不允许凭空常量；整批上限纯从已配置的单条上限派生 |
| Q5 | 协议 | `v = 2`；旧 exe 握手即拒并提示重新下载 | 无兼容分支；文件名带版本号才能分辨手里是哪一份 |
| Q6 | 窗口 | 每条两行带 `[i/N]` 序号，批次开跑前一行摘要 | 序号让"跑了什么"与结果对得上 |
| Q7 | 项数上限 | 16，硬编码常量（服务端校验） | 只挡失控输出，不需要可调旋钮 |
| Q8 | 线形 | 一帧 `run_batch`，带 `budget_ms` 与 `max_total_chars`；客户端复用现有 `runPsh`/`readFile` | 拆成 N 个现有帧等于没解决"一次调用"，且各自计时会让总时长失控 |
| Q9 | 总闸位置 | 客户端逐项截断 + 服务端按项累加整批截断（只在项边界切） | 沿用"服务端钳位、客户端兜底"；项边界切避免半条结果 |
| Q10 | `.env` | 不动 | 用户手动改 |
| Q11 | 提示 | 工具描述 + `AGENT_CLIENT_PROMPT`（用户粘贴） | 缺任一半模型都会退回单条 |
| Q12 | 验证 | 纯逻辑单测 + Linux Go 客户端 e2e + Windows 真机清单 | 现在的单测只覆盖 crypto/registry，这次正好落在空白上 |
| Q14 | 版本 | exe `0.2.0`，产物 `qqbot-agent-0.2.0-win64.zip` | 协议 v2 直接拒旧端，文件名必须能区分 |
| Q15 | `isError` | 只有"一条都没执行"才是 `true` | 部分失败标 `true` 会让 opencode 把整批结果当工具故障丢掉 |
| Q16 | 输出线缆上界 | 服务端下发 `max_total_chars = 4 × maxOutputChars`，客户端边执行边累计渲染字符，到顶后剩余项标"未展示（整批输出超限）"；先到先得 | 与时间预算同一套语义（一个整批额度、先到先得、超出显式告知），不引入第二套按项数均分的规则；同时让 4× 这个数真正约束线缆，而不是只在服务端渲染时生效 |

## 线协议增量（v2）

契约先改 `.slim/deepwork/agent-client/protocol.md`，两端照着实现。

### 新工具

`tools/list` 增加 `run_batch`。schema 用**一个宽松对象**而不是 `oneOf`（客户端与模型都不擅长 `oneOf`），逐项必填由服务端校验：

```jsonc
{
  "name": "run_batch",
  "inputSchema": {
    "type": "object",
    "properties": {
      "items": {
        "type": "array",
        "minItems": 1,
        "maxItems": 16,
        "items": {
          "type": "object",
          "properties": {
            "type": { "type": "string", "enum": ["psh", "read"] },
            "command": { "type": "string" },
            "timeout_ms": { "type": "number" },
            "path": { "type": "string" },
            "max_bytes": { "type": "number" }
          },
          "required": ["type"]
        }
      }
    },
    "required": ["items"],
    "additionalProperties": false
  }
}
```

描述文案（只给事实，不写例句）：一次在群友机器上执行多条命令、读取多个文件；需要多条时全部放进这一次调用。

### 工具帧

```jsonc
{"id":"<uuid>","tool":"run_batch","args":{
  "items":[…服务端钳位后的项…],
  "budget_ms":59000,
  "max_total_chars":80000
}}
```

- `budget_ms = max(1000, callTimeoutMs - 1000)`：给回包留 1 秒，避免客户端跑完最后一项时服务端已经超时。
- 客户端从**收到这一帧**起计时。启动下一项前若剩余不足 `killGrace(5000) + 1000` 毫秒，后续项全部不执行，结果标 `未执行（批次预算耗尽）`。
- 每项实际超时取 `min(该次下发值, 剩余预算 - killGrace)`，且不低于 1000ms。**必须扣掉 `killGrace`**：`runPsh` 超时后还要等 `taskkill` 生效（最多 5s），不扣的话最后一项会越过后端 60s 计时器，服务端先报超时、把已经跑完的整批结果当迟到回包丢掉。
- `max_total_chars = 4 × maxOutputChars`：客户端边执行边累计**已渲染字符**（stdout + stderr + 文件正文），到顶后不再执行/不再输出后续项，标 `未展示（整批输出超限）`。先到先得；一个大 `read` 可以把整批额度吃掉，这个代价换来的是"一个整批额度"这一条规则，而不是再按项数均分。

### 回包

```jsonc
{"id":"<uuid>","ok":true,"result":{"items":[
  {"ok":true,"result":{/* 与 run_psh 完全相同的字段 */}},
  {"ok":true,"result":{/* 与 read_file 完全相同的字段 */}},
  {"ok":false,"error":"文件不存在：C:\\x.log"}
]}}
```

- `items` 长度与请求一致、顺序一致；未执行的项也是 `{"ok":false,"error":"未执行（批次预算耗尽）"}` 或 `{"ok":false,"error":"未展示（整批输出超限）"}`。
- 单项结果字段逐字复用两个单条工具的形状，客户端只在最外层包 `ok`。
- 回包体积由 `max_total_chars` 约束（最坏 4 × `maxOutputChars`），远低于两端 64 MiB 的帧上限。
- **不设批级 `truncated`**：每项结果自带 `truncated`，再加一个批级字段只会产生互相矛盾的信号（Q8 里那条批级字段就此取消）。

### 校验与失败

| 情况 | 处理 |
| --- | --- |
| `items` 非数组 / 空 / 超过 16 | 不转发，MCP 回 `isError=true` + 可读文本 |
| 某项缺 `type` 或类型未知 | 该项 `ok:false`（"未知指令类型：x，应为 psh 或 read"），其余照跑 |
| `psh` 缺 `command` / `read` 缺 `path` | 同上，该项失败，其余照跑 |
| 码不存在 / 宽限期内 / 未 verified | 既有文案，`isError=true`（一条都没执行） |
| 整批超时（服务端 60s 到点） | 既有超时文案，`isError=true` |

### 心跳

批量执行期间客户端 `readLoop` 仍是独立 goroutine，照常回 `pong`，不会被 45s 静默判死；服务端 `ping` 也照常发。两端都不需要额外改动。

## 服务端改动（TS）

| 文件 | 改动 |
| --- | --- |
| `src/agent-client/batch.ts`（新） | 纯逻辑：逐项钳位（`timeout_ms` → `[1000, pshTimeoutMs]`，`max_bytes` → `[1024, max(4×maxOutputChars, 64KiB)]`）、`items` 结构校验、`budget_ms` 计算、结果聚合排版与整批截断（只在项边界切）。全部可单测，不碰 socket |
| `src/agent-client/tools.ts` | `TOOL_DEFINITIONS` 增加 `run_batch`；`isToolName` 扩展；`handleToolCall` 增加批量分支（复用 `formatPsh`/`formatReadFile` 的排版）；`isError` 规则按 Q15 |
| `src/agent-client/server.ts` | `clampArgs` 改走 `batch.ts`；下发时算 `budget_ms`；转发仍走既有 `enqueueCall`（一帧、一个 60s timer） |

聚合排版（给 opencode 看的文本）：

```
[1/5] run_psh  Get-Process
exit=0
stdout:
…
[2/5] read_file  C:\Users\me\AppData\Local\app\a.log
<文件正文>
（编码 utf-16le；共 12345 字节）
[3/5] run_psh  Get-Service
失败：…
（第 4 项起未展示：整批输出超过上限 80000 字符）
```

- 头部 `[i/N] 工具名 目标`：命令压成一行、截 60 字符（与日志里的 `summarize` 同思路）。
- 整批截断后追加一行说明，写明上限数值与实际从第几项起未展示。

## 客户端改动（Go）

| 文件 | 改动 |
| --- | --- |
| `client-go/tools.go` | 新增 `batchArgs`/`batchItem`；`handleBatch` 按序调用现有 `runPsh`/`readFile`（编码、`limitedBuffer`、`taskkill` 全部复用）；预算计时与"未执行"标记；单条执行器以函数参数注入，便于无 PowerShell 的单测 |
| `client-go/session.go` | `handleTool` 增加 `run_batch` 分支；`protocolVersion = 2` |
| `client-go/main.go` | `ui.toolCall/toolResult` 支持序号前缀；批次开跑前一行"批次：N 条" |

窗口示意：

```
14:22:31 批次：5 条
14:22:31 [1/5] run_psh   Get-Process
14:22:32       └ 完成：退出码 0，stdout 1.2 KB，stderr 0 B
14:22:32 [2/5] read_file C:\Users\me\AppData\Local\app\a.log
14:22:32       └ 完成：12.1 KB（12345 字节，utf-16le）
```

## 构建者已裁决的细节

这几条原本是要"猜"的地方，按下面的口径实现；不同意就现在说。

| 问题 | 裁决 | 理由 |
| --- | --- | --- |
| 校验归属 | **服务端逐项校验**：非法项就地生成失败结果、不下发；下发的项保证结构合法；回包按下发顺序返回，服务端按原始索引合并。客户端仍对未知 `type` 回可读错误（防御而非主路径） | 校验只有一处权威；客户端保留防御是因为它是一条对外端口，不该因畸形帧崩掉 |
| 全部项结构非法时的 `isError` | 只要**没有任何一条被下发执行**（码不可兑付、items 非法、整批超时、全部项结构非法）就 `true`；否则 `false` | "一条都没执行"与"有失败但拿了部分数据"必须区分，否则 opencode 要么漏错误要么丢结果 |
| 客户端版本号 | `build-client.sh` 里独立常量 `AGENT_CLIENT_VERSION`（本次 `0.2.0`），**不动 `package.json`** | 客户端版本与 bot 版本没有对应关系；兼容判定已由协议 `v` 承担 |
| e2e 的 psh 覆盖 | Linux 上没有 `powershell`，e2e 只验帧序、多次往返、v1 被拒、错误隔离、`未执行` 标记；预算耗尽与窗口排版由注入执行器的 Go 单测覆盖 | 不在发行二进制里留测试钩子 |
| 批内单项失败 | 继续执行后续项，失败项只带 `error` 文本 | 与 Q2 一致；不引入"遇到某类错误降级"的特例 |

## 分发

- `scripts/build-client.sh` 的 `AGENT_CLIENT_VERSION` 设为 `0.2.0` → `data/agent-client/qqbot-agent-0.2.0-win64.zip`（`package.json` 不动）。
- `.env.example` 的 `AGENT_CLIENT_FILE` 与说明同步；用户自己的 `.env` 由他改。
- `AGENT_CLIENT_PROMPT` 建议追加一句（用户粘贴）：

  > 需要多条命令或多个文件时，用 run_batch 一次发出去（最多 16 条），不要逐条调用 run_psh / read_file。

- 旧 zip 留着不删，但服务端只服务 `.env` 指向的那一份。

## 验证

| 层 | 内容 |
| --- | --- |
| TS 单测（`tests/agent-client-batch.test.ts`） | 逐项钳位上下界、`items` 上限/空/非数组、`budget_ms` 与 `max_total_chars` 公式、聚合排版、只在项边界截断、`isError` 三态（全部失败/部分失败/未下发） |
| Go 单测（`client-go/batch_test.go`） | 顺序保序、单项失败继续、预算耗尽"未执行"、输出累计到顶"未展示"、未知 type、16 上限、执行器注入 |
| e2e | Linux 编译的 Go 客户端 ↔ 真服务端 ↔ 假 MCP 调用方：一次往返跑完混合批量、帧序与编号对得上、错误隔离、v1 客户端被握手拒绝并提示重新下载（Linux 无 `powershell`，故 psh 项只验失败隔离，不验长耗时） |
| Windows 真机（用户） | 解压运行、批次窗口显示、`taskkill /F /T`、SmartScreen、frp 链路、QQ 传包 |

## 风险与已知取舍

- **一批慢命令会吃满预算**，后面的项"未执行"。这是有意的：预算可预测优于跑不完；只读命令通常 <1s。
- **整批上限是 4×单条上限**：`.env` 现在是 1000000 时等于 4MB，用户改小后自动收紧；上限跟着配置走，不是隐藏常量，同时也约束了回包体积。
- **一个大 `read` 能吃掉整批输出额度**（先到先得）。代价是这一批后续项"未展示"，模型能看见提示并单独重问；换来的是只保留"一个整批额度"这一条规则。
- **仍未在 Windows 真机验证过任何一轮**（frp、SmartScreen、QQ 传包都未验证）；这次改动会一并让旧 exe 失效，必须先重编再分发。
- 批量让 opencode 内部轮数下降，但**不影响** `OPENCODE_MAX_TOOL_ROUNDS`（那是回复模型对 opencode 的轮数）。

## 留给构建者

字段命名细节、聚合排版的措辞与缩进、Go 侧执行器注入的具体形状、窗口列宽对齐、单测切分粒度。
