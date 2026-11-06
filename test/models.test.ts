import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  IMAGE_PARAMS,
  _resetModelCache,
  getImageModels,
  summarizeModel,
  validateRequest,
  type ImageModel,
} from "../src/openrouter/models.js";

const catalog = readFileSync(new URL("./fixtures/image-models.json", import.meta.url), "utf8");
const pricing = readFileSync(new URL("./fixtures/models-pricing.json", import.meta.url), "utf8");

const cfg = { openrouterApiKey: "test-openrouter-key" };
const CATALOG_URL = "https://openrouter.ai/api/v1/images/models";
const PRICING_URL = "https://openrouter.ai/api/v1/models?output_modalities=image";

interface Call {
  url: string;
  headers: Headers;
  signal: AbortSignal | null | undefined;
  redirect: RequestRedirect | undefined;
}

// Serves the fixtures and records what was asked, so tests can assert on URLs and headers without a network.
function fakeFetch(overrides: Record<string, () => Response> = {}) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers), signal: init?.signal, redirect: init?.redirect });
    const override = overrides[url];
    if (override) return override();
    if (url === CATALOG_URL) return new Response(catalog, { status: 200 });
    if (url === PRICING_URL) return new Response(pricing, { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject");
}

async function loadModels(): Promise<Record<string, ImageModel>> {
  _resetModelCache();
  const models = await getImageModels(cfg, fakeFetch().f);
  return Object.fromEntries(models.map((m) => [m.id, m]));
}

describe("getImageModels", () => {
  beforeEach(() => _resetModelCache());

  it("joins catalog and pricing, keeping only non-zero image/image_output/prompt prices", async () => {
    const models = await getImageModels(cfg, fakeFetch().f);
    expect(models.map((m) => m.id).sort()).toEqual([
      "krea/k3-edit",
      "openai/gpt-image-2.5-flare",
      "openai/gpt-image-2.6-flare",
      "recraft/recraft-v4.1-flash",
      "recraft/recraft-v4.1-vector",
    ]);
    expect(models.find((m) => m.id === "krea/k3-edit")!.pricing).toEqual({
      image: "0.02",
      image_output: "0.00000718562874251497",
    });
    expect(models.find((m) => m.id === "openai/gpt-image-2.5-flare")!.pricing).toEqual({
      prompt: "0.000008",
      image_output: "0.00003",
    });
    // No pricing row for this model: pricing stays empty rather than failing the join.
    expect(models.find((m) => m.id === "recraft/recraft-v4.1-flash")!.pricing).toEqual({});
  });

  it("keeps every raw descriptor and the input modalities", async () => {
    const k3 = (await loadModels())["krea/k3-edit"]!;
    expect(k3.name).toBe("Krea: K3 Edit");
    expect(k3.inputModalities).toEqual(["text", "image"]);
    expect(k3.params.input_references).toEqual({ type: "range", min: 1, max: 8 });
    expect(k3.params.seed).toEqual({ type: "boolean" });
    const flash = (await loadModels())["recraft/recraft-v4.1-flash"]!;
    expect(flash.params.n).toEqual({ type: "range", min: 1, max: 6 });
  });

  it("fetches both endpoints with the bearer key and a timeout signal", async () => {
    const { f, calls } = fakeFetch();
    await getImageModels(cfg, f);
    expect(calls.map((c) => c.url).sort()).toEqual([CATALOG_URL, PRICING_URL].sort());
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe("Bearer test-openrouter-key");
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect(call.redirect).toBe("error");
    }
  });

  it("caches for 3600 s (second call makes no fetch)", async () => {
    const { f, calls } = fakeFetch();
    let t = 1_000_000;
    const now = () => t;
    await getImageModels(cfg, f, now);
    expect(calls).toHaveLength(2);
    t += 3_599_000;
    await getImageModels(cfg, f, now);
    expect(calls).toHaveLength(2);
  });

  it("refetches once 3600 s have passed", async () => {
    const { f, calls } = fakeFetch();
    let t = 1_000_000;
    const now = () => t;
    await getImageModels(cfg, f, now);
    t += 3_600_001;
    await getImageModels(cfg, f, now);
    expect(calls).toHaveLength(4);
  });

  it("does not cache a failed fetch", async () => {
    let failing = true;
    const { f, calls } = fakeFetch({
      [CATALOG_URL]: () => (failing ? new Response("boom", { status: 503 }) : new Response(catalog)),
    });
    await expect(getImageModels(cfg, f)).rejects.toThrow();
    failing = false;
    const before = calls.length;
    const models = await getImageModels(cfg, f);
    expect(models).toHaveLength(5);
    expect(calls.length).toBeGreaterThan(before);
  });

  it("names the endpoint and status on a non-2xx answer, without the key or the body", async () => {
    const { f } = fakeFetch({
      [PRICING_URL]: () => new Response("secret-body test-openrouter-key", { status: 500 }),
    });
    const error = await rejection(getImageModels(cfg, f));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("/api/v1/models");
    expect(error.message).toContain("500");
    expect(error.message).not.toContain("test-openrouter-key");
    expect(error.message).not.toContain("secret-body");
  });

  it("names the endpoint and status on malformed JSON, without the body", async () => {
    const { f } = fakeFetch({ [CATALOG_URL]: () => new Response("<html>oops-body", { status: 200 }) });
    const error = await rejection(getImageModels(cfg, f));
    expect(error.message).toContain("/api/v1/images/models");
    expect(error.message).toContain("200");
    expect(error.message).not.toContain("oops-body");
  });

  it("does not leak the key when the transport fails", async () => {
    const f = (async () => {
      throw new Error("connect failed with Bearer test-openrouter-key");
    }) as typeof fetch;
    const error = await rejection(getImageModels(cfg, f));
    expect(error.message).toContain("/api/v1/");
    expect(error.message).not.toContain("test-openrouter-key");
  });

  it("rejects a catalog without a data array", async () => {
    const { f } = fakeFetch({ [CATALOG_URL]: () => new Response("{}", { status: 200 }) });
    await expect(getImageModels(cfg, f)).rejects.toThrow(/images\/models/);
  });
});

