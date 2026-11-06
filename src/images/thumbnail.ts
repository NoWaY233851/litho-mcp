// The only module that imports sharp (docs/design/0008-vercel-hobby.md).
import sharp from "sharp";
import { bytesToBase64 } from "./base64.js";
import { SHEET_MAX_FRAMES } from "./limits.js";

/** Frame count and timing; a still image is one frame. `loop` 0 means it loops forever. */
export interface Animation {
  frames: number;
  delaysMs: number[];
  loop: number;
}

export interface Thumbnailer {
  /** A WebP preview within `edge` px. An animation becomes a contact sheet of its frames. */
  toWebp(bytes: Uint8Array, edge: number): Promise<Uint8Array>;
  animation(bytes: Uint8Array): Promise<Animation>;
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

// Claude can't open the image itself, so an animated GIF is shown as a grid of frames: evenly
// spaced, first and last included, in reading order (docs/design/0011-animated-gif-output.md).
export { SHEET_MAX_FRAMES };
export const SHEET_GAP = 4;
const SHEET_BACKGROUND = { r: 128, g: 128, b: 128 };

const load = (bytes: Uint8Array, page?: number) =>
  sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, ...(page !== undefined ? { page, pages: 1 } : {}) });

async function contactSheet(bytes: Uint8Array, pages: number, width: number, height: number, edge: number): Promise<Uint8Array> {
  const count = Math.min(pages, SHEET_MAX_FRAMES);
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const scale = Math.min(
    (edge - SHEET_GAP * (cols - 1)) / (cols * width),
    (edge - SHEET_GAP * (rows - 1)) / (rows * height),
    1,
  );
  const cellW = Math.max(1, Math.floor(width * scale));
  const cellH = Math.max(1, Math.floor(height * scale));
  const tiles = [];
  // One frame decoded at a time keeps memory at a single frame plus the sheet. Tiles stay raw
  // pixels: without an explicit format sharp would re-encode each one as GIF, re-quantizing it.
  for (let k = 0; k < count; k++) {
    const page = count === 1 ? 0 : Math.round((k * (pages - 1)) / (count - 1));
    const input = await load(bytes, page).resize(cellW, cellH, { fit: "fill" }).ensureAlpha().raw().toBuffer();
    tiles.push({
      input,
      raw: { width: cellW, height: cellH, channels: 4 as const },
      left: (k % cols) * (cellW + SHEET_GAP),
      top: Math.floor(k / cols) * (cellH + SHEET_GAP),
    });
  }
  const sheet = sharp({
    create: {
      width: cols * cellW + SHEET_GAP * (cols - 1),
      height: rows * cellH + SHEET_GAP * (rows - 1),
      channels: 3,
      background: SHEET_BACKGROUND,
    },
  });
  return new Uint8Array(await sheet.composite(tiles).webp({ quality: WEBP_QUALITY }).toBuffer());
}

export const sharpThumbnailer: Thumbnailer = {
  async toWebp(bytes, edge) {
    // Width and height are those of one frame; pages counts the frames. Only GIF gets a sheet:
    // the result text explains the grid for GIFs alone, and other formats show the first frame.
    const { format, pages = 1, width, height, pageHeight } = await load(bytes).metadata();
    if (format === "gif" && pages > 1 && width && (pageHeight ?? height)) {
      return contactSheet(bytes, pages, width, (pageHeight ?? height)!, edge);
    }
    // rotate() with no argument applies the EXIF orientation first, so a camera
    // photo is not shown to Claude sideways.
    const out = await load(bytes)
      .rotate()
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    return new Uint8Array(out);
  },

  async animation(bytes) {
    const { pages = 1, delay = [], loop = 0 } = await load(bytes).metadata();
    return { frames: pages, delaysMs: pages > 1 ? delay : [], loop };
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
