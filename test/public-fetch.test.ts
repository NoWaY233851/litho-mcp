import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultHttpGet,
  fetchPublicImage,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIDE,
  pinnedAgent,
  pinnedLookup,
  PublicFetchError,
  type HttpGet,
  type Resolve,
} from "../src/net/public-fetch.js";
import { readBudget } from "../src/images/limits.js";

const bytes = (...parts: Array<number | number[] | Uint8Array>): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === "number" ? [p] : Array.from(p))));
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

// A PNG signature plus IHDR: all the sniffer reads.
const png = (w: number, h: number): Uint8Array =>
  bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), ascii("IHDR"), be32(w), be32(h), [8, 2, 0, 0, 0], be32(0));

const V4 = { address: "93.184.216.34", family: 4 } as const;
const V6 = { address: "2606:4700:4700::1111", family: 6 } as const;

const resolveAll = (...answers: Array<{ address: string; family: 4 | 6 }>): Resolve => async () => answers;

interface Calls {
  resolved: string[];
  fetched: Array<{ href: string; pinned: { address: string; family: 4 | 6 } }>;
}

/** An httpGet that serves `routes` by href and records what it was asked for. */
function scripted(routes: Record<string, () => Response>): { httpGet: HttpGet; calls: Calls; resolve: Resolve } {
  const calls: Calls = { resolved: [], fetched: [] };
  const httpGet: HttpGet = async (url, pinned) => {
    calls.fetched.push({ href: url.href, pinned });
    const route = routes[url.href];
    if (!route) throw new Error(`unexpected request ${url.href}`);
    return route();
  };
  const resolve: Resolve = async (host) => {
    calls.resolved.push(host);
    return [V4];
  };
  return { httpGet, calls, resolve };
}

const ok = (body: Uint8Array, headers: Record<string, string> = {}): Response =>
  new Response(body as BodyInit, { status: 200, headers });
const redirect = (location: string | null, status = 302): Response =>
  new Response(null, { status, headers: location === null ? {} : { location } });

const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof PublicFetchError) return e.reason;
    throw e;
  }
  return "no error";
};

/** A stream of `count` chunks that records how many were pulled and whether it was cancelled. */
function countingStream(count: number, chunkSize: number): { body: ReadableStream<Uint8Array>; state: { pulled: number; cancelled: boolean } } {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= count) return controller.close();
      state.pulled++;
      controller.enqueue(new Uint8Array(chunkSize));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

