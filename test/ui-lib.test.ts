import { describe, expect, it } from "vitest";
import {
  MAX_UPLOAD_BASE64_CHARS,
  STRINGS,
  UPLOAD_ENCODE_LADDER,
  bytesToBase64,
  fitWithin,
  formatMeta,
  pickLocale,
  withCacheBuster,
} from "../ui/lib.js";

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
  it("maps Chinese variants to zh-TW and everything else to en", () => {
    expect(pickLocale("zh-TW")).toBe("zh-TW");
    expect(pickLocale("zh-Hant-HK")).toBe("zh-TW");
    expect(pickLocale("zh-Hant-TW")).toBe("zh-TW");
    expect(pickLocale("en-US")).toBe("en");
    expect(pickLocale(undefined)).toBe("en");
  });
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
