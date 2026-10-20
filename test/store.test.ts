import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob", () => ({
  put: vi.fn(),
  list: vi.fn(),
  del: vi.fn(),
}));

import { del, list, put } from "@vercel/blob";
import { MAX_STORED_READ_BYTES, READ_BUDGET_EXCEEDED_MESSAGE, readBudget } from "../src/images/limits.js";
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

const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');

type PutResult = Awaited<ReturnType<typeof put>>;
const putResult = (url: string): PutResult => ({ url }) as PutResult;

describe("blobBaseUrl", () => {
  it("builds https://<id> + BLOB_HOST_SUFFIX", () => {
    expect(BLOB_HOST_SUFFIX.startsWith(".")).toBe(true);
    expect(blobBaseUrl("teststore01")).toBe(`https://teststore01${BLOB_HOST_SUFFIX}`);
  });
});

describe("readBudget", () => {
  it("charges a take that fits", () => {
    const budget = readBudget(10);
    expect(budget.take(4)).toBe(true);
    expect(budget.take(6)).toBe(true);
  });

  it("refuses a take that would pass the limit and charges nothing for it", () => {
    const budget = readBudget(10);
    expect(budget.take(7)).toBe(true);
    expect(budget.take(4)).toBe(false);
    // The refused 4 was not charged, so the remaining 3 are still available.
    expect(budget.take(3)).toBe(true);
  });

  it("accepts exactly the remaining amount and then refuses one more byte", () => {
    const budget = readBudget(10);
    expect(budget.take(10)).toBe(true);
    expect(budget.take(1)).toBe(false);
  });
});

describe("memory store", () => {
  it("put/get round-trip; url(id) equals the URL put returns", async () => {
    const store = createMemoryStore();
    const url = await store.put(IMG, PNG_BYTES);
    expect(url).toBe(store.url(IMG));
    expect(url).toBe(`https://blob.example.test/img/${HEX}`);
    const got = await store.get(IMG);
    expect(got?.url).toBe(url);
    expect(got?.info).toEqual(PNG);
    expect(Array.from(got!.bytes)).toEqual(Array.from(PNG_BYTES));
    expect(await store.get(`img_${OTHER_HEX}`)).toBeNull();
  });

  it("get: charges the object's size to a budget and refuses one that does not fit", async () => {
    const store = createMemoryStore();
    await store.put(IMG, PNG_BYTES);
    const budget = readBudget(PNG_BYTES.length);
    expect((await store.get(IMG, budget))?.info).toEqual(PNG);
    await expect(store.get(IMG, budget)).rejects.toThrow(READ_BUDGET_EXCEEDED_MESSAGE);
  });

  it("get: refuses an object over 40 MiB instead of returning it", async () => {
    const store = createMemoryStore();
    const big = new Uint8Array(MAX_STORED_READ_BYTES + 1);
    big.set(PNG_BYTES);
    await store.put(IMG, big);
    await expect(store.get(IMG)).rejects.toThrow("stored object too large");
    const atLimit = new Uint8Array(MAX_STORED_READ_BYTES);
    atLimit.set(PNG_BYTES);
    await store.put(UP, atLimit);
    expect((await store.get(UP))?.bytes.length).toBe(MAX_STORED_READ_BYTES);
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
    await store.put(IMG, PNG_BYTES);
    await expect(store.put(IMG, PNG_BYTES)).rejects.toThrow("image already exists");
    await store.put(UP, PNG_BYTES);
    const wider = PNG_BYTES.slice();
    wider[19] = 2; // IHDR width; the header is all the sniffer reads
    await store.put(UP, wider);
    expect((await store.get(UP))?.info).toEqual({ mime: "image/png", width: 2, height: 1 });
  });

  it("put rejects bytes that are not a supported image and stores nothing", async () => {
    const store = createMemoryStore();
    await expect(store.put(UP, SVG_BYTES)).rejects.toThrow("not a supported image");
    expect(await store.get(UP)).toBeNull();
  });

  it("listOlderThan and delete follow the upload time", async () => {
    let now = 1_000;
    const store = createMemoryStore("https://blob.example.test", () => now);
    await store.put(IMG, PNG_BYTES);
    now = 5_000;
    await store.put(UP, PNG_BYTES);
    const old = await store.listOlderThan(3_000);
    expect(old).toEqual([{ id: IMG, url: store.url(IMG) }]);
    await store.delete(old.map((o) => o.url));
    expect(await store.get(IMG)).toBeNull();
    expect(await store.get(UP)).not.toBeNull();
  });
});