describe("fetchPublicImage: URL checks", () => {
  const cases: Array<[string, string]> = [
    ["ftp://example.com/a.png", "invalid_url"],
    ["file:///etc/passwd", "invalid_url"],
    ["javascript:alert(1)", "invalid_url"],
    ["not a url", "invalid_url"],
    ["", "invalid_url"],
    ["http://user:pw@example.com/a.png", "invalid_url"],
    ["https://user@example.com/a.png", "invalid_url"],
    ["http://example.com:8080/a.png", "invalid_url"],
    ["https://example.com:22/a.png", "invalid_url"],
    ["http://127.0.0.1/a.png", "blocked_host"],
    ["http://0x7f.1/a.png", "blocked_host"],
    ["http://2130706433/a.png", "blocked_host"],
    ["http://017700000001/a.png", "blocked_host"],
    ["http://[::1]/a.png", "blocked_host"],
    ["http://[::ffff:7f00:1]/a.png", "blocked_host"],
    ["http://169.254.169.254/latest/meta-data", "blocked_host"],
    ["http://93.184.216.34/a.png", "blocked_host"],
    ["http://localhost/a.png", "blocked_host"],
    ["http://LOCALHOST/a.png", "blocked_host"],
    ["http://localhost./a.png", "blocked_host"],
    ["http://app.localhost/a.png", "blocked_host"],
    ["http://printer.local/a.png", "blocked_host"],
    ["http://printer.local./a.png", "blocked_host"],
    ["http://db.internal/a.png", "blocked_host"],
    ["http://db.internal./a.png", "blocked_host"],
  ];

  it.each(cases)("%j is rejected as %s without resolving or connecting", async (url, reason) => {
    const s = scripted({});
    expect(await reasonOf(fetchPublicImage(url, { resolve: s.resolve, httpGet: s.httpGet }))).toBe(reason);
    expect(s.calls.resolved).toEqual([]);
    expect(s.calls.fetched).toEqual([]);
  });

  it("rejects a 100k-dot hostname as invalid_url without stalling the event loop", async () => {
    const s = scripted({});
    for (const tail of ["a", ""]) {
      const url = `http://${".".repeat(100_000)}${tail}/a.png`;
      const started = performance.now();
      const reason = await reasonOf(fetchPublicImage(url, { resolve: s.resolve, httpGet: s.httpGet }));
      expect(performance.now() - started).toBeLessThan(50);
      expect(reason).toBe("invalid_url");
    }
    expect(s.calls.resolved).toEqual([]);
  });

  it("rejects a hostname over 253 characters and accepts one of exactly 253", async () => {
    const label = "a".repeat(63);
    const long = `${label}.${label}.${label}.${"a".repeat(58)}.com`; // 254 characters
    expect(long.length).toBe(254);
    const s = scripted({});
    expect(await reasonOf(fetchPublicImage(`http://${long}/a.png`, { resolve: s.resolve, httpGet: s.httpGet }))).toBe("invalid_url");
    const edge = long.slice(1);
    s.httpGet = async () => ok(png(2, 2));
    const result = await fetchPublicImage(`http://${edge}/a.png`, { resolve: s.resolve, httpGet: s.httpGet });
    expect(result.info.width).toBe(2);
  });

  it.each(["http://example.com/a.png", "http://example.com:80/a.png", "https://example.com:443/a.png", "http://example.com:443/a.png", "https://example.com:80/a.png", "http://example.com./a.png"])(
    "%j passes the URL checks",
    async (url) => {
      const s = scripted({});
      s.httpGet = async () => ok(png(2, 2));
      const result = await fetchPublicImage(url, { resolve: s.resolve, httpGet: s.httpGet });
      expect(result.info).toEqual({ mime: "image/png", width: 2, height: 2 });
    },
  );
});

describe("fetchPublicImage: DNS and pinning", () => {
  it("rejects when any resolved address is non-public (mixed answers)", async () => {
    const s = scripted({});
    const resolve = resolveAll(V4, { address: "10.0.0.5", family: 4 });
    expect(await reasonOf(fetchPublicImage("https://example.com/a.png", { resolve, httpGet: s.httpGet }))).toBe("blocked_host");
    expect(s.calls.fetched).toEqual([]);
  });

  it("rejects an answer that is not an address at all", async () => {
    const s = scripted({});
    const resolve = resolveAll({ address: "not-an-ip", family: 4 });
    expect(await reasonOf(fetchPublicImage("https://example.com/a.png", { resolve, httpGet: s.httpGet }))).toBe("blocked_host");
  });

  it("reports dns_failed when resolution fails or returns nothing", async () => {
    const s = scripted({});
    const failing: Resolve = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND secret-host.example"), { code: "ENOTFOUND" });
    };
    expect(await reasonOf(fetchPublicImage("https://example.com/a.png", { resolve: failing, httpGet: s.httpGet }))).toBe("dns_failed");
    expect(await reasonOf(fetchPublicImage("https://example.com/a.png", { resolve: resolveAll(), httpGet: s.httpGet }))).toBe("dns_failed");
    expect(s.calls.fetched).toEqual([]);
  });

  it("hands httpGet the validated address and the original URL (pinning)", async () => {
    const s = scripted({ "https://example.com/a.png": () => ok(png(1, 1)) });
    await fetchPublicImage("https://example.com/a.png", { resolve: resolveAll(V4), httpGet: s.httpGet });
    expect(s.calls.fetched).toEqual([{ href: "https://example.com/a.png", pinned: { address: V4.address, family: 4 } }]);
  });

  it("prefers the first IPv4 answer, otherwise the first answer", async () => {
    const s = scripted({ "https://example.com/a.png": () => ok(png(1, 1)) });
    await fetchPublicImage("https://example.com/a.png", { resolve: resolveAll(V6, V4), httpGet: s.httpGet });
    await fetchPublicImage("https://example.com/a.png", { resolve: resolveAll(V6), httpGet: s.httpGet });
    expect(s.calls.fetched.map((c) => c.pinned)).toEqual([{ address: V4.address, family: 4 }, { address: V6.address, family: 6 }]);
  });
});

