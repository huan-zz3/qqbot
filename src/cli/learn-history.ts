/**
 * learn-history.ts —— 停机后从 NapCat 历史记录补学长期记忆的一次性 CLI
 *
 * 用法：`pnpm learn-history [条数]`（默认 60 条）。运行前先停掉 bot：运行期的
 * 记忆整理会在它退出 flush 时覆盖本脚本写入的内容。
 * 流程：连上 NapCat（只主动调接口、不消费推送事件）→ 取 bot 自己的 QQ 号 →
 * 按白名单逐个私聊/群拉取历史 → 转成 ChatRecord → 交给 MemoryStore 整理记忆
 * → flush 落盘 → 断开退出。复用与运行期相同的 config 与 data/memory.json。
 */
import { config } from "../config.js";
import { MemoryStore } from "../chat/memory.js";
import type { ChatRecord } from "../chat/history.js";
import { completeJson } from "../llm/deepseek.js";
import { NapcatClient } from "../napcat/client.js";
import { renderSegments, toSegments } from "../napcat/message.js";
import type { MessageEvent } from "../napcat/types.js";
import { installProxy } from "../proxy.js";

// 一次性脚本：从白名单会话的近期 NapCat 历史补学记忆。先停掉 bot，
// 否则它自己的记忆整理会把这里写入的内容覆盖掉。
// 拉取条数：命令行第一个参数，默认 60。
const COUNT = Number(process.argv[2] ?? 60);

// 事件回调传空：本脚本只主动调用接口，不消费推送。
const client = new NapcatClient(() => undefined);
// 整理记忆会用 DeepSeek 出网，先安装代理；留空则直连。
installProxy(config.proxy.url);
client.connect();
// 等 WS 连接就绪（connect 异步建立连接，之后才能调接口）。
await new Promise((resolve) => setTimeout(resolve, 2000));
// 取 bot 自己的 QQ 号：用于区分消息是否来自 bot，并作为渲染参数。
const login = await client.callAction<{ user_id: number }>("get_login_info");
const selfId = login.data.user_id;

// 复用运行期同一套记忆存储与整理逻辑（completeJson 是整理记忆用的 JSON 补全函数）。
const memory = new MemoryStore(config.memory.file, completeJson);
await memory.load();

/**
 * 把 NapCat 消息事件转成运行期的 ChatRecord 格式。
 * 名字优先取群名片、再退到昵称、最后用 QQ 号；bot 自己的消息用配置的 bot 名。
 */
function toRecords(messages: MessageEvent[]): ChatRecord[] {
  return messages
    .map((event) => ({
      messageId: event.message_id,
      userId: event.user_id,
      name: event.user_id === selfId ? config.bot.name : event.sender?.card || event.sender?.nickname || String(event.user_id),
      text: renderSegments(toSegments(event.message), { selfId, botName: config.bot.name }),
      // OneBot 的 time 是秒级时间戳，统一转毫秒。
      time: event.time * 1000,
      fromBot: event.user_id === selfId,
      // 补学的历史拿不到「是否 @/回复 bot」的语境，一律置否。
      atBot: false,
      replyToBot: false,
      mentionsBot: false,
    }))
    // 渲染不出文本的消息（纯图片等）直接丢弃。
    .filter((record) => record.text);
}

// 逐个白名单私聊拉历史并整理记忆；会话标签取第一条非 bot 消息的名字。
for (const userId of config.bot.privateUsers) {
  const history = await client.callAction<{ messages: MessageEvent[] }>("get_friend_msg_history", { user_id: userId, count: COUNT });
  const records = toRecords(history.data.messages ?? []);
  const label = records.find((record) => !record.fromBot)?.name ?? String(userId);
  console.log(`私聊 ${userId}: ${records.length} 条，更新 ${await memory.learn("private", label, records, config.bot.name)} 人`);
}

// 逐个白名单群拉历史并整理；会话标签用群名（取不到时退到群号）。
for (const groupId of config.bot.groups) {
  const history = await client.callAction<{ messages: MessageEvent[] }>("get_group_msg_history", { group_id: groupId, count: COUNT });
  const info = await client.callAction<{ group_name?: string }>("get_group_info", { group_id: groupId });
  const records = toRecords(history.data.messages ?? []);
  console.log(`群 ${groupId}: ${records.length} 条，更新 ${await memory.learn("group", info.data.group_name ?? String(groupId), records, config.bot.name)} 人`);
}

// 记忆落盘后断开连接，脚本结束。
await memory.flush();
await client.shutdown();
