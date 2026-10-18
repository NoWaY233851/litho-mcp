import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob", () => ({
  put: vi.fn(),
  list: vi.fn(),
  del: vi.fn(),
}));

import { del, list, put } from "@vercel/blob";
import type { ImageInfo } from "../src/images/sniff.js";
import { BLOB_HOST_SUFFIX, blobBaseUrl, createBlobStore, createMemoryStore } from "../src/images/store.js";

const HEX = "0123456789abcdef0123456789abcdef";
const OTHER_HEX = "fedcba9876543210fedcba9876543210";
const IMG = `img_${HEX}`;
const UP = `up_${HEX}`;
const TOKEN = "vercel_blob_rw_TestStore01_fake";
const BASE = blobBaseUrl("teststore01");
const PNG: ImageInfo = { mime: "image/png", width: 1, height: 1 };

// A 1x1 PNG, so sniffImage recognizes what the fake network hands back.
const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

type PutResult = Awaited<ReturnType<typeof put>>;
const putResult = (url: string): PutResult => ({ url }) as PutResult;

describe("blobBaseUrl", () => {
  it("builds https://<id> + BLOB_HOST_SUFFIX", () => {
    expect(BLOB_HOST_SUFFIX.startsWith(".")).toBe(true);
    expect(blobBaseUrl("teststore01")).toBe(`https://teststore01${BLOB_HOST_SUFFIX}`);
  });
});

describe("memory store", () => {
  it("put/get round-trip; url(id) equals the URL put returns", async () => {
    const store = createMemoryStore();
    const url = await store.put(IMG, PNG_BYTES, PNG);
    expect(url).toBe(store.url(IMG));
    expect(url).toBe(`https://blob.example.test/img/${HEX}`);
    const got = await store.get(IMG);
    expect(got?.url).toBe(url);
    expect(got?.info).toEqual(PNG);
    expect(Array.from(got!.bytes)).toEqual(Array.from(PNG_BYTES));
    expect(await store.get(`img_${OTHER_HEX}`)).toBeNull();
  });

  it("idFromUrl inverts url and rejects foreign hosts", () => {
    const store = createMemoryStore();
    expect(store.idFromUrl(store.url(IMG))).toBe(IMG);
    expect(store.idFromUrl(store.url(UP))).toBe(UP);
    expect(store.idFromUrl(`https://other.example.test/img/${HEX}`)).toBeNull();
    expect(store.idFromUrl(`https://blob.example.test.evil.example.test/img/${HEX}`)).toBeNull();
  });

  it("a second put to an img_ id throws; to an up_ id replaces", async () => {
    const store = createMemoryStore();
    await store.put(IMG, PNG_BYTES, PNG);
    await expect(store.put(IMG, PNG_BYTES, PNG)).rejects.toThrow("image already exists");
    await store.put(UP, PNG_BYTES, PNG);
    const replacement: ImageInfo = { mime: "image/png", width: 2, height: 2 };
    await store.put(UP, PNG_BYTES, replacement);
    expect((await store.get(UP))?.info).toEqual(replacement);
  });

  it("listOlderThan and delete follow the upload time", async () => {
    let now = 1_000;
    const store = createMemoryStore("https://blob.example.test", () => now);
    await store.put(IMG, PNG_BYTES, PNG);
    now = 5_000;
    await store.put(UP, PNG_BYTES, PNG);
    const old = await store.listOlderThan(3_000);
    expect(old).toEqual([{ id: IMG, url: store.url(IMG) }]);
    await store.delete(old.map((o) => o.url));
    expect(await store.get(IMG)).toBeNull();
    expect(await store.get(UP)).not.toBeNull();
  });
});