describe("pinnedLookup and pinnedAgent", () => {
  it("answers every hostname with the pinned address, in the all:true shape", () => {
    const lookup = pinnedLookup({ address: "93.184.216.34", family: 4 });
    let seen: unknown;
    lookup("other-host.example", { all: true }, (err, addresses) => {
      expect(err).toBeNull();
      seen = addresses;
    });
    expect(seen).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("answers in the single-address shape when all is not requested", () => {
    const lookup = pinnedLookup({ address: "2606:4700:4700::1111", family: 6 });
    let seen: unknown[] = [];
    lookup("other-host.example", {}, (err, address, family) => {
      expect(err).toBeNull();
      seen = [address, family];
    });
    expect(seen).toEqual(["2606:4700:4700::1111", 6]);
  });

  it("builds an undici Agent", async () => {
    const agent = pinnedAgent({ address: "93.184.216.34", family: 4 });
    expect(agent).toBeInstanceOf(Agent);
    await agent.close();
  });
});

describe("fetchPublicImage: redirects", () => {
  it("follows up to 3 redirects, resolving and pinning each hop", async () => {
    const s = scripted({
      "http://a.example.com/1": () => redirect("http://b.example.com/2"),
      "http://b.example.com/2": () => redirect("/3", 301),
      "http://b.example.com/3": () => redirect("https://c.example.com/4", 307),
      "https://c.example.com/4": () => ok(png(5, 6)),
    });
    const result = await fetchPublicImage("http://a.example.com/1", { resolve: s.resolve, httpGet: s.httpGet });
    expect(result.info).toEqual({ mime: "image/png", width: 5, height: 6 });
    expect(s.calls.resolved).toEqual(["a.example.com", "b.example.com", "b.example.com", "c.example.com"]);
    expect(s.calls.fetched.map((c) => c.href)).toEqual([
      "http://a.example.com/1",
      "http://b.example.com/2",
      "http://b.example.com/3",
      "https://c.example.com/4",
    ]);
  });

  it("fails with too_many_redirects on the 4th redirect response", async () => {
    const s = scripted({
      "http://a.example.com/1": () => redirect("/2"),
      "http://a.example.com/2": () => redirect("/3"),
      "http://a.example.com/3": () => redirect("/4"),
      "http://a.example.com/4": () => redirect("/5"),
      "http://a.example.com/5": () => ok(png(1, 1)),
    });
    expect(await reasonOf(fetchPublicImage("http://a.example.com/1", { resolve: s.resolve, httpGet: s.httpGet }))).toBe("too_many_redirects");
    expect(s.calls.fetched).toHaveLength(4);
  });

  it.each([301, 302, 303, 307, 308])("treats %i as a redirect", async (status) => {
    const s = scripted({
      "http://a.example.com/1": () => redirect("/2", status),
      "http://a.example.com/2": () => ok(png(1, 1)),
    });
    await fetchPublicImage("http://a.example.com/1", { resolve: s.resolve, httpGet: s.httpGet });
    expect(s.calls.fetched).toHaveLength(2);
  });

  it("blocks a hop to the cloud metadata address without connecting", async () => {
    const s = scripted({ "http://a.example.com/1": () => redirect("http://169.254.169.254/latest/meta-data") });
    expect(await reasonOf(fetchPublicImage("http://a.example.com/1", { resolve: s.resolve, httpGet: s.httpGet }))).toBe("blocked_host");
    expect(s.calls.fetched).toHaveLength(1);
  });

  it("blocks a hop whose hostname resolves to a private address", async () => {
    const s = scripted({ "http://a.example.com/1": () => redirect("http://rebind.example.com/x") });
    const resolve: Resolve = async (host) => (host === "rebind.example.com" ? [{ address: "127.0.0.1", family: 4 }] : [V4]);
    expect(await reasonOf(fetchPublicImage("http://a.example.com/1", { resolve, httpGet: s.httpGet }))).toBe("blocked_host");
    expect(s.calls.fetched).toHaveLength(1);
  });

  it("re-applies the URL checks to the redirect target", async () => {
    for (const [location, reason] of [
      ["ftp://example.com/x", "invalid_url"],
      ["http://example.com:8080/x", "invalid_url"],
      ["http://localhost/x", "blocked_host"],
      ["http://user:pw@example.com/x", "invalid_url"],
    ] as const) {
      const s = scripted({ "http://a.example.com/1": () => redirect(location) });
      expect(await reasonOf(fetchPublicImage("http://a.example.com/1", { resolve: s.resolve, httpGet: s.httpGet }))).toBe(reason);
      expect(s.calls.fetched).toHaveLength(1);
    }
  });

  it("fails with http_error when a redirect has no Location, and invalid_url when it cannot be parsed", async () => {
    const missing = scripted({ "http://a.example.com/1": () => redirect(null) });
    expect(await reasonOf(fetchPublicImage("http://a.example.com/1", { resolve: missing.resolve, httpGet: missing.httpGet }))).toBe("http_error");
    const garbage = scripted({ "http://a.example.com/1": () => redirect("http://[") });
    expect(await reasonOf(fetchPublicImage("http://a.example.com/1", { resolve: garbage.resolve, httpGet: garbage.httpGet }))).toBe("invalid_url");
  });

  it("cancels the body of every redirect response before the next hop", async () => {
    const cancelled: string[] = [];
    const redirectWithBody = (location: string, tag: string): Response =>
      new Response(new ReadableStream({ cancel: () => void cancelled.push(tag) }), { status: 302, headers: { location } });
    const s = scripted({
      "http://a.example.com/1": () => redirectWithBody("/2", "first"),
      "http://a.example.com/2": () => {
        expect(cancelled).toEqual(["first"]);
        return ok(png(1, 1));
      },
    });
    await fetchPublicImage("http://a.example.com/1", { resolve: s.resolve, httpGet: s.httpGet });
    expect(cancelled).toEqual(["first"]);
  });
});

describe("fetchPublicImage: response handling", () => {
  const get = (response: () => Response): Promise<unknown> => {
    const s = scripted({ "https://example.com/a.png": response });
    return fetchPublicImage("https://example.com/a.png", { resolve: s.resolve, httpGet: s.httpGet });
  };

  it("returns the bytes and the sniffed info", async () => {
    const image = png(30, 20);
    const result = (await get(() => ok(image))) as { bytes: Uint8Array; info: unknown };
    expect(Array.from(result.bytes)).toEqual(Array.from(image));
    expect(result.info).toEqual({ mime: "image/png", width: 30, height: 20 });
  });

  it("rejects an oversized Content-Length without reading the body", async () => {
    const { body, state } = countingStream(3, 1024);
    const response = () => new Response(body, { status: 200, headers: { "content-length": String(MAX_IMAGE_BYTES + 1) } });
    expect(await reasonOf(get(response))).toBe("too_large");
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(1);
  });

  it("counts bytes while streaming and cancels the reader past the limit", async () => {
    const { body, state } = countingStream(40, 1024 * 1024);
    expect(await reasonOf(get(() => new Response(body, { status: 200 })))).toBe("too_large");
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(40);
  });

  it("a download stops once its chunks pass the budget", async () => {
    const { body, state } = countingStream(8, 512 * 1024);
    const s = scripted({ "https://example.com/a.png": () => new Response(body, { status: 200 }) });
    const reason = await reasonOf(
      fetchPublicImage("https://example.com/a.png", { resolve: s.resolve, httpGet: s.httpGet, budget: readBudget(1024 * 1024) }),
    );
    expect(reason).toBe("over_budget");
    expect(state.cancelled).toBe(true);
    // Two chunks fit and the third is refused; the stream is always one chunk ahead of the reader.
    expect(state.pulled).toBeLessThanOrEqual(4);
  });

  it("charges the buffer sized from a declared length before reading, so a stalled download cannot hide it", async () => {
    const budget = readBudget(40 * 1024 * 1024);
    const declared = { "content-length": String(MAX_IMAGE_BYTES) };
    const fetchWith = (body: ReadableStream<Uint8Array>): Promise<string> => {
      const s = scripted({ "https://example.com/a.png": () => new Response(body, { status: 200, headers: declared }) });
      return reasonOf(fetchPublicImage("https://example.com/a.png", { resolve: s.resolve, httpGet: s.httpGet, budget }));
    };
    // Each of the first four declares 10 MiB and ends at once; the prepayment stays charged.
    for (let i = 0; i < 4; i++) expect(await fetchWith(countingStream(0, 1).body)).toBe("not_image");
    const fifth = countingStream(3, 1024);
    expect(await fetchWith(fifth.body)).toBe("over_budget");
    // A stream pulls its first chunk when it is created; nothing is read from it after that.
    expect(fifth.state.pulled).toBeLessThanOrEqual(1);
    expect(fifth.state.cancelled).toBe(true);
  });

  it("refuses a declared length larger than what the budget has left before reading", async () => {
    const { body, state } = countingStream(3, 1024);
    const s = scripted({
      "https://example.com/a.png": () => new Response(body, { status: 200, headers: { "content-length": "2048" } }),
    });
    const reason = await reasonOf(
      fetchPublicImage("https://example.com/a.png", { resolve: s.resolve, httpGet: s.httpGet, budget: readBudget(1024) }),
    );
    expect(reason).toBe("over_budget");
    expect(state.pulled).toBeLessThanOrEqual(1);
    expect(state.cancelled).toBe(true);
  });

  it("does not trust a Content-Length that understates the body", async () => {
    const { body } = countingStream(12, 1024 * 1024);
    expect(await reasonOf(get(() => new Response(body, { status: 200, headers: { "content-length": "10" } })))).toBe("too_large");
  });

  it("grows its buffer for bodies larger than the initial capacity and returns exact bytes", async () => {
    const image = bytes(png(11, 12), Uint8Array.from({ length: 300_001 }, (_, i) => i % 251));
    const chunked = (): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < image.byteLength; i += 1000) controller.enqueue(image.slice(i, i + 1000));
            controller.close();
          },
        }),
        { status: 200 },
      );
    for (const headers of [undefined, { "content-length": "5" }]) {
      const body = headers ? new Response(chunked().body, { status: 200, headers }) : chunked();
      const result = (await get(() => body)) as { bytes: Uint8Array };
      expect(result.bytes).toEqual(image);
      expect(result.bytes.buffer.byteLength).toBe(image.byteLength);
    }
  });

  it("accepts a body of exactly the limit", async () => {
    const image = new Uint8Array(MAX_IMAGE_BYTES);
    image.set(png(2, 2));
    const result = (await get(() => ok(image))) as { bytes: Uint8Array };
    expect(result.bytes.byteLength).toBe(MAX_IMAGE_BYTES);
  });

  it.each(["abc", "-5", "1.5", "1e3", " "])("ignores an unusable Content-Length (%j) and relies on the streaming count", async (value) => {
    expect(await reasonOf(get(() => ok(png(2, 2), { "content-length": value })))).toBe("no error");
  });

  it("rejects a Content-Length too large for a safe integer", async () => {
    expect(await reasonOf(get(() => ok(png(2, 2), { "content-length": "99999999999999999999999" })))).toBe("too_large");
  });

  it("decides on magic bytes and ignores Content-Type", async () => {
    expect(await reasonOf(get(() => ok(bytes(ascii("<html></html>")), { "content-type": "image/png" })))).toBe("not_image");
    const result = (await get(() => ok(png(3, 3), { "content-type": "text/html" }))) as { info: { mime: string } };
    expect(result.info.mime).toBe("image/png");
  });

  it("rejects an empty body as not_image", async () => {
    expect(await reasonOf(get(() => new Response(null, { status: 200 })))).toBe("not_image");
  });

  it("allows a side of exactly 8192 and rejects 8193", async () => {
    expect(MAX_IMAGE_SIDE).toBe(8192);
    expect(await reasonOf(get(() => ok(png(8192, 8192))))).toBe("no error");
    expect(await reasonOf(get(() => ok(png(8193, 10))))).toBe("too_many_pixels");
    expect(await reasonOf(get(() => ok(png(10, 8193))))).toBe("too_many_pixels");
  });

  it.each([400, 403, 404, 429, 500, 503])("maps status %i to http_error and cancels the body", async (status) => {
    const { body, state } = countingStream(3, 10);
    expect(await reasonOf(get(() => new Response(body, { status })))).toBe("http_error");
    expect(state.cancelled).toBe(true);
  });

  it("maps a failing httpGet to http_error without leaking details", async () => {
    const httpGet: HttpGet = async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 93.184.216.34:443"), { code: "ECONNREFUSED" });
    };
    const error = await fetchPublicImage("https://example.com/a.png", { resolve: resolveAll(V4), httpGet }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublicFetchError);
    const failure = error as PublicFetchError;
    expect(failure.reason).toBe("http_error");
    expect(failure.message).not.toMatch(/93\.184|ECONN|example\.com/);
    expect(failure.cause).toBeUndefined();
    expect(failure.name).toBe("PublicFetchError");
  });
});

