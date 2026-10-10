/**
 * client.ts —— NapCat（OneBot v11）WebSocket 客户端
 * NapCat 是 WS 服务端，bot 作为客户端连接正向 WebSocket。本类负责：
 * - 连接生命周期：connect / shutdown / 断线自动重连 / ping-pong 心跳（超时 terminate）；
 * - action 调用：callAction 发送 {action, params, echo}，用随机 echo 把响应匹配回调用方，
 *   超时或连接断开时 reject；
 * - 事件派发：onRaw 解析入站 JSON——带 echo 的是 action 响应，带 post_type 的是事件，
 *   事件交给构造时传入的 onEvent 回调；
 * - 发送节流：发送类方法（sendMessage/sendForward）全部经 enqueue 串行化并保持最小间隔，
 *   避免回复分条连发触发 QQ 风控；callAction 本身不经过节流。
 * 依赖 config.napcat（url/token/超时/间隔）与 logger。
 */

import { randomUUID } from "node:crypto";

import WebSocket from "ws";

import { config } from "../config.js";
import { logger } from "../logger.js";
import type { ActionResponse, OneBotEvent, Segment } from "./types.js";

/** 一次在途 action 调用的状态：响应到达（或超时/断线）时用它结算 Promise。 */
type Pending = {
  resolve: (response: ActionResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  action: string;
};

/** 发送目标：群聊给 groupId、私聊给 userId，两者恰有其一（用可选 undefined 构成互斥联合）。 */
export type SendTarget = { groupId: number; userId?: undefined } | { userId: number; groupId?: undefined };

export class NapcatClient {
  /** 登录账号 QQ 号；连接后由 get_login_info 与事件里的 self_id 填充，未知时 undefined。 */
  selfId: number | undefined;

  // 当前 WebSocket；重连间隙为 null。
  private ws: WebSocket | null = null;
  // echo → 在途调用；收到响应或超时后删除，防止无限堆积。
  private pending = new Map<string, Pending>();
  // 重连定时器；非 null 表示已排期（据此去重，避免连接反复失败时排多个）。
  private reconnectTimer: NodeJS.Timeout | null = null;
  // 心跳定时器句柄。
  private heartbeatTimer: NodeJS.Timeout | null = null;
  // 最近一次收到 pong 的时间；心跳据此判断对端假死。
  private lastPongAt = Date.now();
  // 主动关停标记：置位后不再建连、不再重连。
  private shuttingDown = false;
  // 发送串行链：新发送挂在链尾依次执行（配合最小间隔）。
  private sendChain: Promise<unknown> = Promise.resolve();
  // 上一次发送的发起时间戳，用于计算到下一发的等待时间。
  private lastSendAt = 0;

  /**
   * @param onEvent 事件回调：每条入站事件（非 action 响应）都会调用；
   *   回调抛出的异常被 onRaw 捕获记录，不会中断后续消息处理。
   */
  constructor(private readonly onEvent: (event: OneBotEvent) => void) {}

  /** 发起一次连接：配上认证头、挂载各事件回调；重连由 close 回调触发 scheduleReconnect 驱动。 */
  connect(): void {
    // 已主动关停：不再建新连接。
    if (this.shuttingDown) return;
    const headers: Record<string, string> = {};
    // NapCat 的 WS 服务端 token 走 Authorization: Bearer。
    if (config.napcat.token) headers.Authorization = `Bearer ${config.napcat.token}`;

    logger.info(`连接 NapCat: ${config.napcat.url}`);
    const ws = new WebSocket(config.napcat.url, { headers });
    this.ws = ws;

    ws.on("open", () => {
      logger.info("NapCat 已连接");
      // 连接就绪：开心跳，并异步补取登录信息（不阻塞事件处理）。
      this.startHeartbeat();
      void this.refreshSelfId();
    });
    // 入站数据统一入口：action 响应与事件都在 onRaw 里分流。
    ws.on("message", (data) => this.onRaw(data));
    ws.on("pong", () => {
      // 对端存活证据：刷新时间戳，心跳定时器据此判断超时。
      this.lastPongAt = Date.now();
    });
    ws.on("close", (code, reason) => {
      logger.warn(`NapCat 连接关闭: ${code} ${reason.toString()}`);
      // 连接没了：停心跳、让所有在途调用立即失败、排期重连。
      this.stopHeartbeat();
      this.failPending(new Error(`WebSocket closed: ${code}`));
      this.scheduleReconnect();
    });
    ws.on("error", (error) => {
      // 只记录日志；清理与重连统一由随后的 close 回调处理。
      logger.error("NapCat WebSocket 错误:", error.message);
    });
  }

  /** 主动关停：标记不再重连，清理定时器，让在途调用失败，以正常码 1000 关闭连接。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.failPending(new Error("shutdown"));
    // 1000 = 正常关闭码。
    this.ws?.close(1000, "shutdown");
    this.ws = null;
  }

  /**
   * 调用一个 OneBot action 并等待响应。
   * 机制：为本次调用生成随机 echo，把结算函数登记进 pending；onRaw 收到同 echo 的响应后结算；
   * 超时（config.napcat.actionTimeoutMs）或连接断开（failPending）时以 reject 结束。
   * 失败的错误对象上带 retcode 字段，供调用方区分可恢复错误。
   * @param action OneBot action 名，如 send_group_msg / get_login_info
   * @param params action 参数
   * @returns 完整响应（含 status/retcode/data）
   */
  callAction<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<ActionResponse<T>> {
    const ws = this.ws;
    // 未连接（含重连间隙）直接失败，不排队等待。
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`NapCat 未连接，无法执行 ${action}`));
    }
    const echo = randomUUID();
    return new Promise<ActionResponse<T>>((resolve, reject) => {
      // 超时兜底：到点把调用从 pending 摘除并拒绝。
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`action ${action} 超时`));
      }, config.napcat.actionTimeoutMs);
      // 登记在途调用；action 名只用于错误信息与日志。
      this.pending.set(echo, {
        resolve: resolve as (response: ActionResponse) => void,
        reject,
        timer,
        action,
      });
      ws.send(JSON.stringify({ action, params, echo }), (error) => {
        // 发送回调报错（连接刚好断开等）：清理登记并拒绝，避免 Promise 永挂。
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(error);
      });
    });
  }

  /**
   * 发送普通消息；群聊走 send_group_msg、私聊走 send_private_msg。
   * 经 enqueue 串行节流；返回消息 ID（用于后续引用/撤回），响应里没有则为 undefined。
   */
  sendMessage(target: SendTarget, message: Segment[]): Promise<number | undefined> {
    return this.enqueue(() =>
      // 目标类型由 groupId 是否给出区分（SendTarget 保证二者恰有其一）。
      target.groupId !== undefined
        ? this.callAction<{ message_id: number }>("send_group_msg", { group_id: target.groupId, message })
        : this.callAction<{ message_id: number }>("send_private_msg", { user_id: target.userId, message }),
    );
  }

  /**
   * 发送合并转发消息：nodes 是调用方构造好的 node 段数组（内容由各节点组成）。
   * 群聊走 send_group_forward_msg、私聊走 send_private_forward_msg；同样经 enqueue 节流。
   */
  sendForward(target: SendTarget, nodes: Segment[]): Promise<number | undefined> {
    return this.enqueue(() =>
      target.groupId !== undefined
        ? this.callAction<{ message_id: number }>("send_group_forward_msg", { group_id: target.groupId, messages: nodes })
        : this.callAction<{ message_id: number }>("send_private_forward_msg", { user_id: target.userId, messages: nodes }),
    );
  }

  /** 撤回一条消息；超过 QQ 的时限或消息不在缓存中时会被拒绝（reject）。 */
  deleteMsg(messageId: number): Promise<void> {
    return this.callAction("delete_msg", { message_id: messageId }).then(() => undefined);
  }

  /** 禁言群成员指定秒数（群管理模块使用）；不关心响应体，统一映射为 void。 */
  setGroupBan(groupId: number, userId: number, durationSeconds: number): Promise<void> {
    return this.callAction("set_group_ban", { group_id: groupId, user_id: userId, duration: durationSeconds }).then(
      () => undefined,
    );
  }

  /**
   * 把一次发送挂到串行链尾：保证与上一发至少间隔 config.napcat.sendIntervalMs，
   * 回复分条连发时不会短时间打出多条消息触发 QQ 风控。
   * @param send 实际发送动作（callAction 的调用）
   * @returns 该次发送的 message_id（取不到时为 undefined）
   */
  private enqueue(send: () => Promise<ActionResponse<{ message_id: number }>>): Promise<number | undefined> {
    const task = this.sendChain.then(async () => {
      // 距「上一发 + 最小间隔」还差多少毫秒；为正才需要等待。
      const wait = this.lastSendAt + config.napcat.sendIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      // 发起前记录时间戳，保证下一发的间隔从这里算起。
      this.lastSendAt = Date.now();
      // 统一从响应 data 里取 message_id；响应缺 data 时为 undefined。
      return (await send()).data?.message_id;
    });
    // 链尾吞掉异常：单条发送失败不会让后续发送被连锁阻断。
    this.sendChain = task.catch(() => undefined);
    return task;
  }

  /** 连接后拉取登录信息填充 selfId；失败只告警，事件里的 self_id 会兜底同步。 */
  private async refreshSelfId(): Promise<void> {
    try {
      const response = await this.callAction<{ user_id: number; nickname: string }>("get_login_info");
      this.selfId = response.data.user_id;
      logger.info(`登录账号: ${response.data.nickname} (${response.data.user_id})`);
    } catch (error) {
      logger.warn("获取登录信息失败:", (error as Error).message);
    }
  }

  /** 入站数据入口：带 echo 的是 action 响应（结算 pending），带 post_type 的是事件（派发）。 */
  private onRaw(data: WebSocket.RawData): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      // 非 JSON 数据直接丢弃（正常情况下 NapCat 只发 JSON 文本）。
      logger.warn("无法解析 NapCat 消息");
      return;
    }

    // 响应分支：先按 echo 匹配在途调用；匹配确认为未知 echo 的响应会落到下面被自然忽略。
    if (typeof payload.echo === "string" && this.pending.has(payload.echo)) {
      const pending = this.pending.get(payload.echo)!;
      // 先摘除并清掉超时定时器，保证一次调用只结算一次。
      this.pending.delete(payload.echo);
      clearTimeout(pending.timer);
      const response = payload as unknown as ActionResponse;
      if (response.status === "failed" || (typeof response.retcode === "number" && response.retcode !== 0)) {
        // 失败描述字段各版本不一，依次回退；拿不到就退回 retcode 数值。
        const detail = response.wording || response.message || response.msg || `retcode=${response.retcode}`;
        const error = new Error(`action ${pending.action} 失败: ${detail}`);
        // 把 retcode 挂到错误上：调用方据此区分可恢复错误（如 1401）与其他失败。
        Object.assign(error, { retcode: response.retcode });
        pending.reject(error);
      } else {
        pending.resolve(response);
      }
      return;
    }

    // 事件分支：post_type 是事件类型标识（message、meta_event、notice 等）。
    if (typeof payload.post_type === "string") {
      const event = payload as OneBotEvent;
      // 顺便同步 self_id：事件也携带登录号，是 get_login_info 之外的第二来源。
      if (typeof event.self_id === "number") this.selfId = event.self_id;
      try {
        this.onEvent(event);
      } catch (error) {
        // 单个事件处理异常只记录，不影响后续消息。
        logger.error("事件处理失败:", error);
      }
    }
  }

  /** 启动心跳定时器：定期 ping，超过 heartbeatTimeoutMs 没收到 pong 就 terminate 触发重连。 */
  private startHeartbeat(): void {
    // 先停旧定时器，保证同时只有一个心跳在跑（重连时会再次调用）。
    this.stopHeartbeat();
    // 重置活跃时间，给新连接一个完整的超时预算。
    this.lastPongAt = Date.now();
    // 检查频率取超时阈值的 1/3（尽早发现假死），下限 5 秒避免过于频繁。
    const interval = Math.max(5000, Math.floor(config.napcat.heartbeatTimeoutMs / 3));
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      // 连接不在 OPEN（重连过程中）时跳过本次检查。
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPongAt > config.napcat.heartbeatTimeoutMs) {
        // 对端假死：terminate 强制断连，close 回调会安排重连。
        logger.warn("NapCat 心跳超时，重连");
        ws.terminate();
        return;
      }
      // 正常情况：发 ping，等对端 pong 刷新 lastPongAt。
      ws.ping();
    }, interval);
  }

  /** 停止心跳定时器（幂等）；连接关闭/重连/关停时调用。 */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** 安排一次重连（reconnectMs 后）；已在排期中或已关停时不重复安排。 */
  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      // 先清句柄再连接，保证下次断线还能再排期。
      this.reconnectTimer = null;
      this.connect();
    }, config.napcat.reconnectMs);
  }

  /** 让所有在途 action 调用以同一错误失败（用于连接关闭/关停），避免调用方永久挂起。 */
  private failPending(error: Error): void {
    for (const [echo, pending] of this.pending) {
      // 先清超时定时器，再拒绝并摘除，防止定时器随后二次处理同一调用。
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(echo);
    }
  }
}

/** 简易 sleep（毫秒），仅用于 enqueue 的发送节流等待。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
