import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../src/images/base64.js";
import { sniffImage } from "../src/images/sniff.js";

const bytes = (...parts: Array<number | number[] | Uint8Array>): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === "number" ? [p] : Array.from(p))));
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const be16 = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const le24 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const fromBase64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "base64"));

// Header builders. They emit only what a header parser reads, not decodable images.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (w: number, h: number): Uint8Array =>
  bytes(PNG_SIGNATURE, be32(13), ascii("IHDR"), be32(w), be32(h), [8, 2, 0, 0, 0], be32(0));

const segment = (marker: number, payload: number[]): number[] => [0xff, marker, ...be16(payload.length + 2), ...payload];
const sofPayload = (w: number, h: number): number[] => [8, ...be16(h), ...be16(w), 1, 1, 0x11, 0];
const SOI = [0xff, 0xd8];
const SOS = segment(0xda, [1, 1, 0, 0, 63, 0]);
const jpeg = (o: { app1Len?: number; w: number; h: number; sof?: number }): Uint8Array =>
  bytes(
    SOI,
    o.app1Len ? segment(0xe1, new Array(o.app1Len - 2).fill(0x45)) : [],
    segment(o.sof ?? 0xc0, sofPayload(o.w, o.h)),
    SOS,
    [1, 2, 3, 0xff, 0xd9],
  );

const riff = (...chunks: number[][]): Uint8Array => {
  const body = chunks.flat();
  return bytes(ascii("RIFF"), le32(body.length + 4), ascii("WEBP"), body);
};
const chunk = (fourcc: string, payload: number[]): number[] => [
  ...ascii(fourcc),
  ...le32(payload.length),
  ...payload,
  ...(payload.length % 2 ? [0] : []),
];
const vp8 = (w: number, h: number): Uint8Array =>
  riff(chunk("VP8 ", [0x30, 0x03, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0, 0, 0]));
const vp8l = (w: number, h: number): Uint8Array => {
  const packed = ((h - 1) << 14) | (w - 1);
  return riff(chunk("VP8L", [0x2f, ...le32(packed >>> 0)]));
};
const vp8x = (w: number, h: number): Uint8Array =>
  riff(chunk("VP8X", [0x10, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]));

// Tiny real-encoder fixtures, all produced once with sharp 0.35 (libvips) from a flat colour.
// Each uses distinct non-square dimensions so a swapped width and height fails.
// PNG, 24x10.
const REAL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAABgAAAAKCAIAAAAhCwk/AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQoz2M4oaFBFcQwatCoQYPJIADzRAaQYRAGTAAAAABJRU5ErkJggg==";
// Baseline JPEG with an EXIF APP1 segment (withExif, one IFD0 tag), 37x21.
const REAL_JPEG_EXIF =
  "/9j/4QDQRXhpZgAASUkqAAgAAAAHABIBAwABAAAAAQAAABoBBQABAAAAYgAAABsBBQABAAAAagAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAJiCAgAIAAAAcgAAAGmHBAABAAAAegAAAAAAAAA4YwAA6AMAADhjAADoAwAAZml4dHVyZQAGAACQBwAEAAAAMDIxMAGRBwAEAAAAAQIDAACgBwAEAAAAMDEwMAGgAwABAAAA//8AAAKgBAABAAAAJQAAAAOgBAABAAAAFQAAAAAAAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAVACUDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAUH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AigEBrYAAAAAAAAAD/9k=";
// Progressive JPEG (SOF2), 29x13.
const REAL_JPEG_PROGRESSIVE =
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wgARCAANAB0DASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAWAQEBAQAAAAAAAAAAAAAAAAAABQb/2gAMAwEAAhADEAAAAYgn60D/xAAUEAEAAAAAAAAAAAAAAAAAAAAw/9oACAEBAAEFAg//xAAUEQEAAAAAAAAAAAAAAAAAAAAQ/9oACAEDAQE/AT//xAAUEQEAAAAAAAAAAAAAAAAAAAAQ/9oACAECAQE/AT//xAAUEAEAAAAAAAAAAAAAAAAAAAAw/9oACAEBAAY/Ag//xAAUEAEAAAAAAAAAAAAAAAAAAAAw/9oACAEBAAE/IQ//2gAMAwEAAgADAAAAEP8A/wD/xAAUEQEAAAAAAAAAAAAAAAAAAAAQ/9oACAEDAQE/ED//xAAUEQEAAAAAAAAAAAAAAAAAAAAQ/9oACAECAQE/ED//xAAUEAEAAAAAAAAAAAAAAAAAAAAw/9oACAEBAAE/EA//2Q==";
// WebP VP8 (lossy, no alpha), 33x17.
const REAL_WEBP_VP8 =
  "UklGRkwAAABXRUJQVlA4IEAAAAAwAwCdASohABEAPm02l0ikIyIhJWgAgA2JZwB2AABX74bgAP7vKUf/rUyMfWQ///YO//Qd/+g7/ZTfDcBAAAAA";
