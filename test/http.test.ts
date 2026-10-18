import { describe, expect, it, vi } from "vitest";
import { createLazyFetch, handleRequest } from "../src/http.js";
import { fakeDeps, fullEnv } from "./helpers.js";

const mcp = (headers: Record<string, string> = {}, init: RequestInit = {}) =>
  new Request("https://example.test/mcp", { method: "POST", headers, ...init });

const cron = (headers: Record<string, string> = {}, init: RequestInit = {}) =>
  new Request("https://example.test/cron/cleanup", { headers, ...init });

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

async function snapshot(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers.entries()].sort(),
    body: await response.text(),
  };
}

describe("/mcp authentication", () => {
  it("answers 401 without and with a wrong secret, and reaches the MCP handler with the right one", async () => {
    const deps = fakeDeps();
    expect((await handleRequest(mcp(), deps)).status).toBe(401);
    expect((await handleRequest(mcp(bearer("wrong-secret")), deps)).status).toBe(401);
    const ok = await handleRequest(mcp(bearer(fullEnv.CONNECTOR_SECRET)), deps);
    expect(ok.status).toBe(501);
    expect(await ok.json()).toEqual({ error: "not_implemented" });
  });

  it("accepts a bare secret without the Bearer prefix", async () => {
    const response = await handleRequest(mcp({ authorization: fullEnv.CONNECTOR_SECRET }), fakeDeps());
    expect(response.status).toBe(501);
  });

  it("returns a generic body with no WWW-Authenticate and never echoes the header", async () => {
    const attempt = "attempt-secret-value-0123456789abcdef";
    const response = await handleRequest(mcp(bearer(attempt)), fakeDeps());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeNull();
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "unauthorized" });
    expect(text).not.toContain(attempt);
    expect([...response.headers.values()].join("\n")).not.toContain(attempt);
  });

  it("answers a missing and a wrong secret with byte-identical responses", async () => {
    const deps = fakeDeps();
    const missing = await snapshot(await handleRequest(mcp(), deps));
    const wrong = await snapshot(await handleRequest(mcp(bearer("wrong-secret")), deps));
    expect(wrong).toEqual(missing);
  });

  it("answers a header-less initialize (the add-time probe) with the same 401", async () => {
    const probe = mcp(
      { "content-type": "application/json", accept: "application/json, text/event-stream" },
      {
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
        }),
      },
    );
    const deps = fakeDeps();
    const response = await snapshot(await handleRequest(probe, deps));
    expect(response).toEqual(await snapshot(await handleRequest(mcp(), deps)));
    expect(response.status).toBe(401);
  });

  it("authenticates every method before anything else, including OPTIONS and GET", async () => {
    for (const method of ["OPTIONS", "GET", "DELETE", "PUT"]) {
      const response = await handleRequest(
        new Request("https://example.test/mcp", { method }),
        fakeDeps(),
      );
      expect(response.status, method).toBe(401);
    }
    const authed = await handleRequest(
      new Request("https://example.test/mcp", { method: "GET", headers: bearer(fullEnv.CONNECTOR_SECRET) }),
      fakeDeps(),
    );
    expect(authed.status).toBe(501);
  });

  it("does not accept the cron secret on /mcp", async () => {
    expect((await handleRequest(mcp(bearer(fullEnv.CRON_SECRET)), fakeDeps())).status).toBe(401);
  });

  it("logs nothing for an authentication failure", async () => {
    const log = vi.fn();
    await handleRequest(mcp(bearer("wrong-secret")), fakeDeps(), log);
    await handleRequest(mcp(), fakeDeps(), log);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("/cron/cleanup", () => {
  it("answers 404 for a missing or wrong cron secret, without running cleanup", async () => {
    const deps = fakeDeps();
    const spy = vi.spyOn(deps.store, "listOlderThan");
    expect((await handleRequest(cron(), deps)).status).toBe(404);
    expect((await handleRequest(cron(bearer("wrong-secret")), deps)).status).toBe(404);
    expect((await handleRequest(cron(bearer(fullEnv.CONNECTOR_SECRET)), deps)).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it("answers an unauthorized cron call exactly like an unknown path", async () => {
    const deps = fakeDeps();
    const denied = await snapshot(await handleRequest(cron(bearer("wrong-secret")), deps));
    const unknown = await snapshot(await handleRequest(new Request("https://example.test/nope"), deps));
    expect(denied).toEqual(unknown);
  });

  it("runs cleanup with deps.now() and the configured retention, and reports the count", async () => {
    const deps = fakeDeps();
    const spy = vi.spyOn(deps.store, "listOlderThan");
    const log = vi.fn();
    const response = await handleRequest(cron(bearer(fullEnv.CRON_SECRET)), deps, log);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 0 });
    expect(spy).toHaveBeenCalledWith(deps.now() - deps.config.retentionDays * 86_400_000);
    expect(log).toHaveBeenCalledWith("cleanup deleted 0");
  });

  it("accepts a bare cron secret too", async () => {
    const response = await handleRequest(cron({ authorization: fullEnv.CRON_SECRET }), fakeDeps());
    expect(response.status).toBe(200);
  });

  it("answers 500 cleanup_failed and logs only the error message when cleanup throws", async () => {
    const deps = fakeDeps();
    vi.spyOn(deps.store, "listOlderThan").mockRejectedValue(new Error("blob listing failed"));
    const log = vi.fn();
    const response = await handleRequest(cron(bearer(fullEnv.CRON_SECRET)), deps, log);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "cleanup_failed" });
    expect(log).toHaveBeenCalledWith("cleanup failed: blob listing failed");
  });

  it("logs a fixed text when the thrown value is not an Error", async () => {
    const deps = fakeDeps();
    vi.spyOn(deps.store, "listOlderThan").mockRejectedValue("a string with detail");
    const log = vi.fn();
    const response = await handleRequest(cron(bearer(fullEnv.CRON_SECRET)), deps, log);
    expect(response.status).toBe(500);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toBe("cleanup failed: unknown error");
  });

  it("answers 404 to any method other than GET, whatever the auth", async () => {
    const deps = fakeDeps();
    const spy = vi.spyOn(deps.store, "listOlderThan");
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const response = await handleRequest(cron(bearer(fullEnv.CRON_SECRET), { method }), deps);
      expect(response.status, method).toBe(404);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("routing", () => {
  it("routes on the pathname: /mcp?x=1 is /mcp, while /mcp/x, /mcp/ and /api/index are 404", async () => {
    const deps = fakeDeps();
    const withQuery = await handleRequest(
      new Request("https://example.test/mcp?x=1", { method: "POST", headers: bearer(fullEnv.CONNECTOR_SECRET) }),
      deps,
    );
    expect(withQuery.status).toBe(501);
    for (const path of ["/mcp/x", "/mcp/", "/api/index", "/", "/cron/cleanup/x"]) {
      const response = await handleRequest(
        new Request(`https://example.test${path}`, { headers: bearer(fullEnv.CONNECTOR_SECRET) }),
        deps,
      );
      expect(response.status, path).toBe(404);
    }
  });

  it("ignores a route query parameter", async () => {
    const deps = fakeDeps();
    const cronWithMcpRoute = await handleRequest(
      new Request("https://example.test/cron/cleanup?route=mcp", { headers: bearer(fullEnv.CRON_SECRET) }),
      deps,
    );
    expect(cronWithMcpRoute.status).toBe(200);
    expect(await cronWithMcpRoute.json()).toEqual({ deleted: 0 });

    const mcpWithCronRoute = await handleRequest(
      new Request("https://example.test/mcp?route=cron", { method: "POST" }),
      deps,
    );
    expect(mcpWithCronRoute.status).toBe(401);
    const unknownWithRoute = await handleRequest(
      new Request("https://example.test/nope?route=mcp", { headers: bearer(fullEnv.CONNECTOR_SECRET) }),
      deps,
    );
    expect(unknownWithRoute.status).toBe(404);
  });

  it("marks every JSON response no-store", async () => {
    const deps = fakeDeps();
    const failing = fakeDeps();
    vi.spyOn(failing.store, "listOlderThan").mockRejectedValue(new Error("x"));
    const responses = [
      await handleRequest(mcp(), deps),
      await handleRequest(new Request("https://example.test/nope"), deps),
      await handleRequest(mcp(bearer(fullEnv.CONNECTOR_SECRET)), deps),
      await handleRequest(cron(bearer(fullEnv.CRON_SECRET)), deps),
      await handleRequest(cron(bearer(fullEnv.CRON_SECRET)), failing),
    ];
    expect(responses.map((r) => r.status)).toEqual([401, 404, 501, 200, 500]);
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe("application/json");
    }
  });
});

describe("createLazyFetch routing", () => {
  it("passes its logger to the handler", async () => {
    const log = vi.fn();
    const handle = createLazyFetch(() => fakeDeps(), log);
    const response = await handle(cron(bearer(fullEnv.CRON_SECRET)));
    expect(response.status).toBe(200);
    expect(log).toHaveBeenCalledWith("cleanup deleted 0");
  });
});