describe("blob store", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const store = () => createBlobStore({ token: TOKEN }, BASE, fetchMock);

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
    const url = await store().put(UP, PNG_BYTES);
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

  it("put: img_ sets neither allowOverwrite nor cacheControlMaxAge, and the contentType comes from the bytes", async () => {
    vi.mocked(put).mockResolvedValue(putResult(`${BASE}/img/${HEX}`));
    await store().put(IMG, PNG_BYTES);
    const [pathname, , options] = vi.mocked(put).mock.calls[0]!;
    expect(pathname).toBe(`img/${HEX}`);
    expect(options).toEqual({
      access: "public",
      contentType: "image/png",
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
    await store().put(UP, pool.subarray(5, 5 + PNG_BYTES.length));
    const body = vi.mocked(put).mock.calls[0]![1] as Buffer;
    expect(Array.from(body)).toEqual(Array.from(PNG_BYTES));
  });

  it("put: a returned URL that differs only in case is fine; another base throws", async () => {
    const upper = `${BASE}/up/${HEX}`.replace("teststore01", "TESTSTORE01");
    vi.mocked(put).mockResolvedValue(putResult(upper));
    await expect(store().put(UP, PNG_BYTES)).resolves.toBe(`${BASE}/up/${HEX}`);

    vi.mocked(put).mockResolvedValue(putResult(`https://wrongstore${BLOB_HOST_SUFFIX}/up/${HEX}`));
    await expect(store().put(UP, PNG_BYTES)).rejects.toThrow("blob base URL mismatch");
  });

  it("put: an existing img_ object surfaces as 'image already exists'; other SDK errors pass through", async () => {
    vi.mocked(put).mockRejectedValueOnce(new Error("Vercel Blob: This blob already exists, use `allowOverwrite: true`"));
    await expect(store().put(IMG, PNG_BYTES)).rejects.toThrow("image already exists");

    vi.mocked(put).mockRejectedValueOnce(new Error("Vercel Blob: Access denied"));
    await expect(store().put(IMG, PNG_BYTES)).rejects.toThrow("Vercel Blob: Access denied");
  });

  it("put: SVG bytes are rejected before the SDK is called", async () => {
    await expect(store().put(UP, SVG_BYTES)).rejects.toThrow("not a supported image");
    expect(put).not.toHaveBeenCalled();
  });

  it("put: rejects an id that is not an image id without calling the SDK", async () => {
    await expect(store().put("img_nope", PNG_BYTES)).rejects.toThrow("invalid image id");
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

  it("get: cancels the unread body on 404 and on other failures", async () => {
    const cancelled: string[] = [];
    const response = (status: number) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled.push(String(status));
          },
        }),
        { status },
      );
    fetchMock.mockResolvedValueOnce(response(404));
    expect(await store().get(IMG)).toBeNull();
    fetchMock.mockResolvedValueOnce(response(500));
    await expect(store().get(IMG)).rejects.toThrow("blob read failed: HTTP 500");
    expect(cancelled).toEqual(["404", "500"]);
  });

  it("get: refuses a declared content-length over 40 MiB without reading the body", async () => {
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { "content-length": String(MAX_STORED_READ_BYTES + 1) } }),
    );
    await expect(store().get(IMG)).rejects.toThrow("stored object too large");
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThanOrEqual(1);
  });

  it("get: counts streamed bytes when no length is declared and cancels once over 40 MiB", async () => {
    const chunk = 8 * 1024 * 1024;
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(chunk));
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
    await expect(store().get(IMG)).rejects.toThrow("stored object too large");
    expect(cancelled).toBe(true);
    // Five chunks fit exactly; the sixth crosses the limit. A pull-based stream is not read ahead far.
    expect(pulls).toBeLessThanOrEqual(8);
  });

  it("get: a read stops once its chunks pass the budget", async () => {
    const chunk = 512 * 1024;
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls >= 8) return controller.close();
        pulls += 1;
        controller.enqueue(new Uint8Array(chunk));
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
    await expect(store().get(IMG, readBudget(1024 * 1024))).rejects.toThrow(READ_BUDGET_EXCEEDED_MESSAGE);
    expect(cancelled).toBe(true);
    // Two chunks fit and the third is refused; the stream itself is always one chunk ahead of the reader.
    expect(pulls).toBeLessThanOrEqual(4);
  });

  it("get: a body that lies about a small length is still counted", async () => {
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 * 1024));
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { "content-length": "10" } }));
    await expect(store().get(IMG)).rejects.toThrow("stored object too large");
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

  it("listOlderThan: stops when a cursor repeats, instead of looping", async () => {
    vi.mocked(list).mockResolvedValue({ blobs: [], hasMore: true, cursor: "stuck" } as never);
    await expect(store().listOlderThan(5_000)).rejects.toThrow("blob list did not advance");
    // First page, then the repeat is detected on the second.
    expect(vi.mocked(list)).toHaveBeenCalledTimes(2);
  });

  it("listOlderThan: gives up after 50 pages for one prefix", async () => {
    let n = 0;
    vi.mocked(list).mockImplementation((async () => ({ blobs: [], hasMore: true, cursor: `c${n++}` })) as never);
    await expect(store().listOlderThan(5_000)).rejects.toThrow("blob list exceeded page limit");
    expect(vi.mocked(list)).toHaveBeenCalledTimes(50);
  });

  it("OIDC auth passes storeId and no token to put, list and del", async () => {
    const oidc = createBlobStore({ storeId: "store_TestStore01" }, BASE, fetchMock);
    vi.mocked(put).mockResolvedValue(putResult(`${BASE}/up/${HEX}`));
    vi.mocked(list).mockResolvedValue({ blobs: [], hasMore: false } as never);
    vi.mocked(del).mockResolvedValue(undefined);

    await oidc.put(UP, PNG_BYTES);
    await oidc.listOlderThan(5_000);
    await oidc.delete([`${BASE}/img/${HEX}`]);

    const optionSets = [
      vi.mocked(put).mock.calls[0]![2],
      ...vi.mocked(list).mock.calls.map((c) => c[0]),
      vi.mocked(del).mock.calls[0]![1],
    ];
    expect(optionSets).toHaveLength(4);
    for (const opts of optionSets) {
      expect(opts).toHaveProperty("storeId", "store_TestStore01");
      expect(opts).not.toHaveProperty("token");
    }
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