// WebP VP8L (lossless), 19x11.
const REAL_WEBP_VP8L = "UklGRh4AAABXRUJQVlA4TBEAAAAvEoACAAdQlCIXpf+BiOh/AAA=";
// WebP VP8X (lossy with an alpha channel, so the VP8X chunk comes first), 41x23.
const REAL_WEBP_VP8X =
  "UklGRnAAAABXRUJQVlA4WAoAAAAQAAAAKAAAFgAAQUxQSAoAAAABB1DAiAhERP8DVlA4IEAAAAAwAwCdASopABcAPm02l0ikIyIhJWgAgA2JZwB2AABX74bgAP7vKUf/rUyMfWQ///YO//Qd/+g7/ZTfDcBAAAAA";

describe("sniffImage: PNG", () => {
  it("reads IHDR width/height", () => {
    expect(sniffImage(png(1536, 1024))).toEqual({ mime: "image/png", width: 1536, height: 1024 });
  });

  it("parses a real encoder PNG", () => {
    expect(sniffImage(fromBase64(REAL_PNG))).toEqual({ mime: "image/png", width: 24, height: 10 });
  });

  it("accepts exactly the 24 bytes that carry the dimensions", () => {
    expect(sniffImage(png(5, 7).subarray(0, 24))).toEqual({ mime: "image/png", width: 5, height: 7 });
  });

  it("rejects a truncated header (<24 bytes)", () => {
    expect(sniffImage(png(5, 7).subarray(0, 23))).toBeNull();
    expect(sniffImage(bytes(PNG_SIGNATURE))).toBeNull();
  });

  it("rejects zero and out-of-range dimensions", () => {
    expect(sniffImage(png(0, 10))).toBeNull();
    expect(sniffImage(png(10, 0))).toBeNull();
    expect(sniffImage(png(0x80000000, 10))).toBeNull();
    expect(sniffImage(png(0x7fffffff, 0x7fffffff))).toEqual({ mime: "image/png", width: 0x7fffffff, height: 0x7fffffff });
  });

  it("requires IHDR to be the first chunk with length 13", () => {
    const notIhdr = png(5, 7);
    notIhdr.set(ascii("IDAT"), 12);
    expect(sniffImage(notIhdr)).toBeNull();
    const badLength = png(5, 7);
    badLength.set(be32(12), 8);
    expect(sniffImage(badLength)).toBeNull();
  });

  it("rejects a corrupted signature", () => {
    const bad = png(5, 7);
    bad[7] = 0x0b;
    expect(sniffImage(bad)).toBeNull();
  });
});

