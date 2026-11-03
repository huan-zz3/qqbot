/**
 * 供运行时/回复层使用的 agent-client 接口（不依赖 server.ts 的具体实现）。
 *
 * 单独放一个文件是为了让 `chat/runtime.ts`、`chat/reply.ts` 只依赖这两个方法，
 * 不必把 TCP/MCP/静态服务都拖进类型依赖里。
 */
export type AgentClient = {
  /** 给 opencode 注入用：码存在且在宽限期内返回 ok；否则给模型可读的错误文本。 */
  resolveForOpencode(code: string): { ok: true } | { ok: false; message: string };
  /** send_client 用：NapCat 容器能取到的 http URL 与文件名。 */
  fileUrl(): string;
  fileName(): string;
};
