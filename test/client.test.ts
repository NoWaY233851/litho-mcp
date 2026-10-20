import { afterEach, describe, expect, it, vi } from "vitest";
import { createImage, getKeyInfo, type CreateImageRequest } from "../src/openrouter/client.js";
import { OpenRouterError, describeOpenRouterError } from "../src/openrouter/errors.js";
import { bytesToBase64 } from "../src/images/base64.js";
import { fullEnv } from "./helpers.js";

const KEY = fullEnv.OPENROUTER_API_KEY;
const cfg = { openrouterApiKey: KEY, openrouterReferer: "" };

// A PNG header is all sniffImage reads: signature, then an IHDR chunk with 2x3 dimensions.
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 2, 0, 0, 0,
  0, 0, 0, 0,
]);
const PNG_B64 = bytesToBase64(PNG_BYTES);
const SVG_B64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  signal: AbortSignal | null | undefined;
  redirect: RequestRedirect | undefined;
}

function recorder(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      signal: init?.signal,
      redirect: init?.redirect,
    });
    return respond();
  }) as typeof fetch;
  return { f, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const okBody = (extra: Record<string, unknown> = {}) => ({
  data: [{ b64_json: PNG_B64, media_type: "image/png" }],
  usage: { cost: 0.04 },
  ...extra,
});

const req = (over: Partial<CreateImageRequest> = {}): CreateImageRequest => ({
  model: "test/image-model",
  prompt: "a lighthouse",
  params: {},
  references: [],
  ...over,
});

async function failure(promise: Promise<unknown>): Promise<OpenRouterError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(OpenRouterError);
    return e as OpenRouterError;
  }
  throw new Error("expected a rejection");
}

// Resolves a hung fetch as an abort, the way the platform fetch does when its signal fires.
const hangingFetch = (): typeof fetch =>
  ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;

afterEach(() => vi.useRealTimers());

describe("createImage request", () => {
  it("POSTs /api/v1/images with model, prompt, params, input_references and headers", async () => {
    const { f, calls } = recorder(() => json(okBody()));
    const dataUrl = "data:image/png;base64,AAAA";
    await createImage(
      cfg,
      req({ params: { aspect_ratio: "16:9", seed: 7, quality: undefined }, references: [dataUrl] }),
      f,
    );
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://openrouter.ai/api/v1/images");
    expect(call.method).toBe("POST");
    expect(call.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "X-OpenRouter-Title": "litho-mcp",
    });
    expect(call.body).toEqual({
      model: "test/image-model",
      prompt: "a lighthouse",
      aspect_ratio: "16:9",
      seed: 7,
      input_references: [{ type: "image_url", image_url: { url: dataUrl } }],
    });
    expect(call.body).not.toHaveProperty("n");
  });

  it("omits input_references when there are none and sends no HTTP-Referer by default", async () => {
    const { f, calls } = recorder(() => json(okBody()));
    await createImage(cfg, req(), f);
    expect(calls[0]!.body).toEqual({ model: "test/image-model", prompt: "a lighthouse" });
    expect(Object.keys(calls[0]!.headers)).not.toContain("HTTP-Referer");
  });

  it("sends every image parameter at the top level", async () => {
    const { f, calls } = recorder(() => json(okBody()));
    const params = {
      aspect_ratio: "1:1",
      resolution: "2K",
      quality: "high",
      background: "opaque",
      output_format: "png",
      output_compression: 0,
      seed: 0,
    };
    await createImage(cfg, req({ params }), f);
    expect(calls[0]!.body).toEqual({ model: "test/image-model", prompt: "a lighthouse", ...params });
  });

  it("sends HTTP-Referer when configured", async () => {
    const { f, calls } = recorder(() => json(okBody()));
    await createImage({ ...cfg, openrouterReferer: "https://app.example.test" }, req(), f);
    expect(calls[0]!.headers["HTTP-Referer"]).toBe("https://app.example.test");
  });
});