describe("validateRequest and summarizeModel", () => {
  let flare: ImageModel;
  let flare26: ImageModel;
  let k3: ImageModel;
  let flash: ImageModel;
  let vector: ImageModel;

  beforeEach(async () => {
    const models = await loadModels();
    flare = models["openai/gpt-image-2.5-flare"]!;
    flare26 = models["openai/gpt-image-2.6-flare"]!;
    k3 = models["krea/k3-edit"]!;
    flash = models["recraft/recraft-v4.1-flash"]!;
    vector = models["recraft/recraft-v4.1-vector"]!;
  });

  it("accepts declared enum values", () => {
    expect(validateRequest(flare, { aspect_ratio: "2:3", quality: "high" }, 0, "generate")).toBeNull();
  });

  it("rejects undeclared params with the supported list", () => {
    const message = validateRequest(flare, { resolution: "2K" }, 0, "generate");
    expect(message).toMatch(/does not support "resolution".*aspect_ratio/s);
    expect(message).toContain("openai/gpt-image-2.5-flare");
    // n and input_references are declared by the model but are not exposed parameters.
    expect(message).not.toMatch(/Supported[^.]*\b(n|input_references)\b/);
  });

  it("rejects out-of-enum values listing allowed ones", () => {
    expect(validateRequest(flare, { aspect_ratio: "5:4" }, 0, "generate")).toMatch(/1:1, 3:2/);
  });

  it("enforces range", () => {
    expect(validateRequest(flare, { output_compression: 101 }, 0, "generate")).toMatch(/0–100/);
    expect(validateRequest(flare, { output_compression: -1 }, 0, "generate")).toMatch(/0–100/);
    expect(validateRequest(flare, { output_compression: Number.NaN }, 0, "generate")).toMatch(/0–100/);
    expect(validateRequest(flare, { output_compression: 0 }, 0, "generate")).toBeNull();
    expect(validateRequest(flare, { output_compression: 100 }, 0, "generate")).toBeNull();
  });

  it("boolean descriptor = supported, any value", () => {
    expect(validateRequest(k3, { seed: 42 }, 1, "edit")).toBeNull();
    expect(validateRequest(k3, { seed: -7 }, 1, "edit")).toBeNull();
  });

  it("generate on a model with input_references.min >= 1 -> use edit_image", () => {
    expect(validateRequest(k3, {}, 0, "generate")).toMatch(/requires a reference image.*edit_image/);
  });

  it("edit on a text-only model", () => {
    expect(validateRequest(flash, {}, 1, "edit")).toMatch(/cannot edit/);
  });

  it("edit with too many references", () => {
    expect(validateRequest(k3, {}, 9, "edit")).toMatch(/at most 8/);
    expect(validateRequest(k3, {}, 8, "edit")).toBeNull();
  });

  it("edit with fewer references than the model's minimum", () => {
    expect(validateRequest(k3, {}, 0, "edit")).toMatch(/requires at least 1/);
  });

  it("output_format svg is always rejected", () => {
    expect(validateRequest(vector, { output_format: "svg" }, 0, "generate")).toMatch(/SVG.*not supported/);
    expect(validateRequest(flare, { output_format: "svg" }, 0, "generate")).toMatch(/SVG.*not supported/);
  });

  it("accepts gif where the model declares it, and rejects formats the store can't keep", () => {
    expect(validateRequest(flare26, { output_format: "gif" }, 0, "generate")).toBeNull();
    for (const format of ["png", "jpeg", "webp"]) {
      expect(validateRequest(flare26, { output_format: format }, 0, "generate")).toBeNull();
    }
    const message = validateRequest(flare26, { output_format: "bmp" }, 0, "generate");
    expect(message).toMatch(/BMP output is not supported/);
    expect(message).toContain("openai/gpt-image-2.6-flare");
    // 2.5 Flare declares no output_format at all.
    expect(validateRequest(flare, { output_format: "gif" }, 0, "generate")).toMatch(/does not support "output_format"/);
  });

  it("frame_count and frame_duration_ms apply only to gif output", () => {
    expect(validateRequest(flare26, { frame_count: 9 }, 0, "generate")).toMatch(/frame_count applies only to output_format gif/);
    expect(validateRequest(flare26, { output_format: "png", frame_duration_ms: 200 }, 0, "generate")).toMatch(
      /frame_duration_ms applies only to output_format gif/,
    );
    expect(validateRequest(flare26, { output_format: "gif", frame_count: 9, frame_duration_ms: 200 }, 0, "generate")).toBeNull();
  });

  it("checks frame ranges against OpenAI's documented limits unless the catalog declares its own", () => {
    const gif = (p: { frame_count?: number; frame_duration_ms?: number }) =>
      validateRequest(flare26, { output_format: "gif", ...p }, 0, "generate");
    expect(gif({ frame_count: 2 })).toBeNull();
    expect(gif({ frame_count: 16 })).toBeNull();
    expect(gif({ frame_count: 1 })).toMatch(/frame_count to be a number in 2–16/);
    expect(gif({ frame_count: 17 })).toMatch(/2–16/);
    expect(gif({ frame_duration_ms: 20 })).toBeNull();
    expect(gif({ frame_duration_ms: 2000 })).toBeNull();
    expect(gif({ frame_duration_ms: 19 })).toMatch(/frame_duration_ms to be a number in 20–2000/);
    expect(gif({ frame_duration_ms: 2001 })).toMatch(/20–2000/);

    const declared: ImageModel = { ...flare26, params: { ...flare26.params, frame_count: { type: "range", min: 2, max: 64 } } };
    expect(validateRequest(declared, { output_format: "gif", frame_count: 40 }, 0, "generate")).toBeNull();
  });

  it("rejects output_compression with gif output", () => {
    expect(validateRequest(flare26, { output_format: "gif", output_compression: 50 }, 0, "generate")).toMatch(
      /output_compression is not supported with output_format gif/,
    );
    expect(validateRequest(flare26, { output_format: "webp", output_compression: 50 }, 0, "generate")).toBeNull();
  });

  it("cuts a long rejected output_format in the message", () => {
    expect(validateRequest(flare, { output_format: "x".repeat(100_000) }, 0, "generate")!.length).toBeLessThan(200);
  });

  it("includes the model id in messages", () => {
    expect(validateRequest(k3, {}, 9, "edit")).toContain("krea/k3-edit");
    expect(validateRequest(flash, {}, 1, "edit")).toContain("recraft/recraft-v4.1-flash");
  });

  it("summarizeModel", () => {
    const summary = summarizeModel(k3);
    expect(summary).toMatchObject({
      id: "krea/k3-edit",
      name: "Krea: K3 Edit",
      can_edit: true,
      max_references: 8,
      pricing: { image: "0.02", image_output: "0.00000718562874251497" },
    });
    expect(Object.keys(summary.params).sort()).toEqual(["aspect_ratio", "resolution", "seed"]);
    for (const key of Object.keys(summary.params)) {
      expect(IMAGE_PARAMS as readonly string[]).toContain(key);
    }
  });

  it("summarizeModel lists the frame settings only for models that output gif", () => {
    expect(summarizeModel(flare26).params).toMatchObject({
      frame_count: { type: "range", min: 2, max: 16 },
      frame_duration_ms: { type: "range", min: 20, max: 2000 },
    });
    expect(summarizeModel(flare).params).not.toHaveProperty("frame_count");
    expect(summarizeModel(vector).params).not.toHaveProperty("frame_count");
  });

  it("summarizeModel derives edit support from modalities and input_references", () => {
    expect(summarizeModel(flash)).toMatchObject({ can_edit: false, max_references: 0 });
    expect(summarizeModel(flare)).toMatchObject({ can_edit: true, max_references: 16 });
    expect(summarizeModel(vector)).toMatchObject({ can_edit: true, max_references: 1 });
  });

  it("an image-capable model without an input_references descriptor accepts one reference", () => {
    const bare: ImageModel = { id: "x/y", name: "Y", inputModalities: ["text", "image"], params: {}, pricing: {} };
    expect(summarizeModel(bare)).toMatchObject({ can_edit: true, max_references: 1 });
    expect(validateRequest(bare, {}, 2, "edit")).toMatch(/at most 1/);
  });
});
