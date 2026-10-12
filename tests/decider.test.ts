/**
 * decider.test.ts —— 通用 decider 判定客户端（src/decider/client.js）测试。
 *
 * 覆盖：请求 URL / Bearer 鉴权 / 请求体只有 model·state·questions；只收集 noul 概率、
 * 忽略其它答案类型、缺失问题不计入；非 2xx 抛错并带状态码；多密钥失败切换与优先级提升。
 *
 * 注意：config 在 import 时读取 env，DECIDER_* 必须在动态 import 之前设置。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.LOG_LEVEL = "silent";
process.env.DECIDER_API_URL = "https://decider.test/v1/decide";
process.env.DECIDER_API_KEY = "test-key,test-key-2";
process.env.DECIDER_MODEL = "test-model";
process.env.DECIDER_TIMEOUT_MS = "1000";

// 动态引入被测模块（env 已生效）。
const { createDecider } = await import("../src/decider/client.js");

// 捕获的请求，供断言检查。
type Captured = { url: string; headers: Record<string, string>; body: unknown };

/** 用固定响应替换 globalThis.fetch，返回捕获到的请求数组。 */
function stubFetch(response: { ok: boolean; status: number; json?: unknown; text?: string }): Captured[] {
  const captured: Captured[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    captured.push({
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return {
      ok: response.ok,
      status: response.status,
      headers: new Headers(),
      json: async () => response.json,
      text: async () => response.text ?? "",
    } as unknown as Response;
  }) as typeof fetch;
  return captured;
}

test("posts model/state/questions with bearer auth", async () => {
  const captured = stubFetch({
    ok: true,
    status: 200,
    json: { answers: { should_reply: { type: "noul", noul: 0.7 } } },
  });
  const decide = createDecider();
  await decide({ chat: "g" }, { should_reply: { type: "noul", instructions: "reply?" } });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.url, "https://decider.test/v1/decide");
  assert.equal(captured[0]!.headers.Authorization, "Bearer test-key");
  // 请求体只有 model / state / questions 三个字段。
  assert.deepEqual(captured[0]!.body, {
    model: "test-model",
    state: { chat: "g" },
    questions: { should_reply: { type: "noul", instructions: "reply?" } },
  });
});

test("only noul answers become probabilities", async () => {
  stubFetch({
    ok: true,
    status: 200,
    json: {
      answers: {
        a: { type: "noul", noul: 0.3 },
        b: { type: "choice", choice: "x" },
        c: { type: "score", score: 4 },
      },
    },
  });
  const decide = createDecider();
  const result = await decide("s", { a: { type: "noul", instructions: "q" } });
  assert.deepEqual(result, { a: 0.3 });
});

test("missing answer leaves the key absent", async () => {
  stubFetch({ ok: true, status: 200, json: { answers: {} } });
  const decide = createDecider();
  assert.deepEqual(await decide("s", { a: { type: "noul", instructions: "q" } }), {});
});

test("non-2xx throws with status", async () => {
  stubFetch({ ok: false, status: 401, text: "unauthorized" });
  const decide = createDecider();
  await assert.rejects(decide("s", { a: { type: "noul", instructions: "q" } }), /decider 请求失败 \(401\)/);
});

/** 按每个请求的 Authorization 决定响应：指定密钥返回 429，其余成功；返回捕获到的鉴权头序列。 */
function stubFetchByKey(failAuthorization: string): string[] {
  const captured: string[] = [];
  globalThis.fetch = (async (_url: string | URL, init: RequestInit) => {
    const authorization = (init.headers as Record<string, string>).Authorization;
    captured.push(authorization);
    if (authorization === failAuthorization) {
      return { ok: false, status: 429, headers: new Headers(), text: async () => "rate limited" } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ answers: { a: { type: "noul", noul: 0.9 } } }),
    } as unknown as Response;
  }) as typeof fetch;
  return captured;
}

test("multiple keys: fail over to next and promote the successful key", async () => {
  const captured = stubFetchByKey("Bearer test-key");
  const decide = createDecider();
  // 首选密钥 429 → 用第二个密钥重试并成功。
  assert.deepEqual(await decide("s", { a: { type: "noul", instructions: "q" } }), { a: 0.9 });
  assert.deepEqual(captured, ["Bearer test-key", "Bearer test-key-2"]);

  // 第二次判定应优先使用刚提升到队首的第二个密钥。
  captured.length = 0;
  assert.deepEqual(await decide("s", { a: { type: "noul", instructions: "q" } }), { a: 0.9 });
  assert.deepEqual(captured, ["Bearer test-key-2"]);
});

test("all keys failing throws the last error after trying every key", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return { ok: false, status: 500, headers: new Headers(), text: async () => "boom" } as unknown as Response;
  }) as typeof fetch;
  const decide = createDecider();
  await assert.rejects(decide("s", { a: { type: "noul", instructions: "q" } }), /decider 请求失败 \(500\)/);
  assert.equal(calls, 2); // 两个密钥都试过了
});