describe("sniffImage: JPEG", () => {
  it("finds SOF0 after an APP1 segment", () => {
    expect(sniffImage(jpeg({ app1Len: 200, w: 800, h: 600 }))).toEqual({
      mime: "image/jpeg",
      width: 800,
      height: 600,
    });
  });

  it("parses a real baseline JPEG that carries an EXIF APP1 segment", () => {
    expect(sniffImage(fromBase64(REAL_JPEG_EXIF))).toEqual({ mime: "image/jpeg", width: 37, height: 21 });
  });

  it("parses a real progressive JPEG (SOF2)", () => {
    expect(sniffImage(fromBase64(REAL_JPEG_PROGRESSIVE))).toEqual({ mime: "image/jpeg", width: 29, height: 13 });
  });

  it("reads every SOF variant: baseline, extended, progressive, lossless, arithmetic", () => {
    const sofMarkers = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];
    for (const sof of sofMarkers) {
      expect(sniffImage(jpeg({ sof, w: 321, h: 123 }))).toEqual({ mime: "image/jpeg", width: 321, height: 123 });
    }
  });

  it("ignores DHT(C4)/JPG(C8)/DAC(CC) markers even when their payload looks like a frame header", () => {
    for (const marker of [0xc4, 0xc8, 0xcc]) {
      const decoy = segment(marker, sofPayload(99, 77));
      const img = bytes(SOI, decoy, segment(0xc0, sofPayload(640, 480)), SOS, [0xff, 0xd9]);
      expect(sniffImage(img)).toEqual({ mime: "image/jpeg", width: 640, height: 480 });
      // A decoy alone is not a frame header.
      expect(sniffImage(bytes(SOI, decoy, SOS, [0xff, 0xd9]))).toBeNull();
    }
  });

  it("skips fill bytes (repeated 0xFF) before a marker", () => {
    const img = bytes(SOI, [0xff, 0xff, 0xff], segment(0xe0, [1, 2, 3]), [0xff, 0xff], segment(0xc0, sofPayload(70, 50)), SOS);
    expect(sniffImage(img)).toEqual({ mime: "image/jpeg", width: 70, height: 50 });
  });

  it("treats TEM and RSTn as markers without a length", () => {
    // If 0x01 or 0xD0 were read as a length-carrying segment, the walk would land in the middle of the next marker.
    for (const standalone of [0x01, 0xd0, 0xd7]) {
      const img = bytes(SOI, [0xff, standalone], segment(0xc0, sofPayload(70, 50)), SOS);
      expect(sniffImage(img)).toEqual({ mime: "image/jpeg", width: 70, height: 50 });
    }
  });

  it("rejects a frame header with a zero dimension", () => {
    expect(sniffImage(jpeg({ w: 0, h: 10 }))).toBeNull();
    expect(sniffImage(jpeg({ w: 10, h: 0 }))).toBeNull();
  });

  it("rejects a scan or an end of image that comes before any frame header", () => {
    expect(sniffImage(bytes(SOI, SOS, segment(0xc0, sofPayload(10, 10))))).toBeNull();
    expect(sniffImage(bytes(SOI, [0xff, 0xd9], segment(0xc0, sofPayload(10, 10))))).toBeNull();
  });

  it("rejects a segment length that is too small or runs past the end", () => {
    expect(sniffImage(bytes(SOI, [0xff, 0xe0, 0x00, 0x01], segment(0xc0, sofPayload(10, 10))))).toBeNull();
    expect(sniffImage(bytes(SOI, [0xff, 0xe1, 0xff, 0xff, 1, 2, 3]))).toBeNull();
    expect(sniffImage(bytes(SOI, [0xff, 0xc0, 0x00, 0x04, 8, 0, 10]))).toBeNull();
  });

  it("rejects stray data between segments", () => {
    expect(sniffImage(bytes(SOI, [0x12, 0x34], segment(0xc0, sofPayload(10, 10))))).toBeNull();
  });

  it("rejects a truncated header", () => {
    expect(sniffImage(bytes(SOI))).toBeNull();
    expect(sniffImage(bytes(SOI, [0xff]))).toBeNull();
    // 11 bytes is the shortest prefix that still holds the width; one byte less must not parse.
    const full = jpeg({ w: 10, h: 10 });
    expect(sniffImage(full.subarray(0, 10))).toBeNull();
    expect(sniffImage(full.subarray(0, 11))).toEqual({ mime: "image/jpeg", width: 10, height: 10 });
  });
});

