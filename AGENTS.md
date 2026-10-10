# qqbot Agent Notes

- TypeScript QQ bot. NapCat OneBot v11 正向 WebSocket（NapCat 是服务端，bot 是客户端），参考 Mist-wu/OvO。
- jev（TypeSafe AI，`@typesafe-ai/sdk`）决定该不该发言、以及（`needs_search > 0.1` 这么低的门槛）要不要给模型挂上 `web_search`；DeepSeek 写回复并决定是否真的搜索。只用 `deepseek-flash`（`DEEPSEEK_MODEL`，硬编码）——不要加别的模型或降级。
- 联网搜索只用 Codex（ChatGPT OAuth）凭证走 `codex/alpha/search`，做法照抄 `pi-extensions/websearch`。
- 个人项目：模块小且可读，优先 `type`，注释从简。
- 完整文档（中文）在 `README.md`；本文件只记 agent 容易踩的、不易从文件名看出的点。

## 命令

- `pnpm test` — `tsx --test tests/*.test.ts`，用 Node 内置 `node:test`（无测试框架）。跑单个文件：`pnpm exec tsx --test tests/gate.test.ts`。
- `pnpm typecheck` — `tsc --noEmit`。`tsconfig.json` 的 `include` 只有 `src`，**tests/ 不被类型检查**。
- `pnpm dev`（tsx watch）/ `pnpm build`（`tsc` → `dist/`）/ `pnpm start`（`node dist/index.js`）。
- `pnpm learn-history [条数]` — 停掉 bot 后从 NapCat 历史补学记忆（需先 `pnpm build`）。
- 没有 linter / formatter 配置，不要假设有 `lint` 步骤。

## 容易踩的坑

- **`config.ts` 在 import 时就把 `process.env` 读进 `config` 常量**（含 `dotenv.config()`）。改 env 必须在 import 之前；测试因此先在顶部 `process.env.X = ...`，再用 `await import("../src/chat/gate.js")` 动态引入被测模块（见 `tests/gate.test.ts`）。`pnpm test` 下 `NODE_TEST_CONTEXT` 被置位，故意不读本地 `.env`。
- ESM + `NodeNext`：**import 必须带 `.js` 后缀**（`import { config } from "./config.js"`），即使源文件是 `.ts`。
- 挂了工具时，DeepSeek 要求把前序 assistant 回合的 `reasoning_content` 原样回传，否则 400（`llm/deepseek.ts` 的 `chatWithTools`）。
- bot 只存同步过来的 Codex **access token，没有 refresh token，从不刷新**：refresh token 每次轮换，本机 pi 持有它。token 过期搜索自动停用，重新同步即可，无需重启。
- @/回复 bot 只是给 jev **降低阈值**的提示，不是强制回复（`gate.ts` `decide`）。
- 聊天记录写成 `说话人 → 对象：正文（引用 某人的「原文」）`（`history.ts` `formatLine`/`relation`）；jev 输入、回复提示词、记忆提示词必须保持同一格式。
- 提示词只给事实，不给规则或示例句：不写长度/语气要求，不放例句（模型会照抄）（`reply.ts` `buildSystemPrompt`）。
- 模型输出约定：`[不回复]`（`SKIP_MARKER`）表示不说；`[表情包#编号]` 单独一行发收藏表情；收到的图片显示为 `[图片：描述]`，QQ 小黄脸显示/收发按 `[名称]`（名字表在 `napcat/faces.ts`）。回复里写的 `@名字` 会发成真 @。

## 目录

- `src/index.ts` 启动、依赖组装；`src/config.ts` 环境变量（`str`/`num`/`bool`/`list` 助手）。
- `src/napcat/` WS 客户端、OneBot 类型、消息段渲染、QQ 表情表。
- `src/chat/gate.ts` jev 问题与阈值、无 jev 兜底；`runtime.ts` 会话防抖/判断/回复/发送/触发记忆。
- `src/chat/reply.ts` 提示词、输出解析、分条或合并转发；`stickers.ts`/`images.ts`/`media.ts` 表情包与图片。
- `src/chat/memory.ts` 长期记忆（群/私聊分开，按 QQ 号）；`power.ts` 管理员 `/启动` `/停止`（持久化）；`history.ts` 会话消息记录。
- `src/llm/deepseek.ts` deepseek-flash 工具循环、识图、JSON（失败重试一次）。
- `src/search/` Codex access token（只读、过期重读）与 web_search；`src/cli/learn-history.ts` 历史补学。
- `deploy/` systemd unit、`sync-codex-auth.sh`（只同步 access token）。

## 约定

- `data/` 是运行时状态（`state.json`、`memory.json`、`stickers/`、`codex-auth.json`），已被 `.gitignore` 忽略，**不要提交或公开**（含群友个人信息）。
- 代码用 `type` 而非 `interface`；模块保持小而单一。
