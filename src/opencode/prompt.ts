/**
 * prompt.ts —— 组装真正送进 `opencode acp` 的 prompt（纯函数，不依赖 ACP SDK，便于单测）。
 *
 * 背景：用户希望通过 .env 把一段自定义文本拼进送进 acp 的输入，一个前置、一个后置
 * （见 config.ts 的 OPENCODE_INPUT_PREFIX / OPENCODE_INPUT_SUFFIX）。body 是原本要送的
 * 任务文本（可能已含文件上下文，由 chat/reply.ts 拼好）。拼接规则刻意保持最小、确定：
 * - 各段先去掉首尾空白；空白段整段消失；
 * - 非空段之间用空行（两个换行）分隔；
 * - 全空时返回空串；任一配置留空时其结果与未配置完全一致（不产生多余空行）。
 *
 * 注意：这与 OPENCODE_PROMPT（给回复模型看的 opencode 工具说明）是两回事，后者不进 ACP。
 */

/**
 * 把前置文本、任务正文、后置文本拼成最终 prompt。
 *
 * @param prefix OPENCODE_INPUT_PREFIX：拼在任务前；留空不参与。
 * @param body 任务正文（送进 acp 的核心内容）。
 * @param suffix OPENCODE_INPUT_SUFFIX：拼在任务后；留空不参与。
 * @returns 用空行连接的最终文本；各段均空时为空串。
 */
export function composePrompt(prefix: string, body: string, suffix: string): string {
  return [prefix, body, suffix]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}
