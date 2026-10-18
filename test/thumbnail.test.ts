import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../src/images/base64.js";
import { sniffImage } from "../src/images/sniff.js";
import { makeThumbnail, sharpThumbnailer, THUMBNAIL_BASE64_BUDGET, type Thumbnailer } from "../src/images/thumbnail.js";

// base64 length of n bytes is 4 * ceil(n / 3), so 225_000 bytes is exactly 300_000 characters.
const BUDGET_BYTES = 225_000;
const INPUT = new Uint8Array([1, 2, 3]);

function scripted(sizes: (number | Error)[]): Thumbnailer & { edges: number[] } {
  const edges: number[] = [];
  return {
    edges,
    async toWebp(_bytes, edge) {
      edges.push(edge);
      const next = sizes[edges.length - 1]!;
      if (next instanceof Error) throw next;
      return new Uint8Array(next);
    },
  };
}

describe("makeThumbnail", () => {
  it("states the 300_000 character budget", () => {
    expect(THUMBNAIL_BASE64_BUDGET).toBe(300_000);
  });

  it("returns the first result within budget, trying 1024 first", async () => {
    const t = scripted([1_000]);
    const result = await makeThumbnail(t, INPUT);
    expect(t.edges).toEqual([1024]);
    expect(result?.mimeType).toBe("image/webp");
    expect(result?.data).toBe(bytesToBase64(new Uint8Array(1_000)));
  });

  it("accepts exactly 300_000 characters", async () => {
    const result = await makeThumbnail(scripted([BUDGET_BYTES]), INPUT);
    expect(result?.data.length).toBe(300_000);
  });

  it("walks 1024, 768, 512 when results are over budget", async () => {
    const t = scripted([BUDGET_BYTES + 1, BUDGET_BYTES + 100, 50_000]);
    const result = await makeThumbnail(t, INPUT);
    expect(t.edges).toEqual([1024, 768, 512]);
    expect(result?.data.length).toBe(bytesToBase64(new Uint8Array(50_000)).length);
  });

  it("stops at 768 when that fits", async () => {
    const t = scripted([BUDGET_BYTES + 1, 10]);
    await makeThumbnail(t, INPUT);
    expect(t.edges).toEqual([1024, 768]);
  });

  it("returns null when every edge is over budget", async () => {
    const t = scripted([BUDGET_BYTES + 1, BUDGET_BYTES + 1, BUDGET_BYTES + 1]);
    expect(await makeThumbnail(t, INPUT)).toBeNull();
    expect(t.edges).toEqual([1024, 768, 512]);
  });

  it("returns null when the thumbnailer throws", async () => {
    expect(await makeThumbnail(scripted([new Error("decode failed")]), INPUT)).toBeNull();
    // A failure on a later edge also ends in null: the caller falls back to text only.
    expect(await makeThumbnail(scripted([BUDGET_BYTES + 1, new Error("late")]), INPUT)).toBeNull();
  });
});

async function noisyPng(width: number, height: number): Promise<Uint8Array> {
  const raw = Buffer.alloc(width * height * 3);
  // Deterministic pseudo-noise; the exact bytes do not matter.
  let x = 123456789;
  for (let i = 0; i < raw.length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    raw[i] = x >>> 24;
  }
  return new Uint8Array(await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer());
}

describe("sharpThumbnailer", () => {
  it("shrinks a 1536x1024 PNG to a WebP with a 1024 px long edge", async () => {
    const out = await sharpThumbnailer.toWebp(await noisyPng(1536, 1024), 1024);
    const info = sniffImage(out);
    expect(info?.mime).toBe("image/webp");
    expect(info?.width).toBe(1024);
    expect(info?.height).toBe(683);
  });

  it("honours a smaller edge", async () => {
    const info = sniffImage(await sharpThumbnailer.toWebp(await noisyPng(1536, 1024), 512));
    expect(Math.max(info!.width, info!.height)).toBe(512);
  });

  it("never enlarges a 300x200 input", async () => {
    const info = sniffImage(await sharpThumbnailer.toWebp(await noisyPng(300, 200), 1024));
    expect(info).toMatchObject({ mime: "image/webp", width: 300, height: 200 });
  });

  it("applies the EXIF orientation, so a camera photo is not shown sideways", async () => {
    // 200x100 stored pixels with orientation 6 (rotate 90 degrees clockwise to display).
    const stored = new Uint8Array(
      await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 200, g: 40, b: 40 } } })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer(),
    );
    expect(sniffImage(stored)).toMatchObject({ width: 200, height: 100 });
    const info = sniffImage(await sharpThumbnailer.toWebp(stored, 1024));
    expect(info).toMatchObject({ mime: "image/webp", width: 100, height: 200 });
  });

  it("fits a noisy 1536x1024 PNG within the budget at some edge", async () => {
    const result = await makeThumbnail(sharpThumbnailer, await noisyPng(1536, 1024));
    expect(result).not.toBeNull();
    expect(result!.data.length).toBeLessThanOrEqual(300_000);
  });

  it("rejects bytes that are not an image", async () => {
    await expect(sharpThumbnailer.toWebp(INPUT, 1024)).rejects.toThrow();
    expect(await makeThumbnail(sharpThumbnailer, INPUT)).toBeNull();
  });
});
