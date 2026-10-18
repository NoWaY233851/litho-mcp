import { extractSecret, secretMatches } from "./auth/secret.js";
import { ConfigError } from "./config.js";
import type { Deps } from "./deps.js";
import { runCleanup } from "./images/cleanup.js";

// Responses carry credentials-adjacent state (auth outcomes, cleanup counts),
// so none of them may be cached by an intermediary.
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const notFound = () => json(404, { error: "not_found" });

// Placeholder until the MCP endpoint is wired in.
async function mcpFetch(_req: Request, _deps: Deps): Promise<Response> {
  return json(501, { error: "not_implemented" });
}

async function cleanup(deps: Deps, log: (message: string) => void): Promise<Response> {
  try {
    const { deleted } = await runCleanup(deps.store, deps.now(), deps.config.retentionDays);
    log(`cleanup deleted ${deleted}`);
    return json(200, { deleted });
  } catch (error) {
    // Only the message is logged, never the stack; the client gets no detail.
    log(`cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json(500, { error: "cleanup_failed" });
  }
}

// Routes on the pathname alone: Vercel rewrites keep the original path
// (docs/design/0008-vercel-hobby.md), and a query parameter must never pick a
// route. /mcp is gated for every method before anything else runs; a missing
// and a wrong secret get the same response, with no WWW-Authenticate
// (docs/design/0009-connector-secret-header.md). The cron route answers 404 on
// any failure so its existence is not advertised. Auth failures and headers
// are never logged.
export async function handleRequest(
  req: Request,
  deps: Deps,
  log: (message: string) => void = () => {},
): Promise<Response> {
  const { pathname } = new URL(req.url);
  const secret = extractSecret(req.headers.get("authorization"));

  if (pathname === "/mcp") {
    if (!secretMatches(secret, deps.config.connectorSecret)) {
      return json(401, { error: "unauthorized" });
    }
    return mcpFetch(req, deps);
  }

  if (pathname === "/cron/cleanup" && req.method === "GET") {
    if (!secretMatches(secret, deps.config.cronSecret)) return notFound();
    return cleanup(deps, log);
  }

  return notFound();
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
    return handleRequest(req, deps, log);
  };
}
