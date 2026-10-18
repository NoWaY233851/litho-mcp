import type { CallToolResult } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bytesToBase64 } from "../src/images/base64.js";
import type { ImageInfo } from "../src/images/sniff.js";
import { newImageId } from "../src/images/ids.js";
import { createMemoryStore } from "../src/images/store.js";
import { EditArgs, editImage, openUploader, uploadImageData } from "../src/mcp/tools.js";
import { MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, PublicFetchError } from "../src/net/public-fetch.js";
import { _resetModelCache } from "../src/openrouter/models.js";
import { PNG_B64, fakeDeps, fakeOpenRouter, fullEnv } from "./helpers.js";

const FLARE = "openai/gpt-image-2.5-flare";
const KREA = "krea/k3-edit";
const config = loadConfig({ ...fullEnv, DEFAULT_MODEL: FLARE });
const PNG = new Uint8Array(Buffer.from(PNG_B64, "base64"));
const PNG_INFO: ImageInfo = { mime: "image/png", width: 1, height: 1 };
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;
const BASE = "https://blob.example.test";

const hex = (n: number): string => n.toString(16).padStart(32, "0");
const IMG_A = `img_${hex(1)}`;
const IMG_B = `img_${hex(2)}`;
const UP_A = `up_${hex(3)}`;

// Header-only PNGs: the sniffer reads the IHDR and nothing else, which is all the size checks need.
function pngOfSize(width: number, height: number, total = 33): Uint8Array {
  const out = new Uint8Array(Math.max(total, 33));
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}

type FetchPublic = NonNullable<Parameters<typeof editImage>[2]>["fetchPublic"];

function setup(overrides: Parameters<typeof fakeOpenRouter>[0] = {}, extra: Parameters<typeof fakeDeps>[0] = {}) {
  const or = fakeOpenRouter(overrides);
  const logs: string[] = [];
  const store = createMemoryStore(BASE);
  const deps = fakeDeps({ config, fetch: or.f, log: (m) => logs.push(m), store, ...extra });
  const fetched: string[] = [];
  const fetchPublic = (impl: (url: string) => Promise<{ bytes: Uint8Array; info: ImageInfo }>): NonNullable<FetchPublic> =>
    (async (url: string) => {
      fetched.push(url);
      return impl(url);
    }) as NonNullable<FetchPublic>;
  return { or, logs, deps, store, fetched, fetchPublic };
}

const texts = (r: CallToolResult): string[] => r.content.flatMap((c) => (c.type === "text" ? [c.text] : []));
const refUrls = (body: Record<string, unknown> | undefined): string[] =>
  ((body?.input_references ?? []) as { image_url: { url: string } }[]).map((r) => r.image_url.url);

beforeEach(() => _resetModelCache());

