import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INLINE_BOX_PX,
  MAX_UPLOAD_BASE64_CHARS,
  STRINGS,
  UPLOAD_ENCODE_LADDER,
  bytesToBase64,
  fitWithin,
  formatMeta,
  inlineSize,
  pickLocale,
  withCacheBuster,
} from "../ui/lib.js";

describe("inlineSize", () => {
  it("fits portrait, landscape and square images in the 480 px box", () => {
    expect(INLINE_BOX_PX).toBe(480);
    expect(inlineSize(1024, 1536)).toEqual({ w: 320, h: 480 });
    expect(inlineSize(1536, 1024)).toEqual({ w: 480, h: 320 });
    expect(inlineSize(2048, 2048)).toEqual({ w: 480, h: 480 });
  });
  it("the narrow-column media query sits one pixel below INLINE_BOX_PX", () => {
    const html = readFileSync(new URL("../ui/app.html", import.meta.url), "utf8");
    const widths = [...html.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
    expect(widths).toEqual([INLINE_BOX_PX - 1]);
  });
  it("never upscales a small image", () => {
    expect(inlineSize(256, 128)).toEqual({ w: 256, h: 128 });
  });
  it("never shrinks a thin side to zero", () => {
    expect(inlineSize(4000, 2)).toEqual({ w: 480, h: 1 });
  });
});

describe("fitWithin", () => {
  it("keeps aspect and never upscales", () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ w: 2048, h: 1536 });
    expect(fitWithin(800, 600, 2048)).toEqual({ w: 800, h: 600 });
  });

  it("scales by the long edge for portrait images too", () => {
    expect(fitWithin(3024, 4032, 2048)).toEqual({ w: 1536, h: 2048 });
  });

  it("never rounds a side down to zero", () => {
    expect(fitWithin(10000, 1, 2048)).toEqual({ w: 2048, h: 1 });
  });
});

describe("formatMeta", () => {
  it("shows model, aspect ratio and cost", () =>
    expect(
      formatMeta({ model: "openai/gpt-image-2.5-flare", aspect_ratio: "2:3", width: 1024, height: 1536, cost_usd: 0.0412 }),
    ).toBe("gpt-image-2.5-flare · 2:3 · $0.041"));

  it("falls back to W×H and omits unknown cost", () =>
    expect(formatMeta({ model: "x/y", width: 10, height: 20, cost_usd: null })).toBe("y · 10×20"));
});

describe("pickLocale", () => {
  it.each([
    "zh-TW",
    "zh-HK",
    "zh-MO",
    "zh-Hant",
    "zh-Hant-TW",
    "zh-Hant-HK",
    "zh-Hant-CN",
    "zh_TW",
    "ZH-tw",
    "zh-TW-u-nu-hans",
  ])("maps %s to zh-TW", (tag) => expect(pickLocale(tag)).toBe("zh-TW"));

  it.each([
    "zh",
    "zh-CN",
    "zh-SG",
    "zh-Hans",
    "zh-Hans-CN",
    "zh-Hans-HK",
    "en-US",
    "ja-JP",
    "zhx-TW",
    "",
    undefined,
  ])("maps %s to en", (tag) => expect(pickLocale(tag)).toBe("en"));
});

describe("STRINGS", () => {
  const keys = [
    "generating",
    "seconds",
    "choosePhoto",
    "uploading",
    "uploaded",
    "replacePhoto",
    "expired",
    "uploadFailed",
    "decodeFailed",
    "tooLarge",
    "replaceDelay",
  ] as const;

  it("has every key, non-empty, in both locales", () => {
    for (const locale of ["en", "zh-TW"] as const) {
      for (const key of keys) expect(STRINGS[locale][key].length).toBeGreaterThan(0);
      expect(Object.keys(STRINGS[locale]).sort()).toEqual([...keys].sort());
    }
  });

  it("explains an unreadable photo format in both locales", () => {
    expect(STRINGS.en.decodeFailed).toContain("JPEG, PNG or WebP");
    expect(STRINGS["zh-TW"].decodeFailed).toContain("JPEG、PNG 或 WebP");
  });

  it("says a photo is still too large after shrinking, in both locales", () => {
    expect(STRINGS.en.tooLarge).toBe("This photo is still too large after shrinking. Choose another photo.");
    expect(STRINGS["zh-TW"].tooLarge).toBe("這張照片縮小後仍然太大，請改選另一張照片。");
  });

  it("says when a replaced photo can be used, in both locales", () => {
    expect(STRINGS.en.replaceDelay).toBe("Claude can use the new photo in about a minute.");
    expect(STRINGS["zh-TW"].replaceDelay).toBe("約一分鐘後 Claude 才能使用新照片。");
  });
});

describe("withCacheBuster", () => {
  it("adds v as the only query parameter", () =>
    expect(withCacheBuster("https://blob.example.test/up/abc", 123)).toBe("https://blob.example.test/up/abc?v=123"));

  it("keeps an existing query", () =>
    expect(withCacheBuster("https://blob.example.test/up/abc?a=1", "t9")).toBe(
      "https://blob.example.test/up/abc?a=1&v=t9",
    ));

  it("keeps a fragment at the end", () =>
    expect(withCacheBuster("https://blob.example.test/up/abc#x", 1)).toBe("https://blob.example.test/up/abc?v=1#x"));
});

describe("upload size", () => {
  it("encodes bytes as plain base64 without a data: prefix", () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe("aGk=");
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
  });

  it("handles inputs larger than one chunk", () => {
    const bytes = new Uint8Array(100_000).fill(255);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("caps base64 below the 4 MiB MCP request body limit", () => {
    expect(MAX_UPLOAD_BASE64_CHARS).toBe(4 * 1024 * 1024 - 64 * 1024);
    expect(MAX_UPLOAD_BASE64_CHARS).toBeLessThan(4 * 1024 * 1024);
  });
});

describe("UPLOAD_ENCODE_LADDER", () => {
  it("steps down in a fixed order, starting at the default", () => {
    expect(UPLOAD_ENCODE_LADDER).toEqual([
      { edge: 2048, quality: 0.9 },
      { edge: 2048, quality: 0.8 },
      { edge: 2048, quality: 0.7 },
      { edge: 1536, quality: 0.8 },
    ]);
  });
});