describe("sniffImage: WebP", () => {
  it("VP8 / VP8L / VP8X each parse dims", () => {
    expect(sniffImage(vp8(640, 480))).toEqual({ mime: "image/webp", width: 640, height: 480 });
    expect(sniffImage(vp8l(1024, 768))).toEqual({ mime: "image/webp", width: 1024, height: 768 });
    expect(sniffImage(vp8x(3000, 2000))).toEqual({ mime: "image/webp", width: 3000, height: 2000 });
  });

  it("reads the VP8 14-bit fields without the scale bits", () => {
    const img = vp8(100, 50);
    img[26 + 1] |= 0xc0;
    img[28 + 1] |= 0x40;
    expect(sniffImage(img)).toEqual({ mime: "image/webp", width: 100, height: 50 });
  });

  it("reads the largest VP8L and VP8X sizes", () => {
    expect(sniffImage(vp8l(16384, 16384))).toEqual({ mime: "image/webp", width: 16384, height: 16384 });
    expect(sniffImage(vp8x(0x1000000, 0x1000000))).toEqual({ mime: "image/webp", width: 0x1000000, height: 0x1000000 });
  });

  it("parses real encoder WebP: VP8, VP8L and VP8X", () => {
    expect(sniffImage(fromBase64(REAL_WEBP_VP8))).toEqual({ mime: "image/webp", width: 33, height: 17 });
    expect(sniffImage(fromBase64(REAL_WEBP_VP8L))).toEqual({ mime: "image/webp", width: 19, height: 11 });
    expect(sniffImage(fromBase64(REAL_WEBP_VP8X))).toEqual({ mime: "image/webp", width: 41, height: 23 });
  });

  it("rejects zero VP8 dimensions, a missing start code and non-key frames", () => {
    expect(sniffImage(vp8(0, 10))).toBeNull();
    expect(sniffImage(vp8(10, 0))).toBeNull();
    const noStartCode = vp8(10, 10);
    noStartCode[23] = 0;
    expect(sniffImage(noStartCode)).toBeNull();
    const interFrame = vp8(10, 10);
    interFrame[20] |= 1;
    expect(sniffImage(interFrame)).toBeNull();
  });

  it("rejects a VP8L stream with a bad signature or version", () => {
    const badSignature = vp8l(10, 10);
    badSignature[20] = 0x2e;
    expect(sniffImage(badSignature)).toBeNull();
    const badVersion = vp8l(10, 10);
    badVersion[24] |= 0x20;
    expect(sniffImage(badVersion)).toBeNull();
  });

  it("rejects an unknown first chunk, a wrong form type and a truncated header", () => {
    expect(sniffImage(riff(chunk("EXIF", new Array(20).fill(0))))).toBeNull();
    const notWebp = vp8(10, 10);
    notWebp.set(ascii("AVI "), 8);
    expect(sniffImage(notWebp)).toBeNull();
    expect(sniffImage(vp8(10, 10).subarray(0, 29))).toBeNull();
    expect(sniffImage(vp8l(10, 10).subarray(0, 24))).toBeNull();
    expect(sniffImage(vp8x(10, 10).subarray(0, 29))).toBeNull();
  });

  it("rejects a VP8X chunk that is too short to hold the canvas size", () => {
    expect(sniffImage(riff(chunk("VP8X", [0x10, 0, 0, 0, 1, 0, 0])))).toBeNull();
  });
});

