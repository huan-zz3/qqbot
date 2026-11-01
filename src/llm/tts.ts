/**
 * tts.ts —— 文字转语音（TTS）的底层调用封装，与回复模型、识图后端完全独立。
 *
 * 后端是 MiniMax 的 t2a_v2（同步接口），端点与模型由 config.voice（VOICE_* 环境变量）提供；
 * 是否启用由 VOICE_ENABLED 决定，缺 VOICE_API_KEY / VOICE_VOICE_ID 时由 index.ts 在启动时报错退出。
 *
 * 走 global fetch，因此自动继承 proxy.ts 安装的 ProxyAgent；用 AbortSignal.timeout 做请求级超时。
 *
 * 失败语义：任何拿不到音频的情况（非 2xx、base_resp.status_code≠0、响应缺 data.audio、
 * 解码后长度为 0）都抛错，绝不返回空 Buffer —— 调用方据此重试一次后退回纯文字。
 */
import { config } from "../config.js";
import type { VoiceEmotion } from "../chat/voice.js";

/** t2a_v2 原始响应中本模块用到的字段，其余忽略。 */
type TtsResponse = {
  data?: { audio?: string } | null;
  base_resp?: { status_code?: number; status_msg?: string } | null;
  trace_id?: string;
};

/**
 * 当前模型是否支持语气词标签（(laughs)、(sighs) 等）。
 * MiniMax 只有 speech-2.8 系列支持，其余模型会把标签当普通文字念出来。
 */
export function supportsTags(): boolean {
  return config.voice.model.startsWith("speech-2.8");
}

/**
 * 合成语音：把一段文本发给 MiniMax，返回 mp3 音频字节。
 *
 * @param text 要念的文本（调用方已清洗，可含语气词标签）
 * @param emotion 本条的情绪；缺省时用配置的全局默认 VOICE_EMOTION，都为空则整个字段省略（由 MiniMax 自动匹配）
 * @returns 解码后的音频 Buffer（非空）
 * @throws 请求失败、服务端报错或未返回音频时抛出带原因的 Error
 */
export async function synthesizeSpeech(text: string, emotion?: VoiceEmotion): Promise<Buffer> {
  // 情绪优先级：本条标记 > 全局默认 > 不传。
  const selected = emotion ?? (config.voice.emotion || undefined);
  const body = {
    model: config.voice.model,
    text,
    stream: false,
    // hex 便于把音频放进 JSON；比 url 少一次下载。
    output_format: "hex",
    voice_setting: {
      voice_id: config.voice.voiceId,
      speed: config.voice.speed,
      vol: config.voice.vol,
      pitch: config.voice.pitch,
      // 为空时省略该字段，交给 MiniMax 自动匹配。
      ...(selected ? { emotion: selected } : {}),
    },
    audio_setting: {
      sample_rate: 24000,
      bitrate: 64000,
      format: "mp3",
      channel: 1,
    },
  };

  const response = await fetch(config.voice.apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.voice.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    // 请求级超时：超时中止请求并抛错。
    signal: AbortSignal.timeout(config.voice.timeoutMs),
  });
  if (!response.ok) {
    // 响应体截断到 500 字符，便于在错误信息里定位服务端问题。
    const raw = await response.text().catch(() => "");
    throw new Error(`语音合成请求失败 (${response.status}): ${raw.slice(0, 500)}`);
  }
  const result = (await response.json()) as TtsResponse;
  const base = result.base_resp;
  // MiniMax 用 HTTP 200 + base_resp.status_code 表达业务错误，必须显式判失败。
  if (base?.status_code !== 0) {
    throw new Error(
      `语音合成失败 status_code=${base?.status_code} status_msg=${base?.status_msg ?? "无"} trace_id=${result.trace_id ?? "无"}`,
    );
  }
  const hex = result.data?.audio;
  if (!hex) throw new Error(`语音合成未返回音频（trace_id=${result.trace_id ?? "无"}）`);
  const audio = Buffer.from(hex, "hex");
  if (audio.length === 0) throw new Error(`语音合成未返回音频（hex 解码为空，trace_id=${result.trace_id ?? "无"}）`);
  return audio;
}
