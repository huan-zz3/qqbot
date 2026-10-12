/**
 * opencode-retry.test.ts —— src/opencode/retry.js 的 parseRetryNotice()/retryExceeded() 测试。
 *
 * 对应「提前察觉 opencode 内部重试/卡死」这个功能的核心解析，覆盖：
 * - 非 session_info_update / 没有 opencode/retry 键 → none（不误判）；
 * - retry 为 null → cleared；
 * - retry 为对象 → active（含字段缺失时的宽容解析）；
 * - retry 为其它类型 → malformed（绝不与 none 混同）；
 * - _meta 位置：优先 update 自身，缺失时回退到通知外层；
 * - retryExceeded 的边界（等于阈值不算超、严格大于才算）。
 *
 * 纯逻辑，不依赖 ACP 运行时。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { parseRetryNotice, retryExceeded } = await import("../src/opencode/retry.js");

/** 造一条最小 session/update 通知：只需 update.sessionUpdate 与两处 _meta。 */
function notification(update: Record<string, unknown>, notificationMeta?: unknown) {
  return { sessionId: "s1", update, _meta: notificationMeta ?? null } as never;
}

// 非 session_info_update 的更新一律 none。
test("non session_info_update is none", () => {
  assert.deepEqual(parseRetryNotice(notification({ sessionUpdate: "agent_message_chunk" })), { kind: "none" });
});

// info 更新但没有 opencode/retry 键 → none。
test("info update without the retry key is none", () => {
  assert.deepEqual(parseRetryNotice(notification({ sessionUpdate: "session_info_update", _meta: {} })), {
    kind: "none",
  });
});

// retry 为 null 表示重试恢复 → cleared。
test("retry set to null is cleared", () => {
  const notice = parseRetryNotice(
    notification({ sessionUpdate: "session_info_update", _meta: { "opencode/retry": null } }),
  );
  assert.deepEqual(notice, { kind: "cleared" });
});

// retry 为对象 → active，字段逐个解析。
test("active retry parses attempt, nextRetryAt and error fields", () => {
  const notice = parseRetryNotice(
    notification({
      sessionUpdate: "session_info_update",
      _meta: {
        "opencode/retry": {
          attempt: 3,
          nextRetryAt: "2026-10-02T12:00:05.000Z",
          error: { type: "provider.rate-limit", message: "Rate limit exceeded", status: 429 },
        },
      },
    }),
  );
  assert.deepEqual(notice, {
    kind: "active",
    attempt: 3,
    nextRetryAt: "2026-10-02T12:00:05.000Z",
    errorType: "provider.rate-limit",
    errorStatus: 429,
    errorMessage: "Rate limit exceeded",
  });
});

// 对象里缺字段时宽容解析：attempt 缺省为 0，其余 undefined。
test("active retry tolerates missing fields", () => {
  const notice = parseRetryNotice(
    notification({ sessionUpdate: "session_info_update", _meta: { "opencode/retry": {} } }),
  );
  assert.deepEqual(notice, { kind: "active", attempt: 0, nextRetryAt: undefined, errorType: undefined, errorStatus: undefined, errorMessage: undefined });
});

// retry 既非 null 也非对象 → malformed，并带回原始值。
test("non-object non-null retry is malformed", () => {
  assert.deepEqual(parseRetryNotice(notification({ sessionUpdate: "session_info_update", _meta: { "opencode/retry": "boom" } })), {
    kind: "malformed",
    raw: "boom",
  });
  assert.deepEqual(parseRetryNotice(notification({ sessionUpdate: "session_info_update", _meta: { "opencode/retry": 7 } })), {
    kind: "malformed",
    raw: 7,
  });
});

// update._meta 缺失时回退到通知外层 _meta（兼容 opencode 放置位置差异）。
test("retry meta falls back to the notification-level _meta", () => {
  const notice = parseRetryNotice(
    notification({ sessionUpdate: "session_info_update" }, { "opencode/retry": { attempt: 1 } }),
  );
  assert.equal(notice.kind, "active");
  assert.equal((notice as { attempt: number }).attempt, 1);
});

// update._meta 非对象时视为「没有该键」→ none，而不是崩。
test("non-object update _meta is none", () => {
  assert.deepEqual(parseRetryNotice(notification({ sessionUpdate: "session_info_update", _meta: "x" })), { kind: "none" });
});

// attempt 严格大于上限才算超限。
test("retryExceeded only fires strictly above the max", () => {
  const active = { kind: "active" as const, attempt: 2 };
  assert.equal(retryExceeded(active, 2), false);
  assert.equal(retryExceeded(active, 1), true);
  assert.equal(retryExceeded({ kind: "cleared" }, 0), false);
  assert.equal(retryExceeded({ kind: "none" }, 0), false);
});
