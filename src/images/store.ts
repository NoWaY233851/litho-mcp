// The only module that imports @vercel/blob (docs/design/0008-vercel-hobby.md).
import { del, list, put } from "@vercel/blob";
import { parseImageId, type ImageKind } from "./ids.js";
import { sniffImage, type ImageInfo } from "./sniff.js";

export const BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";

export function blobBaseUrl(storeId: string): string {
  return `https://${storeId}${BLOB_HOST_SUFFIX}`;
}

export interface ImageStore {
  /** Returns the public URL. Replaces only `up_` ids; a second put to an `img_` id throws. */
  put(id: string, bytes: Uint8Array, info: ImageInfo): Promise<string>;
  /** `null` when nothing is stored under `id`, which also covers "does it exist". */
  get(id: string): Promise<{ bytes: Uint8Array; info: ImageInfo; url: string } | null>;
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
const OWN_PATH = /^\/(img|up)\/([0-9a-f]{32})$/;
const OBJECT_PATHNAME = /^(img|up)\/([0-9a-f]{32})$/;

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

export function createBlobStore(
  token: string,
  baseUrl: string,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): ImageStore {
  const scheme = urlScheme(baseUrl);

  return {
    ...scheme,

    async put(id, bytes, info) {
      const { kind, hex } = validId(id);
      const replaceable = kind === "up";
      let result;
      try {
        result = await put(`${kind}/${hex}`, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
          access: "public",
          contentType: info.mime,
          addRandomSuffix: false,
          allowOverwrite: replaceable,
          ...(replaceable ? { cacheControlMaxAge: UPLOAD_CACHE_SECONDS } : {}),
          token,
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

    async get(id) {
      if (!parseImageId(id)) return null;
      const url = scheme.url(id);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
      try {
        // Redirects are not followed: a store URL never redirects, and a 3xx
        // would otherwise send this request somewhere unvetted.
        const response = await fetchImpl(url, { signal: controller.signal, redirect: "manual" });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`blob read failed: HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
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
        do {
          const page = await list({ prefix, cursor, token });
          for (const blob of page.blobs) {
            const match = OBJECT_PATHNAME.exec(blob.pathname);
            if (match && blob.uploadedAt.getTime() < cutoffMs) {
              found.push({ id: `${match[1]}_${match[2]}`, url: blob.url });
            }
          }
          cursor = page.hasMore ? page.cursor : undefined;
        } while (cursor);
      }
      return found;
    },

    async delete(urls) {
      for (let i = 0; i < urls.length; i += DELETE_BATCH) {
        await del(urls.slice(i, i + DELETE_BATCH), { token });
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

    async put(id, bytes, info) {
      const { kind } = validId(id);
      if (kind === "img" && objects.has(id)) throw new Error("image already exists");
      objects.set(id, { bytes: bytes.slice(), info, uploadedAt: now() });
      return scheme.url(id);
    },

    async get(id) {
      const stored = parseImageId(id) ? objects.get(id) : undefined;
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
