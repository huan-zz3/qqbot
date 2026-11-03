import assert from "node:assert/strict";
import { test } from "node:test";

import { CODE_DIGITS, PairingRegistry, generateCode } from "../src/agent-client/registry.js";

const GRACE = 60_000;

function make(maxClients = 3): PairingRegistry {
  return new PairingRegistry({ graceMs: GRACE, maxClients });
}

test("generateCode：8 位数字，允许前导零", () => {
  for (let i = 0; i < 50; i++) {
    const code = generateCode(() => false);
    assert.match(code, /^\d{8}$/);
    assert.equal(code.length, CODE_DIGITS);
  }
});

test("generateCode：命中已占用会重抽", () => {
  let calls = 0;
  const taken = new Set<string>();
  const code = generateCode((c) => {
    calls++;
    // 前 3 次假装都撞了，验证它真的继续抽而不是直接返回。
    if (calls <= 3) {
      taken.add(c);
      return true;
    }
    return taken.has(c);
  });
  assert.equal(calls, 4);
  assert.match(code, /^\d{8}$/);
});

test("generateCode：连续 100 次都被占用就 throw，不返回重复码", () => {
  assert.throws(() => generateCode(() => true), /100/);
});

test("register：名额满时 throw", () => {
  const reg = make(2);
  const a = reg.register(0, "c1");
  reg.register(0, "c2");
  assert.equal(reg.size, 2);
  assert.equal(reg.onlineCount, 2);
  assert.notEqual(a.code, "");
  assert.throws(() => reg.register(0, "c3"), /上限/);
  assert.equal(reg.size, 2);
});

test("verified：新条目默认 false，markVerified 后为 true，重连重置为 false", () => {
  const reg = make();
  const entry = reg.register(0, "c1");
  assert.equal(entry.verified, false);
  assert.equal(reg.lookup(entry.code, 0)?.entry.verified, false);

  reg.markVerified(entry.code);
  assert.equal(reg.lookup(entry.code, 0)?.entry.verified, true);

  reg.markOffline(entry.code, 1_000);
  const resumed = reg.resume(entry.code, entry.token, 2_000, "c2");
  assert.ok(resumed);
  assert.equal(resumed.verified, false);

  // 不存在的码调用不抛错，也不凭空创建条目。
  reg.markVerified("00000000");
  assert.equal(reg.size, 1);
});

test("register：宽限期内的断线条目不占在线名额", () => {
  const reg = make(1);
  const first = reg.register(0, "c1");
  // 在线时确实占名额。
  assert.throws(() => reg.register(0, "c2"), /上限/);
  reg.markOffline(first.code, 0);
  // 断线（宽限期内）后名额立刻释放，第 4 个群友不用等 60s 宽限期结束。
  const second = reg.register(1, "c3");
  assert.equal(second.online, true);
  assert.equal(reg.onlineCount, 1);
});

test("markOffline + lookup：remainingMs 随时间减少，过了宽限期查不到", () => {
  const reg = make();
  const { code } = reg.register(0, "c1");
  reg.markOffline(code, 1_000);

  const at0 = reg.lookup(code, 1_000);
  assert.ok(at0);
  assert.equal(at0.entry.online, false);
  assert.equal(at0.remainingMs, GRACE);

  const at30 = reg.lookup(code, 31_000);
  assert.ok(at30);
  assert.equal(at30.remainingMs, GRACE - 30_000);

  const last = reg.lookup(code, 1_000 + GRACE);
  assert.ok(last);
  assert.equal(last.remainingMs, 0);

  // 严格超过宽限期才算过期。
  assert.equal(reg.lookup(code, 1_000 + GRACE + 1), undefined);
  assert.equal(reg.lookup("00000000", 0), undefined);
});

test("lookup：在线时 remainingMs 为 0", () => {
  const reg = make();
  const { code } = reg.register(0, "c1");
  const found = reg.lookup(code, 999_999);
  assert.ok(found);
  assert.equal(found.entry.online, true);
  assert.equal(found.remainingMs, 0);
});

test("resume：宽限期内 token 正确则成功，token 错误则失败", () => {
  const reg = make();
  const entry = reg.register(0, "c1");
  reg.markOffline(entry.code, 1_000);
  assert.equal(reg.onlineCount, 0);

  assert.equal(reg.resume(entry.code, "wrong-token", 2_000, "c2"), undefined);
  assert.equal(reg.onlineCount, 0);

  const resumed = reg.resume(entry.code, entry.token, 2_000, "c2");
  assert.ok(resumed);
  assert.equal(resumed.code, entry.code);
  assert.equal(resumed.token, entry.token);
  assert.equal(resumed.online, true);
  assert.equal(resumed.offlineSince, undefined);
  assert.equal(resumed.connectionId, "c2");
  assert.equal(reg.onlineCount, 1);
  // 码不变。
  assert.equal(reg.lookup(entry.code, 2_000)?.entry.code, entry.code);
});

test("resume：超过宽限期或码不存在都返回 undefined", () => {
  const reg = make();
  const entry = reg.register(0, "c1");
  reg.markOffline(entry.code, 0);
  assert.equal(reg.resume(entry.code, entry.token, GRACE + 1, "c2"), undefined);
  assert.equal(reg.resume("00000000", entry.token, 0, "c2"), undefined);
});

test("sweep：只删过期的断线条目，返回被删的码", () => {
  const reg = make();
  const expired = reg.register(0, "c1");
  const fresh = reg.register(0, "c2");
  const online = reg.register(0, "c3");
  reg.markOffline(expired.code, 0);
  reg.markOffline(fresh.code, 10_000);

  assert.deepEqual(reg.sweep(GRACE + 1), [expired.code]);
  assert.equal(reg.size, 2);
  assert.ok(reg.lookup(fresh.code, GRACE + 1));
  assert.ok(reg.lookup(online.code, GRACE + 1));

  // 再过一会儿 fresh 也过期。
  assert.deepEqual(reg.sweep(10_000 + GRACE + 1), [fresh.code]);
  assert.equal(reg.size, 1);
  assert.deepEqual(reg.sweep(10_000 + GRACE + 2), []);
});

test("sweep 后旧条目被清理，名额只由在线条目占用", () => {
  const reg = make(1);
  const entry = reg.register(0, "c1");
  reg.markOffline(entry.code, 0);
  // 断线即释放名额（宽限期内也不占坑），不必等 sweep。
  assert.equal(reg.register(1, "c2").online, true);
  assert.equal(reg.onlineCount, 1);
  // 旧条目仍在宽限期内可 resume，直到被 sweep 清掉。
  assert.ok(reg.lookup(entry.code, 1));
  assert.deepEqual(reg.sweep(GRACE + 1), [entry.code]);
  assert.equal(reg.size, 1);
});
