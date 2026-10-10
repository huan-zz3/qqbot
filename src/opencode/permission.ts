/**
 * permission.ts —— ACP 权限裁决策略（纯函数，不依赖 SDK 运行时，便于单测）。
 *
 * 只读约束的核心：对 OpenCode 发来的每一次权限请求都拒绝，绝不放行任何操作。
 * 单独成文件是为了让测试在 import 时不必加载重型 SDK。
 */
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";

/**
 * 决定一次权限请求的结果：恒定拒绝。
 *
 * 优先选中「拒绝一次」，其次「拒绝始终」；没有任何拒绝项时返回「取消」。
 * 绝不选中任何 allow_* 项。
 *
 * @param params ACP 的 session/request_permission 请求参数。
 * @returns 恒为拒绝/取消的应答。
 */
export function decidePermission(params: RequestPermissionRequest): RequestPermissionResponse {
  const reject =
    params.options.find((option) => option.kind === "reject_once") ??
    params.options.find((option) => option.kind === "reject_always");
  if (reject) return { outcome: { outcome: "selected", optionId: reject.optionId } };
  // 连拒绝项都没有（协议异常）时也不能放行，按取消处理。
  return { outcome: { outcome: "cancelled" } };
}