describe("createImage response", () => {
  it("returns decoded bytes, sniffed info and usage.cost", async () => {
    const { f } = recorder(() => json(okBody()));
    const out = await createImage(cfg, req(), f);
    expect(Array.from(out.bytes)).toEqual(Array.from(PNG_BYTES));
    expect(out.info).toEqual({ mime: "image/png", width: 2, height: 3 });
    expect(out.costUsd).toBe(0.04);
  });

  it("uses only the first image when several come back", async () => {
    const { f } = recorder(() =>
      json({ data: [{ b64_json: PNG_B64 }, { b64_json: SVG_B64, media_type: "image/svg+xml" }] }),
    );
    const out = await createImage(cfg, req(), f);
    expect(out.info.mime).toBe("image/png");
  });

  it.each([
    ["usage missing", {}],
    ["cost missing", { usage: {} }],
    ["cost a string", { usage: { cost: "0.04" } }],
    ["cost null", { usage: { cost: null } }],
  ])("reports a null cost when %s", async (_name, extra) => {
    const { f } = recorder(() => json({ data: [{ b64_json: PNG_B64 }], ...extra }));
    expect((await createImage(cfg, req(), f)).costUsd).toBeNull();
  });

  it("throws unsupported_output for an SVG media type", async () => {
    const { f } = recorder(() => json({ data: [{ b64_json: SVG_B64, media_type: "image/svg+xml" }] }));
    const e = await failure(createImage(cfg, req(), f));
    expect(e.code).toBe("unsupported_output");
    expect(e.message).toMatch(/SVG/);
    expect(e.message).toMatch(/PNG, JPEG and WebP/);
  });

  it("throws unsupported_output when the bytes are not PNG, JPEG or WebP", async () => {
    const { f } = recorder(() => json({ data: [{ b64_json: SVG_B64, media_type: "image/png" }] }));
    expect((await failure(createImage(cfg, req(), f))).code).toBe("unsupported_output");
  });

  it("throws empty_response when data is []", async () => {
    const { f } = recorder(() => json({ data: [] }));
    const e = await failure(createImage(cfg, req(), f));
    expect(e.code).toBe("empty_response");
    expect(e.status).toBe(200);
  });

  it.each([
    ["a body that is not JSON", () => new Response("<html>oops</html>", { status: 200 })],
    ["a JSON body that is not an object", () => json("ok")],
    ["no data field", () => json({ usage: { cost: 1 } })],
    ["a data field that is not an array", () => json({ data: {} })],
    ["an item without b64_json", () => json({ data: [{ url: "https://img.example.test/a.png" }] })],
    ["an item that is not an object", () => json({ data: [null] })],
    ["a b64_json that is not a string", () => json({ data: [{ b64_json: 5 }] })],
    ["a b64_json that is not valid base64", () => json({ data: [{ b64_json: "not base64!!" }] })],
    ["an empty object", () => json({})],
  ])("throws invalid_response for %s", async (_name, respond) => {
    const { f } = recorder(respond);
    const e = await failure(createImage(cfg, req(), f));
    expect(e.code).toBe("invalid_response");
    expect(e.status).toBe(200);
  });
});