describe("fetchPublicImage: error mapping", () => {
  it("maps a body that fails mid-stream to http_error", async () => {
    const httpGet: HttpGet = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(png(2, 2));
            controller.error(new Error("connection reset by 93.184.216.34"));
          },
        }),
        { status: 200 },
      );
    const error = await fetchPublicImage("https://example.com/a.png", { resolve: resolveAll(V4), httpGet }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublicFetchError);
    expect((error as PublicFetchError).reason).toBe("http_error");
    expect((error as PublicFetchError).message).not.toContain("93.184");
    expect((error as PublicFetchError).cause).toBeUndefined();
  });

  it("lets an unexpected exception propagate instead of masking it", async () => {
    const httpGet: HttpGet = async () =>
      ({
        get status(): number {
          throw new TypeError("programming error");
        },
      }) as unknown as Response;
    await expect(fetchPublicImage("https://example.com/a.png", { resolve: resolveAll(V4), httpGet })).rejects.toThrow(TypeError);
  });
});

describe("fetchPublicImage: timeout", () => {
  const never = <T>(): Promise<T> => new Promise<T>(() => {});

  it("covers a DNS lookup that never answers", async () => {
    const s = scripted({});
    expect(await reasonOf(fetchPublicImage("https://example.com/a.png", { resolve: never, httpGet: s.httpGet, timeoutMs: 30 }))).toBe("timeout");
  });

  it("covers a request that never answers, even if httpGet ignores the signal", async () => {
    expect(await reasonOf(fetchPublicImage("https://example.com/a.png", { resolve: resolveAll(V4), httpGet: () => never(), timeoutMs: 30 }))).toBe("timeout");
  });

  it("covers a body that stalls, and aborts the signal handed to httpGet", async () => {
    let signal: AbortSignal | undefined;
    const httpGet: HttpGet = async (_url, _pinned, s) => {
      signal = s;
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    };
    expect(await reasonOf(fetchPublicImage("https://example.com/a.png", { resolve: resolveAll(V4), httpGet, timeoutMs: 30 }))).toBe("timeout");
    expect(signal?.aborted).toBe(true);
  });

  it("shares one budget across redirect hops", async () => {
    const httpGet: HttpGet = async (url) => {
      await new Promise((r) => setTimeout(r, 25));
      return url.pathname === "/end" ? ok(png(1, 1)) : redirect(`/${url.pathname.length}x`);
    };
    expect(await reasonOf(fetchPublicImage("https://example.com/a", { resolve: resolveAll(V4), httpGet, timeoutMs: 60 }))).toBe("timeout");
  });

  it("clears its timer after success and after failure", async () => {
    vi.useFakeTimers();
    try {
      const s = scripted({ "https://example.com/a.png": () => ok(png(1, 1)) });
      await fetchPublicImage("https://example.com/a.png", { resolve: s.resolve, httpGet: s.httpGet });
      expect(vi.getTimerCount()).toBe(0);
      await expect(fetchPublicImage("https://example.com/missing", { resolve: s.resolve, httpGet: s.httpGet })).rejects.toBeInstanceOf(Error);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The remaining tests drive the real undici stack against a loopback server. Loopback is the
// only reachable destination without network access, and it is exactly what the pinned
// address stands in for here: the hostnames below can never resolve.
describe("default httpGet (real undici, loopback only)", () => {
  let server: Server | undefined;
  afterEach(async () => {
    const s = server;
    server = undefined;
    if (s) {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  const listen = async (handler: Parameters<typeof createServer>[1]): Promise<number> => {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  };

  it("connects to the pinned address whatever the URL's hostname says", async () => {
    let headers: IncomingHttpHeaders = {};
    const port = await listen((req, res) => {
      headers = req.headers;
      res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from(png(7, 9)));
    });
    const response = await defaultHttpGet(
      new URL(`http://pinned.example.test:${port}/img.png`),
      { address: "127.0.0.1", family: 4 },
      AbortSignal.timeout(5000),
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png(7, 9));
    expect(headers.host).toBe(`pinned.example.test:${port}`);
  });

  it("returns a redirect to the caller instead of following it", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
    });
    const response = await defaultHttpGet(
      new URL(`http://pinned.example.test:${port}/`),
      { address: "127.0.0.1", family: 4 },
      AbortSignal.timeout(5000),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://169.254.169.254/latest/meta-data");
    await response.body?.cancel();
  });

  it("does not truncate a body that is still arriving when the agent is closed", async () => {
    const payload = Buffer.alloc(64 * 1024, 7);
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-length": String(payload.length) });
      res.write(payload.subarray(0, 1024));
      setTimeout(() => res.end(payload.subarray(1024)), 150);
    });
    const response = await defaultHttpGet(
      new URL(`http://pinned.example.test:${port}/slow`),
      { address: "127.0.0.1", family: 4 },
      AbortSignal.timeout(5000),
    );
    expect((await response.arrayBuffer()).byteLength).toBe(payload.length);
  });

  it("closes the connection once the response has been read", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-length": "2" }).end("ok");
    });
    const closed = new Promise<void>((resolve) => {
      server!.on("connection", (socket) => socket.on("close", () => resolve()));
    });
    const response = await defaultHttpGet(
      new URL(`http://pinned.example.test:${port}/`),
      { address: "127.0.0.1", family: 4 },
      AbortSignal.timeout(5000),
    );
    await response.arrayBuffer();
    // The keep-alive socket would otherwise stay open on the idle Agent.
    await expect(Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("socket still open")), 2000))])).resolves.toBeUndefined();
  });

  // fetchPublicImage only talks to ports 80 and 443, so these route its requests to the loopback
  // server through the real default transport.
  const viaLoopback = (port: number): HttpGet => (url, _pinned, signal) =>
    defaultHttpGet(new URL(`http://pinned.example.test:${port}${url.pathname}`), { address: "127.0.0.1", family: 4 }, signal);

  it("reassembles a body sent as many one-byte writes into exactly its own bytes", async () => {
    const image = bytes(png(7, 9), new Uint8Array(3000));
    const port = await listen((req, res) => {
      req.socket.setNoDelay(true);
      res.writeHead(200);
      for (const byte of image) res.write(Uint8Array.of(byte));
      res.end();
    });
    const result = await fetchPublicImage("http://example.com/tiny-writes.png", { resolve: resolveAll(V4), httpGet: viaLoopback(port) });
    expect(result.bytes).toEqual(image);
    expect(result.bytes.buffer.byteLength).toBe(image.byteLength);
    expect(result.info).toEqual({ mime: "image/png", width: 7, height: 9 });
  });

  it("rejects a gzip body that expands past the limit as too_large", async () => {
    const compressed = gzipSync(Buffer.alloc(MAX_IMAGE_BYTES + 1024 * 1024));
    expect(compressed.byteLength).toBeLessThan(64 * 1024);
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip", "content-length": String(compressed.byteLength) }).end(compressed);
    });
    expect(await reasonOf(fetchPublicImage("http://example.com/bomb.png", { resolve: resolveAll(V4), httpGet: viaLoopback(port) }))).toBe("too_large");
  });

  it("stops promptly when the signal aborts mid-body", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200);
      res.write("partial");
    });
    const controller = new AbortController();
    const response = await defaultHttpGet(new URL(`http://pinned.example.test:${port}/hang`), { address: "127.0.0.1", family: 4 }, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it("fails fast when nothing listens at the pinned address", async () => {
    const port = await listen((_req, res) => res.end());
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await expect(
      defaultHttpGet(new URL(`http://pinned.example.test:${port}/`), { address: "127.0.0.1", family: 4 }, AbortSignal.timeout(5000)),
    ).rejects.toThrow();
  });
});
