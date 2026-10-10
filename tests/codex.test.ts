/**
 * codex.test.ts —— Codex 凭证（src/search/codex-auth.js）测试。
 *
 * 覆盖：
 * - 从 access token（JWT）的 claims 中解析 ChatGPT account id；非 JWT 抛错；
 * - 同步来的凭证只含 access token、没有 refresh token，未过期即可用；
 * - 过期时 get() 抛错并提示运行 sync-codex-auth.sh，usable() 为 false；
 *   磁盘上重新同步后无需重启即读到新 token；
 * - 凭证文件不存在时同样不可用。
 *
 * 关键约束：鉴权只读本地文件，bot 从不刷新 token；本文件把 fetch 换成
 * 「一调用即抛错」，锁死「鉴权不发任何网络请求」这一点。
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 动态引入被测模块（本文件不依赖 env）。
const { CodexAuth, accountIdFromToken } = await import("../src/search/codex-auth.js");

// 伪造一个三段式 JWT：只有 payload 段有内容（base64url 编码的 JSON claims），签名不参与解析。
function jwt(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString(
    "base64url",
  );
  return `h.${payload}.s`;
}

// 在临时目录里创建一份凭证文件：access 是假 JWT，expires 为毫秒时间戳。
async function credentialFile(expires: number): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), "qqbot-codex-")), "codex-auth.json");
  await writeFile(file, JSON.stringify({ access: jwt("acct-1"), expires }));
  return file;
}

// 把 fetch 换成「一调用就抛错」，锁死「鉴权只读本地文件、从不联网」。
globalThis.fetch = (async () => {
  throw new Error("the bot must never call the network for auth");
}) as typeof fetch;

/**
 * JWT 解析：从 claims 的 auth 段取出 chatgpt_account_id；
 * 非 JWT（没有 payload 段）抛错。
 */
test("reads the ChatGPT account id from the access token", () => {
  // 有效 JWT → 取到 account id。
  assert.equal(accountIdFromToken(jwt("acct-1")), "acct-1");
  // 非 JWT 字符串 → 抛错。
  assert.throws(() => accountIdFromToken("not-a-jwt"));
});

/**
 * 正常路径：读取同步来的未过期凭证（1 小时后到期）。
 * - accountId 从 token 解析；
 * - 凭证对象里没有 refresh 字段（bot 从不刷新，避免顶掉本机 pi 的 refresh token）；
 * - usable() 为 true。
 */
test("uses a synced access token without a refresh token", async () => {
  // expires 设为 1 小时后：未过期。
  const auth = new CodexAuth(await credentialFile(Date.now() + 3_600_000));
  const credential = await auth.get();
  assert.equal(credential.accountId, "acct-1");
  // 凭证不含 refresh token：同步脚本只传 access token。
  assert.equal("refresh" in credential, false);
  // 可用性检查通过。
  assert.equal(await auth.usable(), true);
});

/**
 * 过期与重新同步：
 * - 已过期（1 秒前）时 get() 抛错，错误信息带「过期」与 sync-codex-auth 提示，usable() false；
 * - 原地改写同一文件、写入新的过期时间后，usable() 无需重启即变 true
 *   （距过期不足余量时 get() 会重读磁盘）。
 */
test("expired token is reported, and a newer sync is picked up without restart", async () => {
  // 过期时间设为 1 秒前。
  const file = await credentialFile(Date.now() - 1000);
  const auth = new CodexAuth(file);
  // 报错信息含「过期」与同步脚本提示。
  await assert.rejects(auth.get(), /过期.*sync-codex-auth/);
  // 过期时不可用。
  assert.equal(await auth.usable(), false);

  // 模拟重新同步：原地写入新 token 与新的过期时间。
  await writeFile(file, JSON.stringify({ access: jwt("acct-1"), expires: Date.now() + 3_600_000 }));
  // 同一实例无需重启即变可用。
  assert.equal(await auth.usable(), true);
});

/**
 * 凭证文件不存在（尚未同步过）：usable() 为 false，get() 抛错并提示同步。
 */
test("missing credential file makes search unusable", async () => {
  // 指向一个不存在的目录。
  const auth = new CodexAuth(join(tmpdir(), "does-not-exist", "codex-auth.json"));
  // 缺失文件 → 不可用。
  assert.equal(await auth.usable(), false);
  // 取凭证抛错，提示去同步。
  await assert.rejects(auth.get(), /sync-codex-auth/);
});
