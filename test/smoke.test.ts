import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLazyFetch, handleRequest } from "../src/http.js";
import { fakeDeps, fullEnv } from "./helpers.js";

describe("handleRequest", () => {
  it("404 for unknown paths", async () => {
    expect((await handleRequest(new Request("https://x.test/nope"), fakeDeps())).status).toBe(404);
  });

  it("501 for /mcp until the MCP endpoint is wired", async () => {
    expect((await handleRequest(new Request("https://x.test/mcp"), fakeDeps())).status).toBe(501);
  });
});

describe("loadConfig", () => {
  it("requires secrets and defaults retention to 30", () => {
    expect(() => loadConfig({})).toThrow("missing env: OPENROUTER_API_KEY");
    expect(loadConfig(fullEnv).retentionDays).toBe(30);
  });

  it("fails closed on empty or short CONNECTOR_SECRET / CRON_SECRET", () => {
    expect(() => loadConfig({ ...fullEnv, CONNECTOR_SECRET: "  " })).toThrow();
    expect(() => loadConfig({ ...fullEnv, CRON_SECRET: "short" })).toThrow("weak secret: CRON_SECRET");
  });

  it("trims secrets before measuring them", () => {
    expect(() => loadConfig({ ...fullEnv, CONNECTOR_SECRET: ` ${"a".repeat(31)} ` })).toThrow(
      "weak secret: CONNECTOR_SECRET",
    );
  });

  it("rejects a non-integer or non-positive RETENTION_DAYS", () => {
    for (const bad of ["0", "-1", "1.5", "abc"]) {
      expect(() => loadConfig({ ...fullEnv, RETENTION_DAYS: bad })).toThrow("invalid env: RETENTION_DAYS");
    }
    expect(loadConfig({ ...fullEnv, RETENTION_DAYS: "7" }).retentionDays).toBe(7);
  });

  it("applies defaults for the optional variables", () => {
    const { DEFAULT_MODEL: _m, RETENTION_DAYS: _r, OPENROUTER_REFERER: _f, ...required } = fullEnv;
    const config = loadConfig(required);
    expect(config.defaultModel).toBe("openai/gpt-image-2.5-flare");
    expect(config.retentionDays).toBe(30);
    expect(config.openrouterReferer).toBe("");
  });
});

describe("createLazyFetch", () => {
  it("answers 500 server_misconfigured without leaking the error, then retries", async () => {
    const log = vi.fn();
    let broken = true;
    const build = vi.fn(() => {
      if (broken) throw new Error("missing env: CRON_SECRET");
      return fakeDeps();
    });
    const handle = createLazyFetch(build, log);

    const failed = await handle(new Request("https://x.test/mcp"));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "server_misconfigured" });
    expect(log).toHaveBeenCalledWith("missing env: CRON_SECRET");

    broken = false;
    expect((await handle(new Request("https://x.test/nope"))).status).toBe(404);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("memoizes a successful build", async () => {
    const build = vi.fn(() => fakeDeps());
    const handle = createLazyFetch(build, () => {});
    await handle(new Request("https://x.test/nope"));
    await handle(new Request("https://x.test/nope"));
    expect(build).toHaveBeenCalledTimes(1);
  });
});