describe("createImage failures after a 2xx", () => {
  const costNote = /billed.*reported cost \$0\.19/i;

  it("carries usage.cost on empty_response and says the call may have been billed", async () => {
    const { f } = recorder(() => json({ data: [], usage: { cost: 0.19 } }));
    const e = await failure(createImage(cfg, req(), f));
    expect(e.code).toBe("empty_response");
    expect(e.costUsd).toBe(0.19);
    const text = describeOpenRouterError(e, null);
    expect(text).toMatch(costNote);
    expect(text).toMatch(/prompt or the model/i);
    expect(text).not.toMatch(/not charged/i);
  });

  it("reports a sub-cent cost instead of rounding it to $0", async () => {
    const { f } = recorder(() => json({ data: [], usage: { cost: 0.00002 } }));
    const e = await failure(createImage(cfg, req(), f));
    expect(describeOpenRouterError(e, null)).toMatch(/reported cost \$0\.00002\)/);
  });

  it("carries usage.cost on unsupported_output (SVG media type)", async () => {
    const { f } = recorder(() =>
      json({ data: [{ b64_json: SVG_B64, media_type: "image/svg+xml" }], usage: { cost: 0.19 } }),
    );
    const e = await failure(createImage(cfg, req(), f));
    expect(e.code).toBe("unsupported_output");
    expect(e.costUsd).toBe(0.19);
    expect(describeOpenRouterError(e, null)).toMatch(costNote);
  });

  it("carries usage.cost on unsupported_output (sniff failure)", async () => {
    const { f } = recorder(() => json({ data: [{ b64_json: SVG_B64 }], usage: { cost: 0.19 } }));
    expect((await failure(createImage(cfg, req(), f))).costUsd).toBe(0.19);
  });

  it("carries usage.cost on invalid_response (bad base64)", async () => {
    const { f } = recorder(() => json({ data: [{ b64_json: "not base64!!" }], usage: { cost: 0.19 } }));
    const e = await failure(createImage(cfg, req(), f));
    expect(e.code).toBe("invalid_response");
    expect(e.costUsd).toBe(0.19);
    expect(describeOpenRouterError(e, null)).toMatch(costNote);
  });

  it("says the call may have been billed even when no cost was reported", async () => {
    const { f } = recorder(() => json({ data: [] }));
    const e = await failure(createImage(cfg, req(), f));
    expect(e.costUsd).toBeNull();
    const text = describeOpenRouterError(e, null);
    expect(text).toMatch(/may have been billed/);
    expect(text).not.toMatch(/reported cost/);
  });

  it("ignores a cost that is not a finite number", async () => {
    const { f } = recorder(() => json({ data: [], usage: { cost: "0.19" } }));
    expect((await failure(createImage(cfg, req(), f))).costUsd).toBeNull();
  });

  it("reports response_interrupted when the body breaks after a 2xx", async () => {
    const f = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`socket closed ${KEY}`));
            },
          }),
          { status: 200 },
        ),
      )) as typeof fetch;
    const e = await failure(createImage(cfg, req(), f));
    expect(e.status).toBe(200);
    expect(e.code).toBe("response_interrupted");
    expect(e.message).not.toContain(KEY);
    expect(describeOpenRouterError(e, null)).toMatch(/may have been generated and billed.*check OpenRouter activity before retrying/i);
  });

  it("keeps network_error for a failure before any response", async () => {
    const f = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    expect((await failure(createImage(cfg, req(), f))).code).toBe("network_error");
  });

  it("falls back to the status when an error response body breaks", async () => {
    const f = (() =>
      Promise.resolve(
        new Response(new ReadableStream({ start: (c) => c.error(new Error("reset")) }), { status: 502 }),
      )) as typeof fetch;
    const e = await failure(createImage(cfg, req(), f));
    expect(e.status).toBe(502);
    expect(e.code).toBe("http_502");
  });
});

describe("redirect handling", () => {
  it("never follows redirects, for generation and key lookups", async () => {
    const gen = recorder(() => json(okBody()));
    await createImage(cfg, req(), gen.f);
    expect(gen.calls[0]!.redirect).toBe("error");
    const key = recorder(() => json({ data: { limit: null, limit_remaining: null, limit_reset: null } }));
    await getKeyInfo(cfg, key.f);
    expect(key.calls[0]!.redirect).toBe("error");
  });
});

describe("OpenRouterError metadata", () => {
  it("keeps only the keys the messages use and drops raw provider output", async () => {
    const { f } = recorder(() =>
      json(
        {
          error: {
            code: 403,
            message: "flagged",
            metadata: {
              provider_name: "OpenAI",
              reasons: ["violence"],
              flagged_input: "text",
              limit_source: "x",
              limit_usd: 5,
              raw: "the full prompt echoed back",
              request_id: "abc",
            },
          },
        },
        403,
      ),
    );
    const e = await failure(createImage(cfg, req(), f));
    expect(e.metadata).toEqual({
      provider_name: "OpenAI",
      reasons: ["violence"],
      flagged_input: "text",
      limit_source: "x",
      limit_usd: 5,
    });
    expect(JSON.stringify(e)).not.toContain("echoed");
  });

  it("drops unknown keys on direct construction too", () => {
    expect(new OpenRouterError(403, "c", "m", { raw: "x", other: 1 }).metadata).toEqual({});
    expect(new OpenRouterError(403, "c", "m").metadata).toBeUndefined();
  });
});

