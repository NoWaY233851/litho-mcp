import { loadConfig, type Config } from "./config.js";

// ImageStore and Thumbnailer are declared with their adapters; until then they
// are opaque placeholders so Deps already has its final shape.
export interface Deps {
  config: Config;
  store: unknown;
  thumbnailer: unknown;
  fetch: typeof fetch;
  now: () => number;
}

// The only place that wires host-specific adapters. Throws when the
// environment is incomplete, so callers must not cache a failure.
export function createDeps(env: Record<string, string | undefined>): Deps {
  return {
    config: loadConfig(env),
    store: undefined,
    thumbnailer: undefined,
    fetch: (input, init) => globalThis.fetch(input, init),
    now: () => Date.now(),
  };
}