describe("editImage", () => {
  it("edits from an image id: the reference is sent as a data URL and the result's parent is that id", async () => {
    const { or, deps, store } = setup();
    await store.put(IMG_A, PNG, PNG_INFO);
    const r = await editImage(deps, { prompt: "make it blue", image_ids: [IMG_A] });

    expect(r.isError).toBeFalsy();
    expect(or.posts()).toHaveLength(1);
    expect(or.posts()[0]!.body).toMatchObject({ model: FLARE, prompt: "make it blue" });
    expect(refUrls(or.posts()[0]!.body)).toEqual([PNG_DATA_URL]);

    const sc = r.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({ kind: "image", parent: IMG_A, id: expect.stringMatching(/^img_[0-9a-f]{32}$/) });
    expect(sc.id).not.toBe(IMG_A);
    expect(texts(r)).toContain(`edited from ${IMG_A}`);
    expect(r.content[0]).toMatchObject({ type: "image", mimeType: "image/webp" });
    // The original is untouched and the edit is a new object.
    expect(await store.get(sc.id as string)).not.toBeNull();
    expect(await store.get(IMG_A)).not.toBeNull();
  });

  it("accepts an uploaded photo id and keeps it as the parent", async () => {
    const { or, deps, store } = setup();
    await store.put(UP_A, PNG, PNG_INFO);
    const r = await editImage(deps, { prompt: "x", image_ids: [UP_A] });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ parent: UP_A });
    expect(refUrls(or.posts()[0]!.body)).toEqual([PNG_DATA_URL]);
  });

  it("reads this deployment's own Blob URL through the store, also with an upper-case host and a query, without an SSRF fetch", async () => {
    const { or, deps, store, fetched, fetchPublic } = setup();
    await store.put(IMG_A, PNG, PNG_INFO);
    await store.put(UP_A, PNG, PNG_INFO);
    const guard = fetchPublic(async () => {
      throw new Error("must not be called");
    });
    const r = await editImage(
      deps,
      {
        prompt: "x",
        image_urls: [`https://BLOB.Example.TEST/img/${IMG_A.slice(4)}?v=123`, `${BASE}/up/${UP_A.slice(3)}`],
      },
      { fetchPublic: guard },
    );
    expect(r.isError).toBeFalsy();
    expect(fetched).toEqual([]);
    expect(refUrls(or.posts()[0]!.body)).toEqual([PNG_DATA_URL, PNG_DATA_URL]);
    expect(r.structuredContent).toMatchObject({ parent: IMG_A });
  });

  it("an own URL whose object is gone reports the id, not a network failure", async () => {
    const { or, deps, fetched, fetchPublic } = setup();
    const r = await editImage(
      deps,
      { prompt: "x", image_urls: [`https://BLOB.EXAMPLE.TEST/up/${UP_A.slice(3)}?v=9`] },
      { fetchPublic: fetchPublic(async () => ({ bytes: PNG, info: PNG_INFO })) },
    );
    expect(r.isError).toBe(true);
    expect(texts(r)).toEqual([`Photo ${UP_A} has not been uploaded yet, or it expired.`]);
    expect(fetched).toEqual([]);
    expect(or.posts()).toHaveLength(0);
  });

  it("a missing, expired or malformed img_ id says it was not found; a missing up_ id says it was not uploaded; OpenRouter is never called", async () => {
    const { or, deps } = setup();
    const missing = await editImage(deps, { prompt: "x", image_ids: [IMG_B] });
    expect(texts(missing)).toEqual([`Image ${IMG_B} was not found; it may have expired after the retention period.`]);
    expect(missing.isError).toBe(true);

    const malformed = await editImage(deps, { prompt: "x", image_ids: ["img_nope"] });
    expect(texts(malformed)).toEqual(["Image img_nope was not found; it may have expired after the retention period."]);

    const upload = await editImage(deps, { prompt: "x", image_ids: [UP_A] });
    expect(texts(upload)).toEqual([`Photo ${UP_A} has not been uploaded yet, or it expired.`]);

    expect([missing, malformed, upload].every((r) => r.isError)).toBe(true);
    expect(or.calls.filter((c) => c.url.endsWith("/images"))).toHaveLength(0);
    expect(or.posts()).toHaveLength(0);
  });

  it("rejects a malformed id before any load, fetch or catalog request", async () => {
    const { or, deps, fetched, fetchPublic } = setup();
    let reads = 0;
    const get = deps.store.get.bind(deps.store);
    deps.store.get = async (id) => {
      reads += 1;
      return get(id);
    };
    const r = await editImage(
      deps,
      { prompt: "x", image_ids: [IMG_A, "../etc/passwd"], image_urls: ["https://example.test/a.png"] },
      { fetchPublic: fetchPublic(async () => ({ bytes: PNG, info: PNG_INFO })) },
    );
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toContain("../etc/passwd");
    expect(reads).toBe(0);
    expect(fetched).toEqual([]);
    expect(or.calls).toHaveLength(0);
  });

  it("requires at least one reference, with no catalog or OpenRouter request", async () => {
    const { or, deps } = setup();
    for (const args of [{ prompt: "x" }, { prompt: "x", image_ids: [], image_urls: [] }]) {
      const r = await editImage(deps, args);
      expect(r.isError).toBe(true);
      expect(texts(r)[0]).toMatch(/at least one reference image/);
    }
    expect(or.calls).toHaveLength(0);
  });

  it("too many references for the model is an error before anything is loaded or fetched", async () => {
    const { or, deps, fetched, fetchPublic } = setup();
    let reads = 0;
    const get = deps.store.get.bind(deps.store);
    deps.store.get = async (id) => {
      reads += 1;
      return get(id);
    };
    const urls = Array.from({ length: 9 }, (_, i) => `https://example.test/${i}.png`);
    const r = await editImage(
      deps,
      { prompt: "x", model: KREA, image_ids: [IMG_A], image_urls: urls },
      { fetchPublic: fetchPublic(async () => ({ bytes: PNG, info: PNG_INFO })) },
    );
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toContain("accepts at most 8 reference images, but 10 were given");
    expect(reads).toBe(0);
    expect(fetched).toEqual([]);
    expect(or.posts()).toHaveLength(0);
  });

  it("a model that cannot edit, and an unknown model, are errors before any load", async () => {
    const { or, deps, store } = setup();
    await store.put(IMG_A, PNG, PNG_INFO);
    const cannot = await editImage(deps, { prompt: "x", model: "recraft/recraft-v4.1-flash", image_ids: [IMG_A] });
    expect(texts(cannot)[0]).toContain("cannot edit images");
    const unknown = await editImage(deps, { prompt: "x", model: "nope/missing", image_ids: [IMG_A] });
    expect(texts(unknown)[0]).toContain('Unknown model "nope/missing"');
    expect(or.posts()).toHaveLength(0);
  });

  it("validates the image parameters against the model", async () => {
    const { or, deps, store } = setup();
    await store.put(IMG_A, PNG, PNG_INFO);
    const r = await editImage(deps, { prompt: "x", model: KREA, image_ids: [IMG_A], quality: "high" });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toContain('does not support "quality"');
    expect(or.posts()).toHaveLength(0);
  });

  it("an external URL is fetched with fetchPublicImage and sent as a server-built data URL; with no stored reference there is no parent", async () => {
    const { or, deps, fetched, fetchPublic } = setup();
    const r = await editImage(
      deps,
      { prompt: "x", image_urls: ["https://images.example.test/a.png"] },
      { fetchPublic: fetchPublic(async () => ({ bytes: PNG, info: PNG_INFO })) },
    );
    expect(r.isError).toBeFalsy();
    expect(fetched).toEqual(["https://images.example.test/a.png"]);
    expect(refUrls(or.posts()[0]!.body)).toEqual([PNG_DATA_URL]);
    expect(JSON.stringify(or.posts()[0]!.body)).not.toContain("images.example.test");
    expect(r.structuredContent).not.toHaveProperty("parent");
    expect(texts(r).some((t) => t.startsWith("edited from"))).toBe(false);
  });

  it("the data URL's type comes from the sniffed bytes", async () => {
    const { or, deps, fetchPublic } = setup();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xd9]);
    await editImage(
      deps,
      { prompt: "x", image_urls: ["https://images.example.test/a.png"] },
      { fetchPublic: fetchPublic(async () => ({ bytes: jpeg, info: { mime: "image/jpeg", width: 3, height: 2 } })) },
    );
    expect(refUrls(or.posts()[0]!.body)).toEqual([`data:image/jpeg;base64,${bytesToBase64(jpeg)}`]);
  });

  it("the parent is the first stored reference, even when external URLs come before it in the list", async () => {
    const { deps, store, fetchPublic } = setup();
    await store.put(IMG_A, PNG, PNG_INFO);
    await store.put(IMG_B, PNG, PNG_INFO);
    const r = await editImage(
      deps,
      { prompt: "x", image_ids: [], image_urls: ["https://images.example.test/a.png", `${BASE}/img/${IMG_B.slice(4)}`, `${BASE}/img/${IMG_A.slice(4)}`] },
      { fetchPublic: fetchPublic(async () => ({ bytes: PNG, info: PNG_INFO })) },
    );
    expect(r.structuredContent).toMatchObject({ parent: IMG_B });
  });

  it("references keep their order: ids first, then URLs", async () => {
    const { or, deps, store, fetchPublic } = setup();
    await store.put(IMG_A, PNG, PNG_INFO);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xd9]);
    await editImage(
      deps,
      { prompt: "x", image_ids: [IMG_A], image_urls: ["https://images.example.test/a.jpg"] },
      { fetchPublic: fetchPublic(async () => ({ bytes: jpeg, info: { mime: "image/jpeg", width: 3, height: 2 } })) },
    );
    expect(refUrls(or.posts()[0]!.body).map((u) => u.slice(0, 15))).toEqual(["data:image/png;", "data:image/jpeg"]);
  });

  it("a blocked URL is an error naming the reason; OpenRouter is not called", async () => {
    const { or, deps, fetchPublic } = setup();
    const r = await editImage(
      deps,
      { prompt: "x", image_urls: ["http://internal.example.test/a.png"] },
      {
        fetchPublic: fetchPublic(async () => {
          throw new PublicFetchError("blocked_host");
        }),
      },
    );
    expect(r.isError).toBe(true);
    const [message] = texts(r);
    expect(message).toContain("blocked_host");
    expect(message).toContain("http://internal.example.test/a.png");
    expect(or.posts()).toHaveLength(0);
  });

  it("uses the real SSRF guard by default: a loopback address is refused without any network access", async () => {
    const { or, deps } = setup();
    const r = await editImage(deps, { prompt: "x", image_urls: ["http://127.0.0.1/a.png"] });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toMatch(/invalid_url|blocked_host/);
    expect(or.posts()).toHaveLength(0);
  });

  it("truncates a long URL in the failure message", async () => {
    const { deps, fetchPublic } = setup();
    const url = `https://images.example.test/${"a".repeat(5000)}.png`;
    const r = await editImage(
      deps,
      { prompt: "x", image_urls: [url] },
      {
        fetchPublic: fetchPublic(async () => {
          throw new PublicFetchError("not_image");
        }),
      },
    );
    const [message] = texts(r);
    expect(message).toContain("not_image");
    expect(message!.length).toBeLessThan(450);
    expect(message).not.toContain("a".repeat(300));
  });

  it("reports the first failing reference in input order, not the fastest: a slow id before a fast URL failure", async () => {
    const { deps, fetchPublic } = setup();
    deps.store.get = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return null;
    };
    const r = await editImage(
      deps,
      { prompt: "x", image_ids: [IMG_B], image_urls: ["https://images.example.test/a.png"] },
      {
        fetchPublic: fetchPublic(async () => {
          throw new PublicFetchError("http_error");
        }),
      },
    );
    expect(texts(r)).toEqual([`Image ${IMG_B} was not found; it may have expired after the retention period.`]);
  });

  it("loads each distinct id once, however often it is listed, but every occurrence is sent and counted", async () => {
    const { or, deps, store } = setup();
    await store.put(IMG_A, PNG, PNG_INFO);
    let reads = 0;
    const get = store.get.bind(store);
    store.get = async (id) => {
      reads += 1;
      return get(id);
    };
    const r = await editImage(deps, { prompt: "x", image_ids: Array(16).fill(IMG_A) });
    expect(r.isError).toBeFalsy();
    expect(reads).toBe(1);
    expect(refUrls(or.posts()[0]!.body)).toEqual(Array(16).fill(PNG_DATA_URL));
  });

  it("counts every repeated occurrence toward the total size cap", async () => {
    const { or, deps, store } = setup();
    await store.put(IMG_A, pngOfSize(100, 100, MAX_IMAGE_BYTES), { mime: "image/png", width: 100, height: 100 });
    const r = await editImage(deps, { prompt: "x", image_ids: Array(5).fill(IMG_A) });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toMatch(/40 MiB/);
    expect(or.posts()).toHaveLength(0);
  });

  it("an own URL and the same id share one read", async () => {
    const { deps, store } = setup();
    await store.put(IMG_A, PNG, PNG_INFO);
    let reads = 0;
    const get = store.get.bind(store);
    store.get = async (id) => {
      reads += 1;
      return get(id);
    };
    await editImage(deps, { prompt: "x", image_ids: [IMG_A], image_urls: [`${BASE}/img/${IMG_A.slice(4)}`] });
    expect(reads).toBe(1);
  });

  it("an oversized stored object is reported for that id and OpenRouter is not called", async () => {
    const { or, deps } = setup();
    deps.store.get = async () => {
      throw new Error("stored object too large");
    };
    const r = await editImage(deps, { prompt: "x", image_ids: [IMG_A] });
    expect(r.isError).toBe(true);
    expect(texts(r)).toEqual([`Image ${IMG_A} is too large to use as a reference.`]);
    expect(or.posts()).toHaveLength(0);

    const long = await editImage(deps, { prompt: "x", image_urls: [`${BASE}/img/${IMG_A.slice(4)}`] });
    expect(texts(long)).toEqual([`Image ${IMG_A} is too large to use as a reference.`]);
  });

  it("a malformed up_ id gets the not-found wording; only a well-formed one is 'not uploaded yet'", async () => {
    const { deps } = setup();
    const malformed = await editImage(deps, { prompt: "x", image_ids: ["up_xyz"] });
    expect(texts(malformed)).toEqual(["Image up_xyz was not found; it may have expired after the retention period."]);
    const wellFormed = await editImage(deps, { prompt: "x", image_ids: [UP_A] });
    expect(texts(wellFormed)).toEqual([`Photo ${UP_A} has not been uploaded yet, or it expired.`]);
  });

  it("caps the total size of the references and says so before any data URL is built", async () => {
    const { or, deps, fetchPublic } = setup();
    const big = pngOfSize(100, 100, MAX_IMAGE_BYTES);
    const urls = Array.from({ length: 5 }, (_, i) => `https://images.example.test/${i}.png`);
    const r = await editImage(
      deps,
      { prompt: "x", image_urls: urls },
      { fetchPublic: fetchPublic(async () => ({ bytes: big, info: { mime: "image/png", width: 100, height: 100 } })) },
    );
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toMatch(/40 MiB/);
    expect(or.posts()).toHaveLength(0);
  });

  it("an upstream failure after the references loaded is reported through the shared failure path", async () => {
    const { deps, store } = setup({
      images: () => Response.json({ error: { code: 502, message: "upstream" } }, { status: 502 }),
    });
    await store.put(IMG_A, PNG, PNG_INFO);
    const r = await editImage(deps, { prompt: "x", image_ids: [IMG_A] });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toContain("You were not charged");
  });

  it("a store failure after a successful edit says the image was generated but not saved", async () => {
    const { deps, store } = setup();
    await store.put(IMG_A, PNG, PNG_INFO);
    store.put = async () => {
      throw new Error("blob unavailable");
    };
    const r = await editImage(deps, { prompt: "x", image_ids: [IMG_A] });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toMatch(/generated but could not be saved/);
    expect(texts(r)[0]).toContain("$0.04");
  });

  it("an unexpected read failure is a fixed message; the error text goes to the log only", async () => {
    const { or, deps, logs } = setup();
    deps.store.get = async () => {
      throw new Error("blob read failed: HTTP 500");
    };
    const r = await editImage(deps, { prompt: "secret prompt", image_ids: [IMG_A] });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain("HTTP 500");
    expect(logs).toEqual(["unexpected error: blob read failed: HTTP 500"]);
    expect(or.posts()).toHaveLength(0);
  });

  it("truncates an oversized model id in the unknown-model message", async () => {
    const { deps, store } = setup();
    await store.put(IMG_A, PNG, PNG_INFO);
    const r = await editImage(deps, { prompt: "x", model: "m".repeat(10_000), image_ids: [IMG_A] });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]!.length).toBeLessThan(400);
    expect(texts(r)[0]).toContain("Unknown model");
  });

  it("truncates an oversized id in the not-found message", async () => {
    const { deps } = setup();
    const r = await editImage(deps, { prompt: "x", image_ids: ["img_" + "z".repeat(10_000)] });
    expect(texts(r)[0]!.length).toBeLessThan(400);
  });
});

