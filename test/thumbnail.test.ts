import { crc32 } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../src/images/base64.js";
import { sniffImage } from "../src/images/sniff.js";
import {
  SHEET_GAP,
  SHEET_MAX_FRAMES,
  THUMBNAIL_BASE64_BUDGET,
  makeThumbnail,
  sharpThumbnailer,
  type Thumbnailer,
} from "../src/images/thumbnail.js";

// base64 length of n bytes is 4 * ceil(n / 3), so 225_000 bytes is exactly 300_000 characters.
const BUDGET_BYTES = 225_000;
const INPUT = new Uint8Array([1, 2, 3]);

function scripted(sizes: (number | Error)[]): Thumbnailer & { edges: number[] } {
  const edges: number[] = [];
  return {
    edges,
    animation: async () => ({ frames: 1, delaysMs: [], loop: 0 }),
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

  it("rejects an input over the pixel limit, and makeThumbnail then returns null", async () => {
    // A valid PNG header claiming 12000x12000 (144 MP, under sharp's 268 MP default).
    // No pixel data is needed, since the limit is checked from the header. The IHDR
    // CRC is recomputed so the only thing wrong with the input is its size.
    const png = Buffer.from(await noisyPng(8, 8));
    png.writeUInt32BE(12_000, 16);
    png.writeUInt32BE(12_000, 20);
    png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
    const claimed = new Uint8Array(png);
    expect(sniffImage(claimed)).toMatchObject({ width: 12_000, height: 12_000 });
    await expect(sharpThumbnailer.toWebp(claimed, 1024)).rejects.toThrow(/pixel limit/);
    expect(await makeThumbnail(sharpThumbnailer, claimed)).toBeNull();
  });

  it("rejects bytes that are not an image", async () => {
    await expect(sharpThumbnailer.toWebp(INPUT, 1024)).rejects.toThrow();
    expect(await makeThumbnail(sharpThumbnailer, INPUT)).toBeNull();
  });
});

// Frame k is one flat color, distinct per frame: the encoder merges identical frames.
const frameColor = (k: number): [number, number, number] => [(k * 20) % 256, 255 - k * 20, (k * 50) % 256];

async function animatedGif(
  width: number,
  height: number,
  frames: number,
  options: { delay?: number[]; loop?: number } = {},
): Promise<Uint8Array> {
  const raw = Buffer.alloc(width * height * frames * 4);
  for (let i = 0; i < raw.length; i += 4) raw.set([...frameColor(Math.floor(i / 4 / (width * height))), 255], i);
  const gif = await sharp(raw, { raw: { width, height: height * frames, channels: 4, pageHeight: height } })
    .gif({ delay: options.delay ?? new Array(frames).fill(100), loop: options.loop ?? 0 })
    .toBuffer();
  return new Uint8Array(gif);
}

/** The color at the center of grid cell (col, row) of a contact sheet. */
async function cellColor(sheet: Uint8Array, cellW: number, cellH: number, col: number, row: number): Promise<number[]> {
  const { data, info } = await sharp(sheet).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const x = col * (cellW + SHEET_GAP) + Math.floor(cellW / 2);
  const y = row * (cellH + SHEET_GAP) + Math.floor(cellH / 2);
  const i = (y * info.width + x) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

/** Mean distance of each pixel from the average of its left and right neighbours: about 0 for a smooth ramp. */
async function roughness(image: Buffer): Promise<number> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let sum = 0;
  let count = 0;
  // A 2 px border is skipped, where the cell meets the gap or the image edge.
  for (let y = 2; y < height - 2; y++) {
    for (let x = 3; x < width - 3; x++) {
      for (let c = 0; c < channels; c++) {
        const i = (y * width + x) * channels + c;
        sum += Math.abs(2 * data[i]! - data[i - channels]! - data[i + channels]!) / 2;
        count++;
      }
    }
  }
  return sum / count;
}

const near = (actual: number[], expected: number[]): boolean => actual.every((v, i) => Math.abs(v - expected[i]!) <= 8);

