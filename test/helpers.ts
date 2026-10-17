import type { Deps } from "../src/deps.js";
import { loadConfig } from "../src/config.js";

// Obviously fake values; the two secrets are long enough to pass loadConfig.
export const fullEnv = {
  OPENROUTER_API_KEY: "test-openrouter-key",
  CONNECTOR_SECRET: "test-connector-secret-0123456789abcdef",
  CRON_SECRET: "test-cron-secret-0123456789abcdefghij",
  BLOB_READ_WRITE_TOKEN: "test-blob-token",
  DEFAULT_MODEL: "test/image-model",
  RETENTION_DAYS: "30",
  OPENROUTER_REFERER: "",
} satisfies Record<string, string>;

export function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    config: loadConfig(fullEnv),
    store: undefined,
    thumbnailer: undefined,
    fetch: () => Promise.reject(new Error("network access is not allowed in tests")),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}
