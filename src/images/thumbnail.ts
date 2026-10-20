// The only module that imports sharp (docs/design/0008-vercel-hobby.md).
import sharp from "sharp";
import { bytesToBase64 } from "./base64.js";

export interface Thumbnailer {
  toWebp(bytes: Uint8Array, edge: number): Promise<Uint8Array>;
}

// Claude receives the thumbnail inline in the tool result, so the base64 text
// is capped (docs/design/0010-vercel-blob-storage.md).
export const THUMBNAIL_BASE64_BUDGET = 300_000;
const EDGES = [1024, 768, 512] as const;
const WEBP_QUALITY = 75;
// Same bound as MAX_IMAGE_SIDE in net/public-fetch.ts, as a pixel count. Generated
// images have no side cap of their own and makeThumbnail may decode three times,
// so a hostile or broken image must not reach sharp's 268 MP default.
const MAX_INPUT_PIXELS = 8192 * 8192;

export const sharpThumbnailer: Thumbnailer = {
  async toWebp(bytes, edge) {
    // rotate() with no argument applies the EXIF orientation first, so a camera
    // photo is not shown to Claude sideways.
    const out = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    return new Uint8Array(out);
  },
};

/**
 * The largest thumbnail that fits the base64 budget, or null when none does or
 * anything fails. Callers then return text only: a missing thumbnail must never
 * fail a generation that already succeeded.
 */
export async function makeThumbnail(
  t: Thumbnailer,
  bytes: Uint8Array,
): Promise<{ data: string; mimeType: "image/webp" } | null> {
  try {
    for (const edge of EDGES) {
      const data = bytesToBase64(await t.toWebp(bytes, edge));
      if (data.length <= THUMBNAIL_BASE64_BUDGET) return { data, mimeType: "image/webp" };
    }
    return null;
  } catch {
    return null;
  }
}
