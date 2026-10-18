import { ConfigError } from "./config.js";
import type { Deps } from "./deps.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleRequest(req: Request, _deps: Deps): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname === "/mcp") return json(501, { error: "not_implemented" });
  return json(404, { error: "not_found" });
}

// Builds Deps on the first request instead of at import time, so a missing or
// weak secret surfaces as a controlled 500 rather than a function that fails
// to load. Only a successful build is memoized: after the owner fixes the
// environment the next request recovers without a restart. A ConfigError
// message names the offending variable and never a value, so only that is
// logged verbatim; any other error could carry text from a dependency and is
// replaced by a fixed message. The client gets no detail.
export function createLazyFetch(
  build: () => Deps,
  log: (message: string) => void,
): (req: Request) => Promise<Response> {
  let deps: Deps | undefined;
  return async (req) => {
    if (!deps) {
      try {
        deps = build();
      } catch (error) {
        log(error instanceof ConfigError ? error.message : "failed to build dependencies");
        return json(500, { error: "server_misconfigured" });
      }
    }
    return handleRequest(req, deps);
  };
}
