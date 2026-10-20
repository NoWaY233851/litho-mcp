// The only module that imports @vercel/blob (docs/design/0008-vercel-hobby.md).
import { del, list, put } from "@vercel/blob";
import type { BlobAuth } from "../config.js";
import { parseImageId, type ImageKind } from "./ids.js";
import {
  MAX_STORED_READ_BYTES,
  READ_BUDGET_EXCEEDED_MESSAGE,
  STORED_TOO_LARGE_MESSAGE as TOO_LARGE,
  type ReadBudget,
} from "./limits.js";
import { sniffImage, type ImageInfo } from "./sniff.js";

export { BLOB_HOST_SUFFIX, blobBaseUrl } from "./blob-url.js";

export interface ImageStore {
  /** Returns the public URL. The type is sniffed from `bytes`. Replaces only `up_` ids; a second put to an `img_` id throws. */
  put(id: string, bytes: Uint8Array): Promise<string>;
  /**
   * `null` when nothing is stored under `id`, which also covers "does it exist". Throws
   * `Error("stored object too large")` for an object over 40 MiB rather than reading it. With a
   * `budget`, every chunk read is charged to it, and `Error("reference read budget exceeded")`
   * is thrown for the chunk that does not fit.
   */
  get(id: string, budget?: ReadBudget): Promise<{ bytes: Uint8Array; info: ImageInfo; url: string } | null>;
  /** Derived without I/O, so a URL can be handed out before anything is stored. */
  url(id: string): string;
  /** This store's own URLs only; the host is compared case-insensitively. */
  idFromUrl(url: string): string | null;
  listOlderThan(cutoffMs: number): Promise<{ id: string; url: string }[]>;
  delete(urls: string[]): Promise<void>;
}

const READ_TIMEOUT_MS = 15_000;
// A replaced upload must stop being served from caches quickly; 60 s is the
// minimum the SDK accepts.
const UPLOAD_CACHE_SECONDS = 60;
// The SDK documents no batch limit for del; chunking at the list page size
// keeps each request body small.
const DELETE_BATCH = 1_000;
// 1,000 objects per page; far above what a personal store ever holds.
const MAX_LIST_PAGES = 50;
const OWN_PATH = /^\/(img|up)\/([0-9a-f]{32})$/;
const OBJECT_PATHNAME = /^(img|up)\/([0-9a-f]{32})$/;

/**
 * Reads a body without ever holding more than MAX_STORED_READ_BYTES: a declared length over the
 * limit is refused before reading, and the streamed count covers a missing or wrong header.
 * Each chunk is also charged to `budget` before it is kept, so reads running in parallel stay
 * within one shared total.
 */
async function readBounded(response: Response, budget?: ReadBudget): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_STORED_READ_BYTES) {
    await response.body?.cancel();
    throw new Error(TOO_LARGE);
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  let buffer = new Uint8Array(64 * 1024);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > MAX_STORED_READ_BYTES) throw new Error(TOO_LARGE);
      if (budget && !budget.take(value.byteLength)) throw new Error(READ_BUDGET_EXCEEDED_MESSAGE);
      if (total + value.byteLength > buffer.byteLength) {
        const grown = new Uint8Array(Math.min(Math.max(buffer.byteLength * 2, total + value.byteLength), MAX_STORED_READ_BYTES));
        grown.set(buffer.subarray(0, total));
        buffer = grown;
      }
      buffer.set(value, total);
      total += value.byteLength;
    }
  } finally {
    // A no-op after a clean read; on an early exit it closes the connection.
    reader.cancel().catch(() => {});
  }
  return buffer.slice(0, total);
}

function validId(id: string): { kind: ImageKind; hex: string } {
  const parsed = parseImageId(id);
  if (!parsed) throw new Error("invalid image id");
  return parsed;
}

// URL derivation shared by the real and the in-memory store, so tests exercise
// the same own-URL rules production uses.
function urlScheme(baseUrl: string): Pick<ImageStore, "url" | "idFromUrl"> {
  const base = new URL(baseUrl);
  const prefix = baseUrl.replace(/\/+$/, "");
  return {
    url(id) {
      const { kind, hex } = validId(id);
      return `${prefix}/${kind}/${hex}`;
    },
    idFromUrl(url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return null;
      }
      // new URL lowercases the host. Credentials and a custom port can never
      // belong to this store's public URLs.
      if (parsed.protocol !== "https:" || parsed.host !== base.host || parsed.username || parsed.password) {
        return null;
      }
      const match = OWN_PATH.exec(parsed.pathname);
      return match ? `${match[1]}_${match[2]}` : null;
    },
  };
}

