import { readFileSync } from "node:fs";
import type { Deps } from "../src/deps.js";
import { loadConfig } from "../src/config.js";
import { createMemoryStore } from "../src/images/store.js";
import type { Thumbnailer } from "../src/images/thumbnail.js";

// Obviously fake values; the two secrets are long enough to pass loadConfig.
export const fullEnv = {
  OPENROUTER_API_KEY: "test-openrouter-key",
  CONNECTOR_SECRET: "test-connector-secret-0123456789abcdef",
  CRON_SECRET: "test-cron-secret-0123456789abcdefghij",
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_TestStore01_fake",
  DEFAULT_MODEL: "test/image-model",
  RETENTION_DAYS: "30",
  OPENROUTER_REFERER: "",
} satisfies Record<string, string>;

// Returns a fixed few bytes, so tests that only need a thumbnail to exist stay
// independent of sharp.
export const fakeThumbnailer: Thumbnailer = {
  toWebp: async () => new Uint8Array([0x52, 0x49, 0x46, 0x46]),
};

export function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    config: loadConfig(fullEnv),
    store: createMemoryStore(),
    thumbnailer: fakeThumbnailer,
    fetch: () => Promise.reject(new Error("network access is not allowed in tests")),
    now: () => 1_700_000_000_000,
    log: () => {},
    ...overrides,
  };
}

// A real 1x1 PNG, so the bytes survive sniffing in createImage and in the store.
export const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const catalog = readFileSync(new URL("./fixtures/image-models.json", import.meta.url), "utf8");
const pricing = readFileSync(new URL("./fixtures/models-pricing.json", import.meta.url), "utf8");

export interface FakeCall {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

type Responder = () => Response | Promise<Response>;

/**
 * Serves the catalog fixtures plus fake image and key endpoints, and records every call.
 * Anything unrouted answers 404, so a test that reaches for the network fails loudly.
 */
export function fakeOpenRouter(
  overrides: { images?: Responder; key?: Responder; catalog?: Responder } = {},
) {
  const calls: FakeCall[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    });
    if (url === "https://openrouter.ai/api/v1/images/models") {
      return overrides.catalog ? overrides.catalog() : new Response(catalog, { status: 200 });
    }
    if (url === "https://openrouter.ai/api/v1/models?output_modalities=image") {
      return new Response(pricing, { status: 200 });
    }
    if (url === "https://openrouter.ai/api/v1/images" && method === "POST") {
      return overrides.images
        ? overrides.images()
        : Response.json({ data: [{ b64_json: PNG_B64 }], usage: { cost: 0.04 } });
    }
    if (url === "https://openrouter.ai/api/v1/key") {
      return overrides.key
        ? overrides.key()
        : Response.json({ data: { limit: 10, limit_remaining: 0.5, limit_reset: "monthly" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const posts = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/images"));
  return { f, calls, posts };
}
