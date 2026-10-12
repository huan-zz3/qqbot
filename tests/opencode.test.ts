/**
 * opencode.test.ts —— 只读 OpenCode 能力（src/opencode/permission.ts 的 decidePermission、
 * src/chat/reply.ts 的 openCodeTool）的单元测试。
 *
 * 覆盖：
 * - decidePermission：恒拒绝——优先选中「拒绝一次」，其次「拒绝始终」，没有拒绝项时取消；
 *   绝不选中任何 allow_* 选项（只读约束的核心）；
 * - openCodeTool：工具名/描述暴露正常，必填 prompt+directory（enum 为预定义短名）；
 *   prompt 为空/非字符串、directory 缺失/未知/非字符串时返回参数错误文本且不调用后端；
 *   正常参数去掉首尾空白后连同会话键（key）转交后端并回传其结果。
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

// 假后端：记录收到的 (prompt, directory, key)，返回固定结果，用于观察 openCodeTool 的参数校验与转发。
const DIR_DEFAULT = { name: "default", path: "/tmp/opencode-repo-default" };
const DIR_WEB = { name: "web", path: "/tmp/opencode-repo-web" };
const KEY = "group-500";
function fakeAgent() {
  const calls: Array<{ prompt: string; directory: string; key: string }> = [];
  return {
    calls,
    directories: () => [DIR_DEFAULT, DIR_WEB],
    run: async (prompt: string, directory: string, key: string) => {
      calls.push({ prompt, directory, key });
      return "结果";
    },
  };
}

// 工具定义暴露名称、必填 prompt+directory 参数，directory 的 enum 为预定义短名。
test("opencode tool exposes prompt and directory parameters", () => {
  const tool = openCodeTool(fakeAgent() as never, KEY);
  assert.equal(tool.definition.function.name, "opencode");
  assert.deepEqual(tool.definition.function.parameters.required, ["prompt", "directory"]);
  const properties = tool.definition.function.parameters.properties as {
    directory: { enum: string[] };
  };
  assert.deepEqual(properties.directory.enum, ["default", "web"]);
});

// 空 / 非字符串 prompt 返回参数错误文本，且不调用后端。
test("opencode tool rejects empty prompt without calling the backend", async () => {
  const agent = fakeAgent();
  const tool = openCodeTool(agent as never, KEY);
  assert.equal(await tool.handler({}), "prompt 不能为空");
  assert.equal(await tool.handler({ prompt: "   " }), "prompt 不能为空");
  assert.equal(await tool.handler({ prompt: 42 }), "prompt 不能为空");
  assert.deepEqual(agent.calls, []);
});

// directory 缺失/未知/非字符串时返回可读错误文本，且不调用后端。
test("opencode tool rejects a missing or unknown directory without calling the backend", async () => {
  const agent = fakeAgent();
  const tool = openCodeTool(agent as never, KEY);
  assert.match(await tool.handler({ prompt: "hi" }), /directory 必须是以下之一：default、web/);
  assert.match(await tool.handler({ prompt: "hi", directory: "nope" }), /收到：nope/);
  assert.match(await tool.handler({ prompt: "hi", directory: 42 }), /directory 必须是以下之一/);
  assert.deepEqual(agent.calls, []);
});

// 正常 prompt + directory 去掉首尾空白后连同会话键转交后端，并回传后端结果。
test("opencode tool trims and forwards the prompt, directory and key", async () => {
  const agent = fakeAgent();
  const tool = openCodeTool(agent as never, KEY);
  assert.equal(await tool.handler({ prompt: "  看看 README  ", directory: " web " }), "结果");
  assert.deepEqual(agent.calls, [{ prompt: "看看 README", directory: "web", key: KEY }]);
});

// 带文件上下文时：先求值上下文，把内容前置拼在 prompt 之前一并交给后端。
test("opencode tool prepends the file context when provided", async () => {
  const agent = fakeAgent();
  let calls = 0;
  const tool = openCodeTool(agent as never, KEY, async () => {
    calls++;
    return "  【文件：a.txt】\n内容  ";
  });
  assert.equal(await tool.handler({ prompt: "总结一下", directory: "default" }), "结果");
  assert.equal(calls, 1);
  assert.deepEqual(agent.calls, [{ prompt: "【文件：a.txt】\n内容\n\n总结一下", directory: "default", key: KEY }]);
});

// 上下文为空（无相关文件）时行为与不传上下文一致：只转发 prompt。
test("opencode tool ignores an empty context", async () => {
  const agent = fakeAgent();
  const tool = openCodeTool(agent as never, KEY, async () => "   ");
  assert.equal(await tool.handler({ prompt: "看看代码", directory: "default" }), "结果");
  assert.deepEqual(agent.calls, [{ prompt: "看看代码", directory: "default", key: KEY }]);
});

// prompt 为空时不求值上下文、也不调用后端（避免无谓的文件下载）。
test("opencode tool does not evaluate context for an empty prompt", async () => {
  const agent = fakeAgent();
  let calls = 0;
  const tool = openCodeTool(agent as never, KEY, async () => {
    calls++;
    return "内容";
  });
  assert.equal(await tool.handler({}), "prompt 不能为空");
  assert.equal(calls, 0);
  assert.deepEqual(agent.calls, []);
});

// directory 不合法时不求值上下文、也不调用后端。
test("opencode tool does not evaluate context for an unknown directory", async () => {
  const agent = fakeAgent();
  let calls = 0;
  const tool = openCodeTool(agent as never, KEY, async () => {
    calls++;
    return "内容";
  });
  assert.match(await tool.handler({ prompt: "hi", directory: "nope" }), /directory 必须是以下之一/);
  assert.equal(calls, 0);
  assert.deepEqual(agent.calls, []);
});

// onStart 通知：正常调用时恰好触发一次，且早于后端执行。
test("opencode tool notifies once, before running the backend", async () => {
  const agent = fakeAgent();
  const events: string[] = [];
  const originalRun = agent.run;
  agent.run = async (prompt: string, directory: string, key: string) => {
    events.push("run");
    return originalRun(prompt, directory, key);
  };
  const tool = openCodeTool(agent as never, KEY, undefined, () => {
    events.push("notice");
  });
  assert.equal(await tool.handler({ prompt: "看看代码", directory: "default" }), "结果");
  assert.deepEqual(events, ["notice", "run"]);
});

// 同一工具实例多次调用（同批多次 opencode），通知只触发一次。
test("opencode tool notifies only once per instance", async () => {
  const agent = fakeAgent();
  let notices = 0;
  const tool = openCodeTool(agent as never, KEY, undefined, () => {
    notices++;
  });
  await tool.handler({ prompt: "a", directory: "default" });
  await tool.handler({ prompt: "b", directory: "web" });
  assert.equal(notices, 1);
  assert.deepEqual(agent.calls, [
    { prompt: "a", directory: "default", key: KEY },
    { prompt: "b", directory: "web", key: KEY },
  ]);
});

// prompt 为空时不触发通知、也不调用后端。
test("opencode tool does not notify for an empty prompt", async () => {
  const agent = fakeAgent();
  let notices = 0;
  const tool = openCodeTool(agent as never, KEY, undefined, () => {
    notices++;
  });
  assert.equal(await tool.handler({}), "prompt 不能为空");
  assert.equal(notices, 0);
  assert.deepEqual(agent.calls, []);
});

// 不传 onStart 时行为与原来一致（回归）。
test("opencode tool runs without an onStart callback", async () => {
  const agent = fakeAgent();
  const tool = openCodeTool(agent as never, KEY);
  assert.equal(await tool.handler({ prompt: "hi", directory: "default" }), "结果");
  assert.deepEqual(agent.calls, [{ prompt: "hi", directory: "default", key: KEY }]);
});
