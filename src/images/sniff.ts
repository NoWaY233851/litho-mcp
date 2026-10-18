// Format detection from magic bytes. The server never trusts a Content-Type or a file
// extension, so this is the boundary that decides what counts as an image: anything that is
// not a PNG, JPEG or WebP header yields null. Only the header is inspected, never the pixel
// data, and only dimensions are reported: size limits are enforced by the callers.
//
// Offsets come from the format specifications:
//   PNG   https://www.w3.org/TR/png-3/ (section 5.2 signature, section 11.2.1 IHDR)
//   JPEG  ITU-T T.81, https://www.w3.org/Graphics/JPEG/itu-t81.pdf (B.1.1.2 markers, B.2.2 frame header)
//   WebP  RFC 9649, https://www.rfc-editor.org/rfc/rfc9649 (2.4 file header, 2.5 VP8, 2.6 and 3.4 VP8L, 2.7 VP8X)
//         and the VP8 key frame header in RFC 6386 section 9.1 (https://www.rfc-editor.org/rfc/rfc6386)

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export interface ImageInfo {
  mime: ImageMime;
  width: number;
  height: number;
}

/** Never throws and never reads outside `bytes`: every read is preceded by a length check. */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  return sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffWebp(bytes);
}

const be16 = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const be32 = (b: Uint8Array, i: number): number => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const le16 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const le32 = (b: Uint8Array, i: number): number => (le24(b, i) | (b[i + 3]! << 24)) >>> 0;

function matches(b: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (b.length < offset + expected.length) return false;
  return expected.every((value, i) => b[offset + i] === value);
}

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

function found(mime: ImageMime, width: number, height: number): ImageInfo | null {
  return width > 0 && height > 0 ? { mime, width, height } : null;
}

// --- PNG -------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_IHDR = ascii("IHDR");
// PNG caps both dimensions at 2^31 - 1.
const PNG_MAX_DIMENSION = 0x7fffffff;

function sniffPng(b: Uint8Array): ImageInfo | null {
  if (!matches(b, 0, PNG_SIGNATURE)) return null;
  // IHDR must be the first chunk: length (4) = 13, type (4), then width and height (4 each).
  if (b.length < 24 || be32(b, 8) !== 13 || !matches(b, 12, PNG_IHDR)) return null;
  const width = be32(b, 16);
  const height = be32(b, 20);
  if (width > PNG_MAX_DIMENSION || height > PNG_MAX_DIMENSION) return null;
  return found("image/png", width, height);
}

// --- JPEG ------------------------------------------------------------------------------

// SOF0-SOF15 carry the frame header (baseline, extended, progressive, lossless, arithmetic).
// 0xC4 (DHT), 0xC8 (JPG, reserved) and 0xCC (DAC) sit in the same range but are not frames.
const isStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

// Markers with no length field: TEM (0x01), RST0-RST7, SOI and EOI (T.81 B.1.1.3).
const isStandalone = (marker: number): boolean => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);

function sniffJpeg(b: Uint8Array): ImageInfo | null {
  if (!matches(b, 0, [0xff, 0xd8, 0xff])) return null;
  let i = 2;
  while (i < b.length) {
    // Any marker may be preceded by fill bytes (repeated 0xFF, T.81 B.1.1.2). Entropy-coded
    // data and 0xFF 0x00 stuffing only follow SOS, which ends the search below, so any other
    // byte between segments means the stream is malformed.
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff) i++;
    if (i >= b.length) return null;
    const marker = b[i++]!;
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9) return null;
    if (isStandalone(marker)) continue;
    // A scan before any frame header can never lead to one.
    if (marker === 0xda) return null;
    if (i + 2 > b.length) return null;
    const length = be16(b, i); // counts its own two bytes
    if (length < 2) return null;
    if (isStartOfFrame(marker)) {
      // Length, precision (1), height (2), width (2), component count (1).
      if (length < 8 || i + 7 > b.length) return null;
      return found("image/jpeg", be16(b, i + 5), be16(b, i + 3));
    }
    i += length;
  }
  return null;
}

// --- WebP ------------------------------------------------------------------------------

const RIFF = ascii("RIFF");
const WEBP = ascii("WEBP");
const VP8_LOSSY = ascii("VP8 ");
const VP8_LOSSLESS = ascii("VP8L");
const VP8_EXTENDED = ascii("VP8X");

function sniffWebp(b: Uint8Array): ImageInfo | null {
  // RIFF header (12 bytes), then the first chunk: fourcc (4), size (4, little-endian), payload.
  if (!matches(b, 0, RIFF) || !matches(b, 8, WEBP) || b.length < 20) return null;
  const chunkSize = le32(b, 16);
  const data = 20;

  if (matches(b, 12, VP8_LOSSY)) {
    // Key frame header (RFC 6386 9.1): 3-byte frame tag, start code 9D 01 2A, then 14-bit
    // width and height in the low bits of two little-endian words (the top 2 bits are scaling).
    if (chunkSize < 10 || b.length < data + 10) return null;
    const isKeyFrame = (b[data]! & 1) === 0;
    if (!isKeyFrame || !matches(b, data + 3, [0x9d, 0x01, 0x2a])) return null;
    return found("image/webp", le16(b, data + 6) & 0x3fff, le16(b, data + 8) & 0x3fff);
  }

  if (matches(b, 12, VP8_LOSSLESS)) {
    // RFC 9649 3.4: signature byte 0x2F, then 14 bits of width-1, 14 bits of height-1,
    // 1 alpha bit and a 3-bit version that must be 0.
    if (chunkSize < 5 || b.length < data + 5 || b[data] !== 0x2f) return null;
    const bits = le32(b, data + 1);
    if (bits >>> 29 !== 0) return null;
    return found("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }

  if (matches(b, 12, VP8_EXTENDED)) {
    // RFC 9649 2.7: flags (1) and reserved (3), then 24-bit canvas width-1 and height-1.
    // For an animated or alpha image the canvas size is the only size stored up front.
    if (chunkSize < 10 || b.length < data + 10) return null;
    return found("image/webp", le24(b, data + 4) + 1, le24(b, data + 7) + 1);
  }

  return null;
}
