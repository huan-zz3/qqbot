/**
 * keys.ts —— decider 多密钥的纯逻辑：优先级重排与密钥脱敏。
 *
 * 只做无副作用的转换，便于单测；真正的请求轮换在 client.ts。
 */

/** 去重并保留首次出现的顺序；同时丢弃空白项。空串/重复项不算独立密钥。 */
export function uniqueKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of keys) {
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

/** 把命中的密钥提升到队首（move-to-front），其余保持相对顺序；密钥不在列表中则原样返回副本。 */
export function promote(keys: readonly string[], used: string): string[] {
  if (!keys.includes(used)) return [...keys];
  return [used, ...keys.filter((key) => key !== used)];
}

/** 密钥脱敏：只保留末尾 4 位，其余以 * 代替；供日志使用，绝不泄露明文。 */
export function maskKey(key: string): string {
  return `***${key.slice(-4)}`;
}
