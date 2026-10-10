/**
 * opencode.test.ts —— 只读 OpenCode 能力（src/opencode/permission.ts 的 decidePermission、
 * src/chat/reply.ts 的 openCodeTool）的单元测试。
 *
 * 覆盖：
 * - decidePermission：恒拒绝——优先选中「拒绝一次」，其次「拒绝始终」，没有拒绝项时取消；
 *   绝不选中任何 allow_* 选项（只读约束的核心）；
 * - openCodeTool：工具名/描述暴露正常；prompt 为空或非字符串时返回参数错误文本、
 *   不调用后端；正常字符串去掉首尾空白后转交后端并回传其结果。
 *
 * 说明：真实的 ACP 往返依赖机器上的 opencode 环境，不纳入单测（可单测的只有纯策略与参数校验）。
 * config.ts 在 import 时读取 process.env，故用动态 import。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { decidePermission } = await import("../src/opencode/permission.js");
const { openCodeTool } = await import("../src/chat/reply.js");

// 构造一个最小权限请求：只关心 options 的 kind/optionId。
const permissionRequest = (options: Array<{ optionId: string; kind: string }>) => ({
  sessionId: "s1",
  toolCall: { toolCallId: "c1", title: "Run shell" },
  options,
}) as never;

// 有「拒绝一次」时选中它，且绝不选中 allow_*。
test("permission is always rejected (reject_once preferred)", () => {
  const response = decidePermission(
    permissionRequest([
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "allow-always", kind: "allow_always" },
      { optionId: "reject-once", kind: "reject_once" },
    ]),
  );
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "reject-once" } });
});

// 没有 reject_once 但有 reject_always 时选中它。
test("permission falls back to reject_always", () => {
  const response = decidePermission(
    permissionRequest([
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-always", kind: "reject_always" },
    ]),
  );
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "reject-always" } });
});

// 只有 allow_* 选项（协议异常）时也不能放行：按取消处理。
test("permission with only allow options is cancelled, never allowed", () => {
  const response = decidePermission(
    permissionRequest([
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "allow-always", kind: "allow_always" },
    ]),
  );
  assert.deepEqual(response, { outcome: { outcome: "cancelled" } });
});

// 假后端：记录收到的 prompt，返回固定结果，用于观察 openCodeTool 的参数校验与转发。
function fakeAgent() {
  const calls: string[] = [];
  return { calls, run: async (prompt: string) => { calls.push(prompt); return "结果"; } };
}

// 工具定义暴露名称与必填 prompt 参数。
test("opencode tool exposes a prompt parameter", () => {
  const tool = openCodeTool(fakeAgent() as never);
  assert.equal(tool.definition.function.name, "opencode");
  assert.deepEqual(tool.definition.function.parameters.required, ["prompt"]);
});

// 空 / 非字符串 prompt 返回参数错误文本，且不调用后端。
test("opencode tool rejects empty prompt without calling the backend", async () => {
  const agent = fakeAgent();
  const tool = openCodeTool(agent as never);
  assert.equal(await tool.handler({}), "prompt 不能为空");
  assert.equal(await tool.handler({ prompt: "   " }), "prompt 不能为空");
  assert.equal(await tool.handler({ prompt: 42 }), "prompt 不能为空");
  assert.deepEqual(agent.calls, []);
});

// 正常 prompt 去掉首尾空白后转交后端，并回传后端结果。
test("opencode tool trims and forwards the prompt", async () => {
  const agent = fakeAgent();
  const tool = openCodeTool(agent as never);
  assert.equal(await tool.handler({ prompt: "  看看 README  " }), "结果");
  assert.deepEqual(agent.calls, ["看看 README"]);
});

// 带文件上下文时：先求值上下文，把内容前置拼在 prompt 之前一并交给后端。
test("opencode tool prepends the file context when provided", async () => {
  const agent = fakeAgent();
  let calls = 0;
  const tool = openCodeTool(agent as never, async () => {
    calls++;
    return "  【文件：a.txt】\n内容  ";
  });
  assert.equal(await tool.handler({ prompt: "总结一下" }), "结果");
  assert.equal(calls, 1);
  assert.deepEqual(agent.calls, ["【文件：a.txt】\n内容\n\n总结一下"]);
});

// 上下文为空（无相关文件）时行为与不传上下文一致：只转发 prompt。
test("opencode tool ignores an empty context", async () => {
  const agent = fakeAgent();
  const tool = openCodeTool(agent as never, async () => "   ");
  assert.equal(await tool.handler({ prompt: "看看代码" }), "结果");
  assert.deepEqual(agent.calls, ["看看代码"]);
});

// prompt 为空时不求值上下文、也不调用后端（避免无谓的文件下载）。
test("opencode tool does not evaluate context for an empty prompt", async () => {
  const agent = fakeAgent();
  let calls = 0;
  const tool = openCodeTool(agent as never, async () => {
    calls++;
    return "内容";
  });
  assert.equal(await tool.handler({}), "prompt 不能为空");
  assert.equal(calls, 0);
  assert.deepEqual(agent.calls, []);
});
