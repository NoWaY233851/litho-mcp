import type { CallToolResult } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createMemoryStore } from "../src/images/store.js";
import { GenerateArgs, generateImage, listModels } from "../src/mcp/tools.js";
import { _resetModelCache } from "../src/openrouter/models.js";
import { PNG_B64, fakeDeps, fakeOpenRouter, fullEnv } from "./helpers.js";

const FLARE = "openai/gpt-image-2.5-flare";
const config = loadConfig({ ...fullEnv, DEFAULT_MODEL: FLARE });

function setup(overrides: Parameters<typeof fakeOpenRouter>[0] = {}, extra: Parameters<typeof fakeDeps>[0] = {}) {
  const or = fakeOpenRouter(overrides);
  const logs: string[] = [];
  const deps = fakeDeps({ config, fetch: or.f, log: (m) => logs.push(m), ...extra });
  return { or, logs, deps };
}

const texts = (r: CallToolResult): string[] =>
  r.content.flatMap((c) => (c.type === "text" ? [c.text] : []));

beforeEach(() => _resetModelCache());

describe("generateImage", () => {
  it("uses DEFAULT_MODEL, stores img_, returns a thumbnail, one text item per line and structuredContent", async () => {
    const { or, logs, deps } = setup();
    // CJK on purpose: non-ASCII must reach OpenRouter and survive storage.
    const prompt = "番茄炒蛋菜譜，四個步驟";
    const r = await generateImage(deps, { prompt, aspect_ratio: "2:3" });

    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({
      kind: "image",
      model: FLARE,
      aspect_ratio: "2:3",
      cost_usd: 0.04,
      width: 1,
      height: 1,
      mime: "image/png",
      url: expect.stringMatching(/\/img\/[0-9a-f]{32}$/),
      id: expect.stringMatching(/^img_[0-9a-f]{32}$/),
    });
    expect(sc).not.toHaveProperty("parent");

    expect(r.content[0]).toEqual({ type: "image", data: expect.any(String), mimeType: "image/webp" });
    expect(texts(r)).toEqual([
      `id: ${sc.id}`,
      `url: ${sc.url}`,
      `model: ${FLARE}`,
      "aspect ratio: 2:3",
      "cost: $0.04",
    ]);
    expect(JSON.stringify(r).length).toBeLessThan(400_000);

    expect(or.posts()).toHaveLength(1);
    expect(or.posts()[0]!.body).toMatchObject({ model: FLARE, prompt, aspect_ratio: "2:3" });
    const stored = await deps.store.get(sc.id as string);
    expect(Buffer.from(stored!.bytes).toString("base64")).toBe(PNG_B64);
    // Nothing is logged for a normal call: no prompt, no body.
    expect(logs).toEqual([]);
  });

  it("an explicit model wins over DEFAULT_MODEL, and a blank one falls back to it", async () => {
    const { or, deps } = setup();
    await generateImage(deps, { prompt: "a", model: "recraft/recraft-v4.1-flash" });
    await generateImage(deps, { prompt: "a", model: "  " });
    expect(or.posts().map((c) => c.body!.model)).toEqual(["recraft/recraft-v4.1-flash", FLARE]);
  });

  it("states the pixel size when no aspect ratio was requested, and cost: unknown without a reported cost", async () => {
    const { deps } = setup({ images: () => Response.json({ data: [{ b64_json: PNG_B64 }] }) });
    const r = await generateImage(deps, { prompt: "a" });
    expect(texts(r).slice(3)).toEqual(["size: 1×1", "cost: unknown"]);
    expect(r.structuredContent).toMatchObject({ aspect_ratio: null, cost_usd: null });
  });

  it("returns the text and structuredContent without an image block when no thumbnail fits, and logs one fixed line", async () => {
    const { deps, logs } = setup(
      {},
      {
        thumbnailer: {
          toWebp: async () => {
            throw new Error("decoder exploded with prompt text");
          },
        },
      },
    );
    const r = await generateImage(deps, { prompt: "a secret prompt" });
    expect(r.isError).toBeFalsy();
    expect(r.content.every((c) => c.type === "text")).toBe(true);
    expect(r.structuredContent).toMatchObject({ kind: "image" });
    expect(logs).toEqual(["thumbnail unavailable"]);
  });

  it("validation failure returns isError and makes no OpenRouter POST", async () => {
    const { or, deps } = setup();
    const r = await generateImage(deps, { prompt: "a", resolution: "4K" });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toContain('does not support "resolution"');
    expect(or.posts()).toHaveLength(0);
  });

  it("unknown model suggests list_models and makes no OpenRouter POST", async () => {
    const { or, deps } = setup();
    const r = await generateImage(deps, { prompt: "a", model: "nope/missing" });
    expect(r.isError).toBe(true);
    expect(texts(r)).toEqual(['Unknown model "nope/missing". Call list_models to see the available image models.']);
    expect(or.posts()).toHaveLength(0);
  });

  it("402 returns the spending-limit message built from /api/v1/key", async () => {
    const { or, deps } = setup({
      images: () => Response.json({ error: { code: 402, message: "Insufficient credits" } }, { status: 402 }),
    });
    const r = await generateImage(deps, { prompt: "a" });
    expect(r.isError).toBe(true);
    const [message] = texts(r);
    expect(message).toContain("spending limit reached");
    expect(message).toContain("limit $10");
    expect(message).toContain("remaining $0.5");
    expect(or.calls.some((c) => c.url.endsWith("/api/v1/key"))).toBe(true);
  });

  it("does not look up the key for an error that is not about limits", async () => {
    const { or, deps } = setup({
      images: () => Response.json({ error: { code: 502, message: "upstream" } }, { status: 502 }),
    });
    const r = await generateImage(deps, { prompt: "a" });
    expect(texts(r)[0]).toContain("You were not charged");
    expect(or.calls.some((c) => c.url.endsWith("/api/v1/key"))).toBe(false);
  });

  it("never copies provider metadata or raw output into the result or the log", async () => {
    const { deps, logs } = setup({
      images: () =>
        Response.json(
          {
            error: {
              code: 403,
              message: "moderated",
              metadata: { reasons: ["violence"], provider_name: "Acme", raw: "RAW-PROVIDER-OUTPUT echoing the prompt" },
            },
          },
          { status: 403 },
        ),
    });
    const r = await generateImage(deps, { prompt: "a" });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toContain("content moderation");
    expect(JSON.stringify(r)).not.toContain("RAW-PROVIDER-OUTPUT");
    expect(logs.join("\n")).not.toContain("RAW-PROVIDER-OUTPUT");
  });

  it("a store failure after a successful generation says the image was generated but not saved, with the cost", async () => {
    const store = createMemoryStore();
    store.put = async () => {
      throw new Error("blob unavailable");
    };
    const { deps, logs } = setup({}, { store });
    const r = await generateImage(deps, { prompt: "a" });
    expect(r.isError).toBe(true);
    const [message] = texts(r);
    expect(message).toMatch(/generated/);
    expect(message).toMatch(/could not be saved/);
    expect(message).toContain("$0.04");
    expect(message).not.toContain("blob unavailable");
    expect(logs).toEqual(["image save failed: blob unavailable"]);
  });

  it("a store failure with no reported cost still reports the generation", async () => {
    const store = createMemoryStore();
    store.put = async () => {
      throw new Error("blob unavailable");
    };
    const { deps } = setup({ images: () => Response.json({ data: [{ b64_json: PNG_B64 }] }) }, { store });
    const [message] = texts(await generateImage(deps, { prompt: "a" }));
    expect(message).toMatch(/generated/);
    expect(message).toMatch(/could not be saved/);
    expect(message).not.toContain("$");
  });

  it("returns a fixed message for an unexpected error and logs only its message", async () => {
    const broken = {
      ...config,
      get defaultModel(): string {
        throw new Error("boom with details");
      },
    };
    const { deps, logs } = setup({}, { config: broken });
    const r = await generateImage(deps, { prompt: "a secret prompt" });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain("boom with details");
    expect(logs).toEqual(["unexpected error: boom with details"]);
    expect(logs.join("\n")).not.toContain("secret prompt");
  });

  it("a catalog failure is a fixed message, the error text is logged, and nothing is sent to /images", async () => {
    const { or, deps, logs } = setup({ catalog: () => new Response("secret body", { status: 500 }) });
    const r = await generateImage(deps, { prompt: "a" });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain("HTTP 500");
    expect(JSON.stringify(r)).not.toContain("secret body");
    expect(logs).toEqual(["catalog unavailable: OpenRouter /api/v1/images/models returned HTTP 500"]);
    expect(or.posts()).toHaveLength(0);
  });

  it("never throws, even when fetch itself rejects with a non-Error", async () => {
    const deps = fakeDeps({ config, fetch: (() => Promise.reject("weird")) as typeof fetch });
    const r = await generateImage(deps, { prompt: "a" });
    expect(r.isError).toBe(true);
  });
});

