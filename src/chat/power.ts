/**
 * power.ts —— 管理员 /启动 /停止 开关，决定 bot 是否参与聊天。
 *
 * 状态持久化在 state.json（{"on": boolean}），由管理员在私聊发指令切换；
 * 进程本身不会退出，/停止 只是让各流程跳过判断与回复，随时可再 /启动。
 * 写入用「临时文件 + rename」原子替换，文件权限 0o600。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 全局电源开关：on 为 true 时 bot 正常参与聊天，false 时各会话流程跳过。
 * 由管理员私聊指令 /启动 /停止 切换，并持久化到 state.json，重启后保持。
 */
export class PowerSwitch {
  // 默认开启；load() 读到持久化状态后以其为准
  private enabled = true;

  /** @param file state.json 路径（通常为 data/state.json）。 */
  constructor(private readonly file: string) {}

  /** 当前是否启用；各消息处理流程据此决定是否跳过。 */
  get on(): boolean {
    return this.enabled;
  }

  /** 启动时调用一次：读取持久化开关；文件不存在（首次运行）保持默认开启。 */
  async load(): Promise<void> {
    try {
      const state = JSON.parse(await readFile(this.file, "utf8")) as { on?: unknown };
      // 只有显式存过 false 才算关闭；字段缺失或旧格式一律按开启处理
      this.enabled = state.on !== false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  /** 切换开关并立即持久化（管理员指令触发）；写临时文件再 rename，避免写一半留下损坏的 JSON。 */
  async set(on: boolean): Promise<void> {
    this.enabled = on;
    await mkdir(dirname(this.file), { recursive: true });
    // 带进程号避免与残留临时文件互相覆盖；0o600 仅属主可读写
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ on }), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