describe("createImage errors inside a 200 body", () => {
  const inBody = (error: Record<string, unknown>) => recorder(() => json({ error }));

  it("treats an in-body 502 as the retryable, not-charged error", async () => {
    const { f } = inBody({ code: 502, message: "Provider returned an invalid response" });
    const e = await failure(createImage(cfg, req(), f));
    expect(e.status).toBe(502);
    expect(e.code).toBe("http_502");
    expect(e.message).toBe("Provider returned an invalid response");
    expect(describeOpenRouterError(e, null)).toMatch(/failed or timed out.*not charged.*retry/i);
  });

  it("treats an in-body 402 as a limit error", async () => {
    const { f } = inBody({ code: 402, message: "Insufficient credits" });
    const e = await failure(createImage(cfg, req(), f));
    expect(e.status).toBe(402);
    expect(describeOpenRouterError(e, { limit: 10, limitRemaining: 0, limitReset: "monthly" })).toMatch(
      /spending limit.*\$10.*remaining \$0/i,
    );
  });

  it("keeps the string code and metadata of an in-body error", async () => {
    const { f } = inBody({ code: 403, message: "refused", metadata: { provider_name: "OpenAI" } });
    const e = await failure(createImage(cfg, req(), f));
    expect(e.status).toBe(403);
    expect(describeOpenRouterError(e, null)).toMatch(/rejected by OpenAI content moderation/);
  });

  it.each([["a string", "server_error"], ["a float", 502.5], ["out of range", 99], ["too large", 600], ["missing", undefined]])(
    "uses the HTTP status when the in-body code is %s",
    async (_name, code) => {
      const { f } = inBody({ code, message: "boom" });
      const e = await failure(createImage(cfg, req(), f));
      expect(e.status).toBe(200);
      expect(e.code).toBe(code === "server_error" ? "server_error" : "http_200");
      expect(describeOpenRouterError(e, null)).toBe("OpenRouter reported an error after accepting the request: boom");
    },
  );

  it("an in-body error borrowing a server code is passed through as an upstream error", async () => {
    const { f } = inBody({ code: "empty_response", message: "boom" });
    const e = await failure(createImage(cfg, req(), f));
    expect(e.code).toBe("http_200");
    expect(describeOpenRouterError(e, null)).toBe("OpenRouter reported an error after accepting the request: boom");
  });

  it("cuts a long in-body message to 500 characters", async () => {
    const { f } = inBody({ code: 400, message: "z".repeat(2000) });
    expect((await failure(createImage(cfg, req(), f))).message.length).toBeLessThanOrEqual(500);
  });

  it("still reports invalid_response when the body has neither data nor an error object", async () => {
    const { f } = recorder(() => json({ error: "boom" }));
    expect((await failure(createImage(cfg, req(), f))).code).toBe("invalid_response");
  });
});

describe("createImage failures", () => {
  it("maps an HTTP error body to OpenRouterError with a string code and metadata", async () => {
    const { f } = recorder(() =>
      json({ error: { code: "content_policy_violation", message: "bad", metadata: { provider_name: "OpenAI" } } }, 403),
    );
    const e = await failure(createImage(cfg, req(), f));
    expect(e.status).toBe(403);
    expect(e.code).toBe("content_policy_violation");
    expect(e.message).toBe("bad");
    expect(e.metadata).toEqual({ provider_name: "OpenAI" });
  });

  it("ignores an upstream string code that is one of the server's own codes", async () => {
    const { f } = recorder(() => json({ error: { code: "timeout", message: "slow upstream" } }, 504));
    const e = await failure(createImage(cfg, req(), f));
    expect(e.code).toBe("http_504");
    expect(describeOpenRouterError(e, null)).toBe("The OpenRouter generation failed or timed out (HTTP 504). The call can be retried.");
  });

  it("falls back to http_<status> for a numeric or empty code", async () => {
    for (const code of [402, "", null, undefined]) {
      const { f } = recorder(() => json({ error: { code, message: "nope" } }, 402));
      expect((await failure(createImage(cfg, req(), f))).code).toBe("http_402");
    }
  });

  it("does not echo a body that is not an OpenRouter error object", async () => {
    const { f } = recorder(() => new Response("<html>upstream said sk-secret-ish</html>", { status: 502 }));
    const e = await failure(createImage(cfg, req(), f));
    expect(e.code).toBe("http_502");
    expect(e.message).not.toContain("sk-secret-ish");
    expect(e.message).toContain("502");
  });

  it("cuts a long upstream message to 500 characters", async () => {
    const { f } = recorder(() => json({ error: { code: 400, message: "x".repeat(2000) } }, 400));
    const e = await failure(createImage(cfg, req(), f));
    expect(e.message.length).toBeLessThanOrEqual(500);
    expect(describeOpenRouterError(e, null).length).toBeLessThan(600);
  });

  it("times out with OpenRouterError(408, 'timeout')", async () => {
    const e = await failure(createImage(cfg, req(), hangingFetch(), 50));
    expect(e.status).toBe(408);
    expect(e.code).toBe("timeout");
  });

  it("defaults the timeout to 200 s", async () => {
    vi.useFakeTimers();
    const pending = failure(createImage(cfg, req(), hangingFetch()));
    await vi.advanceTimersByTimeAsync(199_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).code).toBe("timeout");
  });

  it("times out while the response body is still being read", async () => {
    const f = ((_url: unknown, init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    }) as typeof fetch;
    expect((await failure(createImage(cfg, req(), f, 50))).code).toBe("timeout");
  });

  it("maps a fetch rejection to a retryable network_error without leaking its message", async () => {
    const f = (() => Promise.reject(new TypeError(`connect failed for Bearer ${KEY}`))) as typeof fetch;
    const e = await failure(createImage(cfg, req(), f));
    expect(e.status).toBe(502);
    expect(e.code).toBe("network_error");
    expect(e.message).not.toContain(KEY);
  });

  it("never puts the API key in an error message", async () => {
    const cases: Array<() => Response | Promise<Response>> = [
      () => json({ error: { code: 401, message: "No auth credentials found" } }, 401),
      () => json({ data: [] }),
      () => json({ data: [{ b64_json: "%%%" }] }),
      () => new Response("nope", { status: 500 }),
      () => Promise.reject(new Error(`boom ${KEY}`)),
    ];
    for (const respond of cases) {
      const { f } = recorder(respond);
      const e = await failure(createImage(cfg, req(), f));
      expect(e.message.includes(KEY)).toBe(false);
      expect(describeOpenRouterError(e, null).includes(KEY)).toBe(false);
    }
  });
});