describe("EditArgs", () => {
  it("requires a prompt and bounds the reference lists at 16 each", () => {
    expect(EditArgs.safeParse({ prompt: "" }).success).toBe(false);
    expect(EditArgs.safeParse({ prompt: "a", image_ids: Array(16).fill(IMG_A) }).success).toBe(true);
    expect(EditArgs.safeParse({ prompt: "a", image_ids: Array(17).fill(IMG_A) }).success).toBe(false);
    expect(EditArgs.safeParse({ prompt: "a", image_urls: Array(17).fill("https://x.test/a.png") }).success).toBe(false);
    expect(EditArgs.safeParse({ prompt: "a", model: "m", aspect_ratio: "1:1" }).success).toBe(true);
  });
});

describe("openUploader", () => {
  it("returns a fresh well-formed up_ id in the text and structuredContent and writes nothing", () => {
    const { deps, store } = setup();
    let writes = 0;
    store.put = async () => {
      writes += 1;
      return "";
    };
    const a = openUploader(deps);
    const b = openUploader(deps);
    const sc = a.structuredContent as { kind: string; id: string; url: string };
    expect(sc.kind).toBe("upload");
    expect(sc.id).toMatch(/^up_[0-9a-f]{32}$/);
    expect(sc.url).toBe(`${BASE}/up/${sc.id.slice(3)}`);
    expect(texts(a)).toEqual([
      `Upload slot ${sc.id}. The photo will be available as ${sc.id} once the user uploads it; then use it with edit_image.`,
    ]);
    expect((b.structuredContent as { id: string }).id).not.toBe(sc.id);
    expect(a.isError).toBeFalsy();
    expect(writes).toBe(0);
  });
});