// `auth` is passed to every SDK call. A token is passed explicitly because the
// SDK prefers OIDC over the environment token whenever a store id is present;
// with `{ storeId }` there is no token and the SDK resolves the platform's OIDC
// token per call, inside the request (docs/design/0010-vercel-blob-storage.md).
export function createBlobStore(
  auth: BlobAuth,
  baseUrl: string,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): ImageStore {
  const scheme = urlScheme(baseUrl);

  return {
    ...scheme,

    async put(id, bytes) {
      const { kind, hex } = validId(id);
      // The stored Content-Type comes from the bytes, never from the caller.
      const sniffed = sniffImage(bytes);
      if (!sniffed) throw new Error("not a supported image");
      const replaceable = kind === "up";
      let result;
      try {
        result = await put(`${kind}/${hex}`, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
          access: "public",
          contentType: sniffed.mime,
          addRandomSuffix: false,
          allowOverwrite: replaceable,
          ...(replaceable ? { cacheControlMaxAge: UPLOAD_CACHE_SECONDS } : {}),
          ...auth,
        });
      } catch (error) {
        // The SDK has no dedicated error class for a pathname collision.
        if (!replaceable && error instanceof Error && /already exists/i.test(error.message)) {
          throw new Error("image already exists");
        }
        throw error;
      }
      // The URL is derived from configuration, not from this response. A wrong
      // BLOB_STORE_ID would otherwise hand out URLs that point at no object.
      const expected = scheme.url(id);
      if (result.url.toLowerCase() !== expected.toLowerCase()) throw new Error("blob base URL mismatch");
      return expected;
    },

    async get(id, budget) {
      if (!parseImageId(id)) return null;
      const url = scheme.url(id);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
      try {
        // Redirects are not followed: a store URL never redirects, and a 3xx
        // would otherwise send this request somewhere unvetted.
        const response = await fetchImpl(url, { signal: controller.signal, redirect: "manual" });
        // An unread body keeps the connection busy until garbage collection.
        if (response.status === 404) {
          await response.body?.cancel();
          return null;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`blob read failed: HTTP ${response.status}`);
        }
        const bytes = await readBounded(response, budget);
        const info = sniffImage(bytes);
        if (!info) throw new Error("stored object is not a supported image");
        return { bytes, info, url };
      } catch (error) {
        if (controller.signal.aborted) throw new Error("blob read timed out");
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },

    async listOlderThan(cutoffMs) {
      const found: { id: string; url: string }[] = [];
      for (const prefix of ["img/", "up/"]) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (let pages = 0; ; pages++) {
          // Each list call is a billed advanced operation, and going over the
          // monthly allowance stops Blob for 30 days, so a misbehaving cursor
          // must end the run instead of looping until the function times out.
          if (pages >= MAX_LIST_PAGES) throw new Error("blob list exceeded page limit");
          const page = await list({ prefix, cursor, ...auth });
          for (const blob of page.blobs) {
            const match = OBJECT_PATHNAME.exec(blob.pathname);
            if (match && blob.uploadedAt.getTime() < cutoffMs) {
              found.push({ id: `${match[1]}_${match[2]}`, url: blob.url });
            }
          }
          if (!page.hasMore || !page.cursor) break;
          if (seen.has(page.cursor)) throw new Error("blob list did not advance");
          seen.add(page.cursor);
          cursor = page.cursor;
        }
      }
      return found;
    },

    async delete(urls) {
      for (let i = 0; i < urls.length; i += DELETE_BATCH) {
        await del(urls.slice(i, i + DELETE_BATCH), auth);
      }
    },
  };
}

/** In-memory store for tests; mirrors the real store's replace and collision rules. */
export function createMemoryStore(
  baseUrl = "https://blob.example.test",
  now: () => number = () => Date.now(),
): ImageStore {
  const scheme = urlScheme(baseUrl);
  const objects = new Map<string, { bytes: Uint8Array; info: ImageInfo; uploadedAt: number }>();

  return {
    ...scheme,

    async put(id, bytes) {
      const { kind } = validId(id);
      const info = sniffImage(bytes);
      if (!info) throw new Error("not a supported image");
      if (kind === "img" && objects.has(id)) throw new Error("image already exists");
      objects.set(id, { bytes: bytes.slice(), info, uploadedAt: now() });
      return scheme.url(id);
    },

    async get(id, budget) {
      const stored = parseImageId(id) ? objects.get(id) : undefined;
      if (stored && stored.bytes.length > MAX_STORED_READ_BYTES) throw new Error(TOO_LARGE);
      if (stored && budget && !budget.take(stored.bytes.length)) throw new Error(READ_BUDGET_EXCEEDED_MESSAGE);
      return stored ? { bytes: stored.bytes.slice(), info: stored.info, url: scheme.url(id) } : null;
    },

    async listOlderThan(cutoffMs) {
      return [...objects]
        .filter(([, object]) => object.uploadedAt < cutoffMs)
        .map(([id]) => ({ id, url: scheme.url(id) }));
    },

    async delete(urls) {
      for (const url of urls) {
        const id = scheme.idFromUrl(url);
        if (id) objects.delete(id);
      }
    },
  };
}
