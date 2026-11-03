/**
 * 客户端压缩包的只读静态服务。
 *
 * 为什么需要它：NapCat 跑在 Docker 里，容器看不到宿主机路径，`upload_*_file` 只能吃 URL；
 * 所以 bot 自己起一个只暴露单一文件的小服务，让 NapCat 从容器内下载。
 * 只认 `GET/HEAD /<basename>`，其余路径一律 404——不列目录、不暴露所在目录里的其他文件。
 */
import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename } from "node:path";

import { errorText } from "../errors.js";
import { logger } from "../logger.js";

export type ClientFileServerOptions = {
  /** 绑定地址：NapCat 容器能访问到的宿主机网桥 IP（默认 172.26.0.1）。 */
  host: string;
  port: number;
  /** 唯一允许下载的文件（绝对路径）。 */
  file: string;
};

export class ClientFileServer {
  private readonly file: string;
  private readonly fileName: string;
  private server: Server | undefined;

  constructor(private readonly options: ClientFileServerOptions) {
    this.file = options.file;
    this.fileName = basename(options.file);
  }

  /** 开始监听；绑定失败（端口占用 / 网桥 IP 变了）直接抛出，由 index.ts 退出进程。 */
  async start(): Promise<void> {
    const server = createServer((req, res) => this.handle(req, res));
    server.on("clientError", (error, socket) => {
      logger.warn(`agent-client 文件服务收到非法请求：${errorText(error)}`);
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(new Error(`绑定 ${this.options.host}:${this.options.port} 失败：${errorText(error)}`));
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.port, this.options.host);
    });
    this.server = server;
    logger.info(`agent-client 文件服务已监听 ${this.options.host}:${this.options.port}（/${this.fileName}）`);
  }

  async dispose(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      respondText(res, 405, "只支持 GET/HEAD");
      return;
    }
    // 路径必须等于 /<basename>：任何额外路径、目录穿越都落到 404。
    const raw = (req.url ?? "").split("?")[0] ?? "";
    let path = raw;
    try {
      path = decodeURIComponent(raw);
    } catch {
      // 非法百分号编码按原样比较，肯定不匹配，最终 404。
    }
    if (path !== `/${this.fileName}`) {
      respondText(res, 404, "未找到");
      return;
    }
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch (error) {
      // 文件在运行时被删/移走：如实回 500，不假装下载成功。
      logger.warn(`agent-client 客户端压缩包不可读：${this.file}（${errorText(error)}）`);
      respondText(res, 500, "客户端压缩包不可读");
      return;
    }
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-length": String(size),
      "content-disposition": `attachment; filename="${this.fileName}"`,
    });
    if (method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(this.file);
    stream.on("error", (error) => {
      // 头已经发出，无法改状态码；只能记日志并切断连接，避免 NapCat 收到半个 zip 当成功。
      logger.warn(`agent-client 读取客户端压缩包失败：${errorText(error)}`);
      res.destroy(error);
    });
    stream.pipe(res);
  }
}

function respondText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}
