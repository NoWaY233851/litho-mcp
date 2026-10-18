import { describe, expect, it } from "vitest";
import { runCleanup } from "../src/images/cleanup.js";
import { createMemoryStore } from "../src/images/store.js";
import type { ImageInfo } from "../src/images/sniff.js";

const DAY = 86_400_000;
const PNG: ImageInfo = { mime: "image/png", width: 1, height: 1 };
// A 1x1 PNG; the stores only accept bytes that sniff as an image.
const BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const id = (kind: "img" | "up", n: number) => `${kind}_${n.toString(16).padStart(32, "0")}`;

describe("runCleanup", () => {
  it("deletes only objects older than retentionDays and reports the count", async () => {
    const now = 100 * DAY;
    let clock = 0;
    const store = createMemoryStore("https://blob.example.test", () => clock);

    clock = now - 31 * DAY;
    await store.put(id("img", 1), BYTES, PNG);
    await store.put(id("up", 2), BYTES, PNG);
    clock = now - 29 * DAY;
    await store.put(id("img", 3), BYTES, PNG);
    clock = now - 1;
    await store.put(id("up", 4), BYTES, PNG);

    expect(await runCleanup(store, now, 30)).toEqual({ deleted: 2 });
    expect(await store.get(id("img", 1))).toBeNull();
    expect(await store.get(id("up", 2))).toBeNull();
    expect(await store.get(id("img", 3))).not.toBeNull();
    expect(await store.get(id("up", 4))).not.toBeNull();
  });

  it("keeps an object exactly at the retention boundary", async () => {
    const now = 100 * DAY;
    const store = createMemoryStore("https://blob.example.test", () => now - 30 * DAY);
    await store.put(id("img", 1), BYTES, PNG);
    expect(await runCleanup(store, now, 30)).toEqual({ deleted: 0 });
  });

  it("reports zero and makes no delete call when nothing is old", async () => {
    const calls: string[][] = [];
    const store = createMemoryStore();
    const spy = { ...store, delete: async (urls: string[]) => void calls.push(urls) };
    expect(await runCleanup(spy, 1_000, 30)).toEqual({ deleted: 0 });
    expect(calls.flat()).toEqual([]);
  });
});