describe("sharpThumbnailer: animated GIF", () => {
  it("makes a contact sheet of the frames in reading order, with gaps between cells", async () => {
    const sheet = await sharpThumbnailer.toWebp(await animatedGif(40, 30, 3), 1024);
    // 3 frames: 2 columns, 2 rows, never upscaled.
    expect(sniffImage(sheet)).toEqual({ mime: "image/webp", width: 2 * 40 + SHEET_GAP, height: 2 * 30 + SHEET_GAP });
    expect(near(await cellColor(sheet, 40, 30, 0, 0), frameColor(0))).toBe(true);
    expect(near(await cellColor(sheet, 40, 30, 1, 0), frameColor(1))).toBe(true);
    expect(near(await cellColor(sheet, 40, 30, 0, 1), frameColor(2))).toBe(true);
  });

  it(`samples at most ${SHEET_MAX_FRAMES} frames evenly, keeping the first and the last`, async () => {
    const sheet = await sharpThumbnailer.toWebp(await animatedGif(20, 20, 12), 1024);
    expect(sniffImage(sheet)).toMatchObject({ width: 3 * 20 + 2 * SHEET_GAP, height: 3 * 20 + 2 * SHEET_GAP });
    // Frames 0, 1, 3, 4, 6, 7, 8, 10, 11 of 0..11, in reading order.
    const sampled = [0, 1, 3, 4, 6, 7, 8, 10, 11];
    for (const [k, frame] of sampled.entries()) {
      expect(near(await cellColor(sheet, 20, 20, k % 3, Math.floor(k / 3)), frameColor(frame)), `cell ${k}`).toBe(true);
    }
  });

  it("fits the sheet within the edge and keeps the frame's aspect ratio", async () => {
    const sheet = await sharpThumbnailer.toWebp(await animatedGif(300, 200, 9), 256);
    const info = sniffImage(sheet)!;
    expect(info.width).toBeLessThanOrEqual(256);
    expect(info.height).toBeLessThanOrEqual(256);
    expect(info.width).toBeGreaterThan(250);
    const cellW = (info.width - 2 * SHEET_GAP) / 3;
    const cellH = (info.height - 2 * SHEET_GAP) / 3;
    expect(cellW / cellH).toBeCloseTo(1.5, 1);
  });

  it("puts two frames side by side", async () => {
    const sheet = await sharpThumbnailer.toWebp(await animatedGif(30, 20, 2), 1024);
    expect(sniffImage(sheet)).toMatchObject({ width: 2 * 30 + SHEET_GAP, height: 20 });
    expect(near(await cellColor(sheet, 30, 20, 0, 0), frameColor(0))).toBe(true);
    expect(near(await cellColor(sheet, 30, 20, 1, 0), frameColor(1))).toBe(true);
  });

  it("fits very wide frames within the edge", async () => {
    const sheet = await sharpThumbnailer.toWebp(await animatedGif(400, 20, 4), 256);
    const info = sniffImage(sheet)!;
    expect(info.width).toBeLessThanOrEqual(256);
    expect(info.height).toBeLessThanOrEqual(256);
    expect(info.height).toBeGreaterThan(0);
  });

  it("keeps a frame's colors: tiles are not re-quantized to a GIF palette", async () => {
    // Downscaling a two-axis gradient makes far more than 256 colors, which a GIF tile would dither.
    const [width, height, frames] = [256, 256, 2];
    const raw = Buffer.alloc(width * height * frames * 4);
    // The second frame differs, or the encoder would merge the two.
    for (let i = 0; i < raw.length; i += 4) {
      const frame = Math.floor(i / 4 / (width * height));
      const p = (i / 4) % (width * height);
      const [x, y] = [p % width, Math.floor(p / width)];
      raw.set([x, y, frame === 0 ? (x + y) >> 1 : 255 - ((x + y) >> 1), 255], i);
    }
    const gif = new Uint8Array(
      await sharp(raw, { raw: { width, height: height * frames, channels: 4, pageHeight: height } }).gif().toBuffer(),
    );
    expect((await sharp(gif).metadata()).pages).toBe(2);
    const sheet = await sharpThumbnailer.toWebp(gif, 256);
    const cell = Math.floor((256 - SHEET_GAP) / 2);
    // A palette re-quantization dithers a smooth gradient, so the tile is rougher than a plain
    // resize of the same frame (measured: about 1.65 times as rough; raw tiles stay at about 1).
    const direct = await sharp(gif, { page: 0, pages: 1 }).resize(cell, cell, { fit: "fill" }).png().toBuffer();
    const tile = await sharp(sheet).extract({ left: 0, top: 0, width: cell, height: cell }).png().toBuffer();
    expect(await roughness(tile)).toBeLessThan(1.25 * (await roughness(direct)));
  });

  it("previews an animated image in another format as its first frame only", async () => {
    const [width, height] = [40, 30];
    const raw = Buffer.alloc(width * height * 2 * 4);
    for (let i = 0; i < raw.length; i += 4) raw.set([...frameColor(Math.floor(i / 4 / (width * height))), 255], i);
    const webp = new Uint8Array(
      await sharp(raw, { raw: { width, height: height * 2, channels: 4, pageHeight: height } }).webp({ loop: 0 }).toBuffer(),
    );
    expect((await sharp(webp).metadata()).pages).toBe(2);
    expect(sniffImage(await sharpThumbnailer.toWebp(webp, 1024))).toMatchObject({ width, height });
  });

  it("reads the frame count, the per-frame delays and the loop count", async () => {
    expect(await sharpThumbnailer.animation(await animatedGif(10, 10, 3, { delay: [100, 120, 140], loop: 2 }))).toEqual({
      frames: 3,
      delaysMs: [100, 120, 140],
      loop: 2,
    });
    expect(await sharpThumbnailer.animation(await animatedGif(10, 10, 2))).toMatchObject({ frames: 2, loop: 0 });
  });

  it("reports a single frame for a still GIF and for other formats", async () => {
    const stillGif = new Uint8Array(Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64"));
    expect(await sharpThumbnailer.animation(stillGif)).toMatchObject({ frames: 1 });
    expect(await sharpThumbnailer.animation(await noisyPng(30, 20))).toMatchObject({ frames: 1 });
  });
});
