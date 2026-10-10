/**
 * types.ts —— OneBot v11 协议类型定义（本项目用到的子集）
 * 覆盖：消息段 Segment、消息发送者 Sender、消息事件 MessageEvent、
 * 任意事件 OneBotEvent、action 调用响应 ActionResponse，以及消息事件类型守卫。
 *
 * 约定：字段按 OneBot v11 规范声明；Segment.data 保持 Record<string, unknown>——
 * 不同段类型的字段不同，具体取值由使用处按需解析（见 message.ts）。
 * 本文件是纯类型模块（仅 isMessageEvent 含运行时逻辑），不依赖其它模块。
 */

/** 单条消息段：OneBot 的「数组格式」消息由多个段按顺序拼接而成。 */
export type Segment = {
  /** 段类型：text / at / image / face / mface / reply / markdown 等。 */
  type: string;
  /** 段数据，字段随 type 而变（如 text 段为 { text }，at 段为 { qq, name? }）。 */
  data: Record<string, unknown>;
};

/** 消息发送者信息（NapCat 在消息事件的 sender 字段附带）。 */
export type Sender = {
  /** 发送者 QQ 号。 */
  user_id: number;
  /** 昵称；不在群聊、没有群名片时的显示名。 */
  nickname?: string;
  /** 群名片；群聊中优先于 nickname 显示。 */
  card?: string;
  /** 群内角色：owner（群主）/ admin（管理员）/ member（普通成员）。 */
  role?: string;
};

/**
 * 消息事件：一条收/发到的新消息。
 * message_type 区分群聊与私聊，group_id 仅群聊存在；message 可能是段数组或字符串，
 * 本项目 NapCat 配置为数组格式，字符串形式只作兜底（见 message.ts 的 toSegments）。
 */
export type MessageEvent = {
  /** 事件类型，固定为 "message"。 */
  post_type: "message";
  /** 消息来源：private 私聊 / group 群聊。 */
  message_type: "private" | "group";
  /** 子类型（如私聊的 friend/group、群聊的 normal/anonymous）。 */
  sub_type?: string;
  /** 消息 ID：回复引用与撤回都靠它。 */
  message_id: number;
  /** 发送者 QQ 号。 */
  user_id: number;
  /** 群号；仅群聊消息存在。 */
  group_id?: number;
  /** 收到该事件的 bot 自身 QQ 号。 */
  self_id: number;
  /** 事件时间（Unix 秒）。 */
  time: number;
  /** 消息内容：段数组或原始字符串（本项目以数组为准）。 */
  message: Segment[] | string;
  /** 未转换的原始消息文本（CQ 码原文）。 */
  raw_message?: string;
  /** 发送者信息。 */
  sender?: Sender;
};

/**
 * 任意 OneBot 事件：除消息事件外的所有事件（meta_event 生命周期/心跳、notice 等）
 * 只保证 post_type，其余字段保持宽松；上层用 isMessageEvent 筛出消息事件。
 */
export type OneBotEvent =
  | MessageEvent
  | {
      post_type: string;
      self_id?: number;
      meta_event_type?: string;
      [key: string]: unknown;
    };

/**
 * action 调用的响应；data 的类型随 action 而定，由调用方用泛型参数指定。
 * 失败判定见 client.ts 的 onRaw：status 非 ok 或 retcode ≠ 0 均算失败。
 */
export type ActionResponse<T = unknown> = {
  /** 调用状态：ok 成功 / failed 失败 / async 异步（本项目按成功与失败两类处理）。 */
  status: "ok" | "failed" | "async";
  /** 返回码：0 成功，非 0 为具体错误码（如 1401）。 */
  retcode: number;
  /** 响应数据，结构随 action 而定。 */
  data: T;
  /** 失败描述；不同 NapCat 版本填充的字段不同（client.ts 按 wording/message/msg 依次回退）。 */
  message?: string;
  /** 失败描述别名，同 message。 */
  msg?: string;
  /** 失败描述别名，同 message。 */
  wording?: string;
  /** 请求时携带的 echo；响应把它原样带回，用于匹配发起方。 */
  echo?: string;
};

/**
 * 类型守卫：从任意事件中筛出消息事件（供 index.ts 过滤）。
 * 要求 post_type 为 "message"、message_type 为 private/group 且 message_id 是数字，
 * 心跳/生命周期等其它事件都会被排除。
 */
export function isMessageEvent(event: OneBotEvent): event is MessageEvent {
  return (
    event.post_type === "message" &&
    (event.message_type === "private" || event.message_type === "group") &&
    typeof event.message_id === "number"
  );
}
