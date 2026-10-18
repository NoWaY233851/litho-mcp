import { createHash, timingSafeEqual } from "node:crypto";

// Accepts `Bearer <secret>` (any case) and a bare `<secret>`: claude.ai's
// "Request headers" field sends whatever the owner typed, so both forms must
// work (docs/design/0009-connector-secret-header.md). The prefix is only
// stripped when it is a whole word, so a secret that happens to begin with
// those letters is left intact.
export function extractSecret(header: string | null): string | null {
  if (header === null) return null;
  const value = header.trim().replace(/^bearer(?:\s+|$)/i, "").trim();
  return value === "" ? null : value;
}

// Hashing first gives both sides a fixed length, which timingSafeEqual
// requires and which keeps the comparison time independent of the secret's
// length. An empty expected secret never matches, so a misconfigured
// deployment cannot be opened with an empty header.
export function secretMatches(given: string | null, expected: string): boolean {
  const wanted = expected.trim();
  if (given === null || wanted === "") return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(wanted));
}
