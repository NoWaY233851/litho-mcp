const ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;

export function bytesToBase64(b: Uint8Array): string {
  // Honour the view: a Uint8Array can be a window into a larger (pooled) ArrayBuffer.
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64");
}

/**
 * Strict standard-alphabet base64. Node's decoder silently skips whitespace, accepts the
 * URL-safe alphabet and ignores everything after misplaced padding, so the input is checked
 * up front and the decoded bytes are re-encoded and compared. That also rejects non-zero
 * trailing bits. Unpadded input is accepted because some providers omit the padding.
 *
 * The result is a plain Uint8Array that owns its ArrayBuffer, not a view into Node's
 * buffer pool, so callers can hand `.buffer` to APIs that read the whole buffer.
 */
export function base64ToBytes(s: string): Uint8Array {
  if (!ALPHABET.test(s)) throw new Error("invalid base64");
  const body = s.replace(/=+$/, "");
  const padding = s.length - body.length;
  // The padding, when present, must complete the final quantum exactly.
  if (body.length % 4 === 1 || (padding > 0 && s.length % 4 !== 0)) throw new Error("invalid base64");
  const decoded = Buffer.from(body, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== body) throw new Error("invalid base64");
  const out = new Uint8Array(decoded.length);
  out.set(decoded);
  return out;
}
