/**
 * decode.ts —— 文本文件字节的多编码严格解码（纯逻辑，无 I/O、无日志）。
 *
 * FileStore 拿到字节后调用这里把「字节」变成「文本」：先看 BOM，再按固定优先级用
 * 严格模式（fatal）逐个尝试候选编码，第一个成功即采用；全部失败则返回明确失败。
 *
 * 严格三态：text（成功，含命中的编码名）/ binary（含 NUL，判二进制）/ failed（编码均不匹配）。
 * 本模块不做日志与截断；命中编码名交由调用方记录，保证「不是 UTF-8」这件事可被观察。
 *
 * 已知限制：GB18030 是 GBK/GB2312 的超集，且能接受绝大多数 Big5/Shift_JIS/EUC-KR 的字节
 * 序列（解出的是乱码而非报错），因此后三者在实际数据里很少被命中。判据只有「顺序首个
 * 严格成功」，不做编码探测；命中编码会记录日志，便于排查乱码来源。
 */

/** 无 BOM 时按优先级尝试的候选编码；顺序即优先级。 */
export const TEXT_ENCODINGS = ["utf-8", "gb18030", "big5", "shift_jis", "euc-kr"] as const;

/** BOM 前缀与其指示的编码；按字节前缀匹配，长前缀在前。 */
const BOMS: ReadonlyArray<{ bytes: readonly number[]; encoding: string }> = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: "utf-8" },
  { bytes: [0xff, 0xfe], encoding: "utf-16le" },
  { bytes: [0xfe, 0xff], encoding: "utf-16be" },
];

/** 解码结果三态互斥。 */
export type DecodeResult =
  | { status: "text"; content: string; encoding: string }
  | { status: "binary"; reason: string }
  | { status: "failed"; reason: string };

/** 探测开头的 BOM；无则返回 undefined。 */
function detectBom(bytes: Buffer): string | undefined {
  for (const bom of BOMS) {
    if (bom.bytes.every((byte, index) => bytes[index] === byte)) return bom.encoding;
  }
  return undefined;
}

/** 用指定编码严格解码；失败返回 undefined（不抛）。 */
function tryDecode(bytes: Buffer, encoding: string): string | undefined {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * 把文本文件字节解码为文本。
 * BOM 优先且权威（存在即只按 BOM 编码解，失败不回退）；无 BOM 时先查 NUL 判二进制，
 * 再按 TEXT_ENCODINGS 顺序尝试，第一个严格成功即采用。
 */
export function decodeTextFile(bytes: Buffer): DecodeResult {
  const bomEncoding = detectBom(bytes);
  if (bomEncoding) {
    const content = tryDecode(bytes, bomEncoding);
    if (content === undefined) {
      return { status: "failed", reason: `BOM 指示 ${bomEncoding} 但解码失败` };
    }
    return { status: "text", content, encoding: bomEncoding };
  }

  if (bytes.includes(0)) return { status: "binary", reason: "含二进制内容" };

  for (const encoding of TEXT_ENCODINGS) {
    const content = tryDecode(bytes, encoding);
    if (content !== undefined) return { status: "text", content, encoding };
  }
  return { status: "failed", reason: `无法按 ${TEXT_ENCODINGS.join("/")} 解码` };
}