describe("GenerateArgs", () => {
  it("requires a non-empty prompt and bounds the numeric parameters", () => {
    expect(GenerateArgs.safeParse({ prompt: "" }).success).toBe(false);
    expect(GenerateArgs.safeParse({ prompt: "a", output_compression: 101 }).success).toBe(false);
    expect(GenerateArgs.safeParse({ prompt: "a", output_compression: 1.5 }).success).toBe(false);
    expect(GenerateArgs.safeParse({ prompt: "a", seed: 1.5 }).success).toBe(false);
    expect(GenerateArgs.safeParse({ prompt: "a", output_compression: 0, seed: -3 }).success).toBe(true);
  });
});

describe("listModels", () => {
  it("lists every model with its capabilities and stays under 150k characters", async () => {
    const { deps } = setup();
    const r = await listModels(deps, {});
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(r).length).toBeLessThan(150_000);
    const body = JSON.parse(texts(r).join("\n")) as { default_model: string; models: { id: string; can_edit: boolean }[] };
    expect(body.default_model).toBe(FLARE);
    expect(body.models.map((m) => m.id)).toContain("krea/k3-edit");
    expect(body.models.find((m) => m.id === FLARE)).toMatchObject({ can_edit: true });
  });

  it("filters by query on id or name, ignoring case", async () => {
    const { deps } = setup();
    const byId = JSON.parse(texts(await listModels(deps, { query: "KREA" })).join("\n")) as { models: { id: string }[] };
    expect(byId.models.map((m) => m.id)).toEqual(["krea/k3-edit"]);
    const byName = JSON.parse(texts(await listModels(deps, { query: "recraft v4.1 flash" })).join("\n")) as {
      models: { id: string }[];
    };
    expect(byName.models.map((m) => m.id)).toEqual(["recraft/recraft-v4.1-flash"]);
  });

  it("says so when nothing matches", async () => {
    const { deps } = setup();
    const r = await listModels(deps, { query: "zzz-none" });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(texts(r).join("\n"))).toMatchObject({ models: [] });
  });

  it("returns an error result, not a throw, when the catalog is unavailable", async () => {
    const { deps, logs } = setup({ catalog: () => new Response("x", { status: 500 }) });
    const r = await listModels(deps, {});
    expect(r.isError).toBe(true);
    expect(logs).toHaveLength(1);
  });
});
