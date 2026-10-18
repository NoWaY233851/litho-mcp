import { loadConfig, type Config } from "./config.js";
import { blobBaseUrl, createBlobStore, type ImageStore } from "./images/store.js";
import { sharpThumbnailer, type Thumbnailer } from "./images/thumbnail.js";

export interface Deps {
  config: Config;
  store: ImageStore;
  thumbnailer: Thumbnailer;
  fetch: typeof fetch;
  now: () => number;
  /** Operational diagnostics only. Callers pass fixed text or an error message, never a prompt, a body or a credential. */
  log: (message: string) => void;
}

// The only place that wires host-specific adapters (docs/design/0008-vercel-hobby.md).
// It does no I/O: the store derives its URLs from configuration. It throws a
// ConfigError when the environment is incomplete, so callers must not cache a
// failure.
export function createDeps(env: Record<string, string | undefined>): Deps {
  const config = loadConfig(env);
  return {
    config,
    store: createBlobStore(config.blobToken, blobBaseUrl(config.blobStoreId)),
    thumbnailer: sharpThumbnailer,
    fetch: (input, init) => globalThis.fetch(input, init),
    now: () => Date.now(),
    log: (message) => console.error(`litho: ${message}`),
  };
}