describe("getKeyInfo", () => {
  const keyBody = (data: Record<string, unknown>) => json({ data });

  it("GETs /api/v1/key with the bearer key and maps the limit fields", async () => {
    const { f, calls } = recorder(() => keyBody({ label: "k", limit: 100, limit_remaining: 74.5, limit_reset: "monthly" }));
    expect(await getKeyInfo(cfg, f)).toEqual({ limit: 100, limitRemaining: 74.5, limitReset: "monthly" });
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/key");
    expect(calls[0]!.method ?? "GET").toBe("GET");
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("accepts a key with no limit", async () => {
    const { f } = recorder(() => keyBody({ limit: null, limit_remaining: null, limit_reset: null }));
    expect(await getKeyInfo(cfg, f)).toEqual({ limit: null, limitRemaining: null, limitReset: null });
  });

  it.each([
    ["a non-2xx status", () => json({ error: { code: 401, message: "no" } }, 401)],
    ["a body that is not JSON", () => new Response("<html/>", { status: 200 })],
    ["no data object", () => json({})],
    ["a missing field", () => keyBody({ limit: 1, limit_remaining: 1 })],
    ["a field of the wrong type", () => keyBody({ limit: "10", limit_remaining: 1, limit_reset: null })],
    ["a non-finite number", () => new Response('{"data":{"limit":1e999,"limit_remaining":1,"limit_reset":null}}')],
  ])("returns null for %s", async (_name, respond) => {
    const { f } = recorder(respond);
    expect(await getKeyInfo(cfg, f)).toBeNull();
  });

  it("returns null when the network fails", async () => {
    const f = (() => Promise.reject(new Error("offline"))) as typeof fetch;
    expect(await getKeyInfo(cfg, f)).toBeNull();
  });

  it("gives up after 15 s", async () => {
    vi.useFakeTimers();
    const pending = getKeyInfo(cfg, hangingFetch());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toBeNull();
  });
});

describe("describeOpenRouterError", () => {
  it.each([
    [
      new OpenRouterError(402, "payment_required", "x", { limit_source: "openrouter_key_limit" }),
      { limit: 10, limitRemaining: 0, limitReset: "monthly" },
      /spending limit.*\$10.*remaining \$0.*monthly/i,
    ],
    [new OpenRouterError(403, "forbidden", "x", { limit_source: "openrouter_key_limit" }), null, /spending limit/i],
    [new OpenRouterError(403, "http_403", "x", { limit_source: "openrouter_credits" }), null, /spending limit/i],
    [new OpenRouterError(403, "http_403", "x", { limit_source: "openrouter_in_flight_budget" }), null, /spending limit/i],
    [new OpenRouterError(403, "http_403", "x", { limit_usd: 5 }), null, /spending limit/i],
    [new OpenRouterError(402, "http_402", "x"), null, /spending limit/i],
    [
      new OpenRouterError(403, "content_policy_violation", "bad", { provider_name: "OpenAI" }),
      null,
      /rejected by OpenAI content moderation/,
    ],
    [new OpenRouterError(502, "bad_gateway", "x"), null, /failed or timed out.*not charged.*retry/i],
    [new OpenRouterError(400, "bad_request", "No provider supports x"), null, /OpenRouter error 400: No provider supports x/],
  ])("describes %#", (e, key, re) => expect(describeOpenRouterError(e, key)).toMatch(re));

  it("formats the limit with whatever the key info provides", () => {
    const e = new OpenRouterError(402, "http_402", "x");
    expect(describeOpenRouterError(e, { limit: 0.5, limitRemaining: 0.125, limitReset: null })).toMatch(
      /limit \$0\.5.*remaining \$0\.13/i,
    );
    expect(describeOpenRouterError(e, { limit: null, limitRemaining: null, limitReset: null })).toMatch(/spending limit/i);
  });

  it("names the moderation provider and reasons, cut to 500 characters", () => {
    const e = new OpenRouterError(403, "http_403", "x", {
      provider_name: "OpenAI",
      reasons: ["violence", "self-harm"],
    });
    expect(describeOpenRouterError(e, null)).toMatch(/OpenAI.*violence, self-harm/);
    const long = new OpenRouterError(403, "http_403", "x", { reasons: ["r".repeat(2000)] });
    const text = describeOpenRouterError(long, null);
    expect(text).toMatch(/content moderation/);
    expect(text.length).toBeLessThan(700);
    expect(text).not.toMatch(/r{501}/);
  });

  it("does not call a 403 without moderation metadata moderation", () => {
    for (const metadata of [undefined, {}, { raw: "x" }]) {
      const text = describeOpenRouterError(new OpenRouterError(403, "http_403", "Key lacks permission", metadata), null);
      expect(text).toBe("OpenRouter error 403: Key lacks permission");
      expect(text).not.toMatch(/moderation/i);
    }
    const long = describeOpenRouterError(new OpenRouterError(403, "http_403", "p".repeat(2000)), null);
    expect(long).not.toMatch(/p{501}/);
  });

  it.each(["reasons", "flagged_input", "provider_name"])("treats a 403 with %s metadata as moderation", (k) => {
    const e = new OpenRouterError(403, "http_403", "x", { [k]: k === "flagged_input" ? "text" : ["a"] });
    expect(describeOpenRouterError(e, null)).toMatch(/content moderation/);
  });

  it("handles moderation metadata of the wrong shape", () => {
    const e = new OpenRouterError(403, "http_403", "x", { provider_name: 5, reasons: { a: 1 } });
    expect(describeOpenRouterError(e, null)).toMatch(/content moderation/);
  });

  it("claims no charge for the local timeout and says it may still be billed", () => {
    const text = describeOpenRouterError(new OpenRouterError(408, "timeout", "x"), null);
    expect(text).toMatch(/may still finish and be billed.*OpenRouter activity.*before retrying/i);
    expect(text).not.toMatch(/not charged/i);
  });

  it.each([408, 504, 524, 529])("describes upstream %i as retryable without a billing claim", (status) => {
    const text = describeOpenRouterError(new OpenRouterError(status, `http_${status}`, "x"), null);
    expect(text).toMatch(/failed or timed out/i);
    expect(text).toMatch(/retried/i);
    expect(text).not.toMatch(/charged|billed/i);
  });

  it("describes a network error as retryable without a billing claim", () => {
    const text = describeOpenRouterError(new OpenRouterError(502, "network_error", "x"), null);
    expect(text).toMatch(/could not reach OpenRouter/i);
    expect(text).toMatch(/retried/i);
    expect(text).not.toMatch(/charged|billed/i);
  });

  it("describes an unreadable response as not retryable and possibly billed", () => {
    const text = describeOpenRouterError(new OpenRouterError(200, "invalid_response", "x"), null);
    expect(text).toMatch(/unreadable/i);
    expect(text).toMatch(/not retryable/i);
    expect(text).toMatch(/may have been billed/i);
    expect(text).not.toMatch(/not charged/i);
  });

  it("describes an empty response and unsupported output", () => {
    expect(describeOpenRouterError(new OpenRouterError(200, "empty_response", "x"), null)).toMatch(/no image.*billed/i);
    const text = describeOpenRouterError(new OpenRouterError(200, "unsupported_output", "x"), null);
    expect(text).toMatch(/SVG/);
    expect(text).toMatch(/PNG, JPEG and WebP/);
  });

  it("cuts a passed-through message to 500 characters", () => {
    const text = describeOpenRouterError(new OpenRouterError(400, "http_400", "y".repeat(2000)), null);
    expect(text).not.toMatch(/y{501}/);
    expect(text.startsWith("OpenRouter error 400: ")).toBe(true);
  });
});
