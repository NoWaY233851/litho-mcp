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
    ...overrides,
  };
}