describe("blob store", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const store = () => createBlobStore(TOKEN, BASE, fetchMock);

  beforeEach(() => {
    vi.mocked(put).mockReset();
    vi.mocked(list).mockReset();
    vi.mocked(del).mockReset();
    fetchMock.mockReset();
  });

  it("url(id) is derived without I/O from the base and the id", () => {
    expect(store().url(IMG)).toBe(`${BASE}/img/${HEX}`);
    expect(store().url(UP)).toBe(`${BASE}/up/${HEX}`);
    expect(() => store().url("img_nope")).toThrow("invalid image id");
    expect(put).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("idFromUrl: an upper-case host still matches; other paths and malformed ids don't", () => {
    const s = store();
    expect(s.idFromUrl(`${BASE}/img/${HEX}`)).toBe(IMG);
    expect(s.idFromUrl(`${BASE}/up/${HEX}`)).toBe(UP);
    expect(s.idFromUrl(`https://TESTSTORE01${BLOB_HOST_SUFFIX.toUpperCase()}/img/${HEX}`)).toBe(IMG);
    expect(s.idFromUrl(`${BASE}/img/${HEX}?v=1`)).toBe(IMG);
    for (const bad of [
      `https://other01${BLOB_HOST_SUFFIX}/img/${HEX}`,
      `${BASE}/other/${HEX}`,
      `${BASE}/img/${HEX.slice(1)}`,
      `${BASE}/img/${HEX.toUpperCase()}`,
      `${BASE}/img/${HEX}/extra`,
      `${BASE}/img/${HEX}/`,
      `${BASE}/img/`,
      `${BASE}/`,
      `${BASE}/up/%69mg/${HEX}`,
      `http://teststore01${BLOB_HOST_SUFFIX}/img/${HEX}`,
      `https://user@teststore01${BLOB_HOST_SUFFIX}/img/${HEX}`,
      `https://teststore01${BLOB_HOST_SUFFIX}:8443/img/${HEX}`,
      `https://teststore01${BLOB_HOST_SUFFIX}.example.test/img/${HEX}`,
      "not a url",
      "",
    ]) {
      expect(s.idFromUrl(bad), bad).toBeNull();
    }
  });

  it("put: up_ sets allowOverwrite and cacheControlMaxAge 60; the token is passed explicitly", async () => {
    vi.mocked(put).mockResolvedValue(putResult(`${BASE}/up/${HEX}`));
    const url = await store().put(UP, PNG_BYTES, PNG);
    expect(url).toBe(`${BASE}/up/${HEX}`);
    expect(put).toHaveBeenCalledTimes(1);
    const [pathname, body, options] = vi.mocked(put).mock.calls[0]!;
    expect(pathname).toBe(`up/${HEX}`);
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(Array.from(body as Buffer)).toEqual(Array.from(PNG_BYTES));
    expect(options).toEqual({
      access: "public",
      contentType: "image/png",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
      token: TOKEN,
    });
  });

  it("put: img_ sets neither allowOverwrite nor cacheControlMaxAge", async () => {
    vi.mocked(put).mockResolvedValue(putResult(`${BASE}/img/${HEX}`));
    await store().put(IMG, PNG_BYTES, { mime: "image/webp", width: 1, height: 1 });
    const [pathname, , options] = vi.mocked(put).mock.calls[0]!;
    expect(pathname).toBe(`img/${HEX}`);
    expect(options).toEqual({
      access: "public",
      contentType: "image/webp",
      addRandomSuffix: false,
      allowOverwrite: false,
      token: TOKEN,
    });
    expect(options).not.toHaveProperty("cacheControlMaxAge");
  });

  it("put: sends exactly the bytes of a view into a larger buffer", async () => {
    vi.mocked(put).mockResolvedValue(putResult(`${BASE}/up/${HEX}`));
    const pool = new Uint8Array(PNG_BYTES.length + 10);
    pool.set(PNG_BYTES, 5);
    await store().put(UP, pool.subarray(5, 5 + PNG_BYTES.length), PNG);
    const body = vi.mocked(put).mock.calls[0]![1] as Buffer;
    expect(Array.from(body)).toEqual(Array.from(PNG_BYTES));
  });

  it("put: a returned URL that differs only in case is fine; another base throws", async () => {
    const upper = `${BASE}/up/${HEX}`.replace("teststore01", "TESTSTORE01");
    vi.mocked(put).mockResolvedValue(putResult(upper));
    await expect(store().put(UP, PNG_BYTES, PNG)).resolves.toBe(`${BASE}/up/${HEX}`);

    vi.mocked(put).mockResolvedValue(putResult(`https://wrongstore${BLOB_HOST_SUFFIX}/up/${HEX}`));
    await expect(store().put(UP, PNG_BYTES, PNG)).rejects.toThrow("blob base URL mismatch");
  });

  it("put: an existing img_ object surfaces as 'image already exists'; other SDK errors pass through", async () => {
    vi.mocked(put).mockRejectedValueOnce(new Error("Vercel Blob: This blob already exists, use `allowOverwrite: true`"));
    await expect(store().put(IMG, PNG_BYTES, PNG)).rejects.toThrow("image already exists");

    vi.mocked(put).mockRejectedValueOnce(new Error("Vercel Blob: Access denied"));
    await expect(store().put(IMG, PNG_BYTES, PNG)).rejects.toThrow("Vercel Blob: Access denied");
  });

  it("put: rejects an id that is not an image id without calling the SDK", async () => {
    await expect(store().put("img_nope", PNG_BYTES, PNG)).rejects.toThrow("invalid image id");
    expect(put).not.toHaveBeenCalled();
  });

  it("get: fetches the public URL with a timeout signal and sniffs the bytes", async () => {
    fetchMock.mockResolvedValue(new Response(PNG_BYTES, { status: 200 }));
    const got = await store().get(IMG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE}/img/${HEX}`);
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
    expect(got?.info).toEqual(PNG);
    expect(got?.url).toBe(`${BASE}/img/${HEX}`);
    expect(Array.from(got!.bytes)).toEqual(Array.from(PNG_BYTES));
  });

  it("get: 404 is null; other failures throw without the URL; unsniffable bytes throw", async () => {
    fetchMock.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    expect(await store().get(IMG)).toBeNull();

    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 503 }));
    await expect(store().get(IMG)).rejects.toThrow(/^blob read failed: HTTP 503$/);

    fetchMock.mockResolvedValueOnce(new Response("<html>not an image</html>", { status: 200 }));
    await expect(store().get(IMG)).rejects.toThrow("stored object is not a supported image");
  });

  it("get: an id that is not an image id is null without any request", async () => {
    expect(await store().get("img_nope")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("get: aborts the request after 15 seconds", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          }),
      );
      const pending = store().get(IMG).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
      expect(await pending).toEqual(new Error("blob read timed out"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("listOlderThan: pages through img/ and up/, keeps only exact paths older than the cutoff", async () => {
    const blob = (pathname: string, uploadedAt: number) => ({
      url: `${BASE}/${pathname}`,
      downloadUrl: "",
      pathname,
      size: 1,
      uploadedAt: new Date(uploadedAt),
      etag: "e",
    });
    const A = "a".repeat(32);
    vi.mocked(list).mockImplementation((async (options?: { prefix?: string; cursor?: string }) => {
      if (options?.prefix === "img/" && !options.cursor) {
        return {
          blobs: [blob(`img/${HEX}`, 1_000), blob(`img/${OTHER_HEX}`, 9_000), blob("img/notes.txt", 1_000)],
          hasMore: true,
          cursor: "c1",
        };
      }
      if (options?.prefix === "img/") {
        return { blobs: [blob(`img/${A}`, 2_000), blob(`img/${HEX}/nested`, 1_000)], hasMore: false };
      }
      return { blobs: [blob(`up/${OTHER_HEX}`, 500), blob(`up/${"A".repeat(32)}`, 500)], hasMore: false };
    }) as never);

    const found = await store().listOlderThan(5_000);
    expect(found.map((f) => f.id)).toEqual([IMG, `img_${A}`, `up_${OTHER_HEX}`]);
    expect(found[0]!.url).toBe(`${BASE}/img/${HEX}`);
    const calls = vi.mocked(list).mock.calls.map((c) => c[0]);
    expect(calls.every((c) => c?.token === TOKEN)).toBe(true);
    expect(calls.map((c) => [c?.prefix, c?.cursor])).toEqual([
      ["img/", undefined],
      ["img/", "c1"],
      ["up/", undefined],
    ]);
  });

  it("delete: no SDK call for an empty list; larger lists go in batches with the token", async () => {
    vi.mocked(del).mockResolvedValue(undefined);
    await store().delete([]);
    expect(del).not.toHaveBeenCalled();

    const urls = Array.from({ length: 2_500 }, (_, i) => `${BASE}/img/${i.toString(16).padStart(32, "0")}`);
    await store().delete(urls);
    const calls = vi.mocked(del).mock.calls;
    expect(calls.map((c) => (c[0] as string[]).length)).toEqual([1_000, 1_000, 500]);
    expect(calls.flatMap((c) => c[0] as string[])).toEqual(urls);
    expect(calls.every((c) => c[1]?.token === TOKEN)).toBe(true);
  });
});