describe("uploadImageData", () => {
  it("stores the photo at the given id with the sniffed size, and a second upload replaces it", async () => {
    const { deps, store } = setup();
    const id = newImageId("up");
    const first = await uploadImageData(deps, { id, data: PNG_B64 });
    expect(first.isError).toBeFalsy();
    expect(texts(first)).toEqual([`Uploaded ${id} (1×1).`]);
    expect(first.structuredContent).toEqual({ kind: "uploaded", id, width: 1, height: 1 });
    expect((await store.get(id))!.info).toMatchObject({ mime: "image/png", width: 1, height: 1 });

    const bigger = pngOfSize(640, 480);
    const second = await uploadImageData(deps, { id, data: bytesToBase64(bigger) });
    expect(second.structuredContent).toEqual({ kind: "uploaded", id, width: 640, height: 480 });
    expect((await store.get(id))!.info).toMatchObject({ width: 640, height: 480 });
  });

  it("an uploaded photo can be edited right away", async () => {
    const { or, deps } = setup();
    const id = newImageId("up");
    await uploadImageData(deps, { id, data: PNG_B64 });
    const r = await editImage(deps, { prompt: "x", image_ids: [id] });
    expect(r.structuredContent).toMatchObject({ parent: id });
    expect(refUrls(or.posts()[0]!.body)).toEqual([PNG_DATA_URL]);
  });

  it("rejects img_ and malformed ids, and echoes them truncated", async () => {
    const { deps, store } = setup();
    for (const id of [IMG_A, "up_xyz", `up_${"A".repeat(32)}`, `up_${hex(1)}0`, "", "../up/" + hex(1)]) {
      const r = await uploadImageData(deps, { id, data: PNG_B64 });
      expect(r.isError, id).toBe(true);
    }
    const long = await uploadImageData(deps, { id: "up_" + "q".repeat(10_000), data: PNG_B64 });
    expect(texts(long)[0]!.length).toBeLessThan(400);
    expect(await store.get(IMG_A)).toBeNull();
  });

  it("rejects a data: prefix", async () => {
    const { deps } = setup();
    const r = await uploadImageData(deps, { id: UP_A, data: `data:image/png;base64,${PNG_B64}` });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toMatch(/data: prefix/);
  });

  it("rejects bad base64 without echoing it", async () => {
    const { deps, store } = setup();
    const secret = "not base64 !!! SECRET-PAYLOAD";
    const r = await uploadImageData(deps, { id: UP_A, data: secret });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain("SECRET-PAYLOAD");
    expect(await store.get(UP_A)).toBeNull();
    const padded = await uploadImageData(deps, { id: UP_A, data: "iVBORw0K=GgoAAAAN" });
    expect(padded.isError).toBe(true);
  });

  it("rejects bytes that are not a PNG, JPEG or WebP", async () => {
    const { deps, store } = setup();
    const r = await uploadImageData(deps, { id: UP_A, data: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64") });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toMatch(/PNG, JPEG or WebP/);
    expect(await store.get(UP_A)).toBeNull();
  });

  it("rejects an image over 8192 px on a side, and accepts exactly 8192", async () => {
    const { deps } = setup();
    const over = await uploadImageData(deps, { id: UP_A, data: bytesToBase64(pngOfSize(MAX_IMAGE_SIDE + 1, 10)) });
    expect(over.isError).toBe(true);
    expect(texts(over)[0]).toContain("8192");
    const tall = await uploadImageData(deps, { id: UP_A, data: bytesToBase64(pngOfSize(10, MAX_IMAGE_SIDE + 1)) });
    expect(tall.isError).toBe(true);
    const edge = await uploadImageData(deps, { id: UP_A, data: bytesToBase64(pngOfSize(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE)) });
    expect(edge.isError).toBeFalsy();
  });

  it("rejects more than 10 MiB, by length before decoding, and stores nothing", async () => {
    const { deps, store } = setup();
    const over = pngOfSize(10, 10, MAX_IMAGE_BYTES + 1);
    const r = await uploadImageData(deps, { id: UP_A, data: bytesToBase64(over) });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toMatch(/10 MiB/);
    // Garbage of the right length is refused for its size, not for being garbage.
    const filler = await uploadImageData(deps, { id: UP_A, data: "A".repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) });
    expect(texts(filler)[0]).toMatch(/10 MiB/);
    expect(await store.get(UP_A)).toBeNull();
    const exact = await uploadImageData(deps, { id: UP_A, data: bytesToBase64(pngOfSize(10, 10, MAX_IMAGE_BYTES)) });
    expect(exact.isError).toBeFalsy();
  });

  it("a store failure is a fixed message and the error text goes to the log", async () => {
    const { deps, store, logs } = setup();
    store.put = async () => {
      throw new Error("blob unavailable");
    };
    const r = await uploadImageData(deps, { id: UP_A, data: PNG_B64 });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain("blob unavailable");
    expect(logs).toEqual(["upload save failed: blob unavailable"]);
  });
});