describe("sniffImage: rejection and robustness", () => {
  it("rejects gif, svg text, empty and short inputs", () => {
    expect(sniffImage(bytes(ascii("GIF89a"), le16(10), le16(10), new Array(20).fill(0)))).toBeNull();
    expect(sniffImage(bytes(ascii('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
    expect(sniffImage(bytes(0xff))).toBeNull();
    expect(sniffImage(bytes(0x89, 0x50))).toBeNull();
  });

  it("rejects other raster formats by magic bytes", () => {
    expect(sniffImage(bytes(ascii("BM"), new Array(40).fill(0)))).toBeNull();
    expect(sniffImage(bytes(ascii("II*\0"), new Array(40).fill(0)))).toBeNull();
    expect(sniffImage(bytes(ascii("RIFF"), le32(30), ascii("WAVE"), new Array(30).fill(0)))).toBeNull();
  });

  it("never reads past the end of a view into a larger buffer", () => {
    const whole = png(5, 7);
    const view = whole.subarray(0, 20);
    expect(view.buffer.byteLength).toBeGreaterThanOrEqual(24);
    expect(sniffImage(view)).toBeNull();
  });

  it("honours a view's byteOffset", () => {
    const padded = bytes([0xaa, 0xbb, 0xcc], png(5, 7));
    expect(sniffImage(padded.subarray(3))).toEqual({ mime: "image/png", width: 5, height: 7 });
  });

  it("returns a result or null for every prefix of every fixture, without throwing", () => {
    const fixtures = [
      png(9, 9),
      jpeg({ app1Len: 50, w: 9, h: 9 }),
      vp8(9, 9),
      vp8l(9, 9),
      vp8x(9, 9),
      fromBase64(REAL_PNG),
      fromBase64(REAL_JPEG_EXIF),
      fromBase64(REAL_JPEG_PROGRESSIVE),
      fromBase64(REAL_WEBP_VP8),
      fromBase64(REAL_WEBP_VP8L),
      fromBase64(REAL_WEBP_VP8X),
    ];
    for (const fixture of fixtures) {
      for (let n = 0; n <= fixture.length; n++) {
        const info = sniffImage(fixture.subarray(0, n));
        if (info) {
          expect(Number.isInteger(info.width) && info.width > 0).toBe(true);
          expect(Number.isInteger(info.height) && info.height > 0).toBe(true);
        }
      }
    }
  });

  it("survives deterministic random mutations of valid headers", () => {
    let seed = 0x2545f491;
    const next = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    const bases = [png(20, 10), jpeg({ app1Len: 30, w: 20, h: 10 }), vp8(20, 10), vp8l(20, 10), vp8x(20, 10)];
    for (let round = 0; round < 2000; round++) {
      const copy = Uint8Array.from(bases[round % bases.length]!);
      for (let k = 0; k < 3; k++) copy[Math.floor(next() * copy.length)] = Math.floor(next() * 256);
      const info = sniffImage(copy.subarray(0, Math.floor(next() * (copy.length + 1))));
      if (info) {
        expect(info.width).toBeGreaterThan(0);
        expect(info.height).toBeGreaterThan(0);
      }
    }
  });
});

describe("base64 helpers", () => {
  it("round-trips and rejects garbage", () => {
    const data = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
    expect(base64ToBytes(bytesToBase64(data))).toEqual(data);
    for (const bad of ["not base64!", "QQ==QQ==", "QQ=", "A", "QUJD====", "=", "QUJD\n", " QUJD", "QUJ D"]) {
      expect(() => base64ToBytes(bad), bad).toThrow(new Error("invalid base64"));
    }
  });

  it("encodes the standard padded alphabet", () => {
    expect(bytesToBase64(bytes(ascii("Ma")))).toBe("TWE=");
    expect(bytesToBase64(bytes(ascii("M")))).toBe("TQ==");
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
    expect(bytesToBase64(bytes(0xfb, 0xff))).toBe("+/8=");
  });

  it("decodes an empty string to an empty array", () => {
    expect(base64ToBytes("")).toEqual(new Uint8Array(0));
  });

  it("accepts unpadded input", () => {
    expect(base64ToBytes("TQ")).toEqual(bytes(ascii("M")));
    expect(base64ToBytes("TWE")).toEqual(bytes(ascii("Ma")));
    expect(base64ToBytes("TQ==")).toEqual(bytes(ascii("M")));
  });

  it("rejects data: URLs, the URL-safe alphabet and embedded whitespace", () => {
    expect(() => base64ToBytes("data:image/png;base64,QUJD")).toThrow("invalid base64");
    expect(() => base64ToBytes("-_8=")).toThrow("invalid base64");
    expect(() => base64ToBytes("-_8")).toThrow("invalid base64");
    expect(() => base64ToBytes("QU\r\nJD")).toThrow("invalid base64");
  });

  it("rejects non-canonical trailing bits and misplaced padding", () => {
    expect(() => base64ToBytes("TR==")).toThrow("invalid base64");
    expect(() => base64ToBytes("TWF=")).toThrow("invalid base64");
    expect(() => base64ToBytes("TQ=A")).toThrow("invalid base64");
  });

  it("throws an error that does not echo the input", () => {
    const secret = "not-base64-secret-value!";
    try {
      base64ToBytes(secret);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe("invalid base64");
    }
  });

  it("returns a plain Uint8Array that owns its ArrayBuffer", () => {
    const out = base64ToBytes("QUJDREVGR0g=");
    expect(Buffer.isBuffer(out)).toBe(false);
    expect(Object.getPrototypeOf(out)).toBe(Uint8Array.prototype);
    expect(out.byteOffset).toBe(0);
    expect(out.buffer.byteLength).toBe(out.byteLength);
    expect(new Uint8Array(out.buffer)).toEqual(out);
  });

  it("encodes only the viewed range of a subarray", () => {
    const backing = bytes(ascii("xxABCDyy"));
    expect(bytesToBase64(backing.subarray(2, 6))).toBe(Buffer.from("ABCD").toString("base64"));
    expect(bytesToBase64(backing.subarray(2, 6))).toBe("QUJDRA==");
  });
});
