// Fetches a user-supplied image URL without letting it reach the function's own network (ADR 0007).
//
// Vercel applies no outbound filtering, and the Lambda runtime API (127.0.0.1) and the cloud
// metadata service (169.254.169.254) are reachable from inside the function. So the URL is
// checked, its hostname is resolved here, every answer must be a public address, and the
// connection is then pinned to one of those validated addresses. Without pinning the HTTP client
// would resolve the name again and a hostile DNS server could answer differently the second time
// (DNS rebinding). Redirects are followed by hand so every hop goes through the same checks.
//
// Errors carry a short, generic message and no cause: resolved addresses, headers and bodies
// never leave this module, and it logs nothing.

import { promises as dns } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { MAX_IMAGE_BYTES, type ReadBudget } from "../images/limits.js";
import { sniffImage, type ImageInfo } from "../images/sniff.js";
import { isIpLiteral, isPublicIp, trimTrailingDots } from "./ip.js";

// Defined in a leaf module so the store can share the limit without importing this one.
export { MAX_IMAGE_BYTES };
export const MAX_IMAGE_SIDE = 8192;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type PublicFetchReason =
  | "invalid_url"
  | "blocked_host"
  | "dns_failed"
  | "too_many_redirects"
  | "http_error"
  | "too_large"
  | "timeout"
  | "not_image"
  | "too_many_pixels"
  | "over_budget";

const MESSAGES: Record<PublicFetchReason, string> = {
  invalid_url: "The image URL is not allowed.",
  blocked_host: "The image URL points to a host that is not allowed.",
  dns_failed: "The image host could not be resolved.",
  too_many_redirects: "The image URL redirected too many times.",
  http_error: "The image could not be downloaded.",
  too_large: "The image is larger than the 10 MiB limit.",
  timeout: "Downloading the image took too long.",
  not_image: "The URL did not return a PNG, JPEG or WebP image.",
  too_many_pixels: "The image is larger than 8192 pixels on a side.",
  over_budget: "The images together are larger than the total limit.",
};

export class PublicFetchError extends Error {
  readonly reason: PublicFetchReason;

  constructor(reason: PublicFetchReason) {
    super(MESSAGES[reason]);
    this.name = "PublicFetchError";
    this.reason = reason;
  }
}

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolve = (host: string) => Promise<PinnedAddress[]>;
export type HttpGet = (url: URL, pinned: PinnedAddress, signal: AbortSignal) => Promise<Response>;

const noop = (): void => {};

const defaultResolve: Resolve = async (host) => {
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/**
 * A `connect.lookup` that answers every hostname with the pinned address. The socket layer asks
 * for a list when `all` is set (Node's default happy-eyeballs path) and for a single address
 * otherwise; both shapes are covered. See node_modules/undici/lib/core/connect.js, where
 * the connect options, `lookup` included, are passed on to net.connect and tls.connect.
 */
export function pinnedLookup(pinned: PinnedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  };
}

/**
 * An undici Agent that can only connect to `pinned`. The URL keeps its real hostname, so the
 * Host header and the TLS server name (and therefore certificate verification) are unchanged.
 * HTTP/2 is off: image hosts all speak HTTP/1.1, and undici's graceful close has an open TODO
 * for flushing HTTP/2 streams.
 */
export function pinnedAgent(pinned: PinnedAddress): Agent {
  return new Agent({ allowH2: false, connect: { lookup: pinnedLookup(pinned) } });
}

/**
 * The real transport. Each hop gets its own Agent, closed as soon as the response headers are
 * in: Dispatcher.close() is graceful, it waits for the in-flight request (including its body)
 * to finish before tearing the sockets down, so the body can still be read afterwards while the
 * Agent, and the connection it pooled, cannot outlive the response on a warm instance.
 */
export const defaultHttpGet: HttpGet = async (url, pinned, signal) => {
  const agent = pinnedAgent(pinned);
  let response: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    response = await undiciFetch(url, { redirect: "manual", signal, dispatcher: agent });
  } catch (error) {
    agent.destroy().catch(noop);
    throw error;
  }
  agent.close().catch(noop);
  // undici's Response is the WHATWG Response; only the declared types differ.
  return response as unknown as Response;
};

/** Rejects when `signal` aborts, so an operation that ignores the signal cannot outlive the deadline. */
function abortable<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Releases the connection of a response whose body is not going to be read. */
function discard(response: Response): void {
  try {
    response.body?.cancel().catch(noop);
  } catch {
    // The body may already be locked or consumed; nothing is left to release.
  }
}

function parseUrl(input: string, base?: URL): URL {
  try {
    return new URL(input, base);
  } catch {
    throw new PublicFetchError("invalid_url");
  }
}

const MAX_HOSTNAME_LENGTH = 253;

function checkUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new PublicFetchError("invalid_url");
  if (url.username !== "" || url.password !== "") throw new PublicFetchError("invalid_url");
  // The URL parser drops a port that equals the scheme's default, so "" means 80 or 443.
  if (url.port !== "" && url.port !== "80" && url.port !== "443") throw new PublicFetchError("invalid_url");

  // DNS names are at most 253 characters, so a longer hostname cannot resolve. Checking first
  // keeps every later step bounded by a short string.
  if (url.hostname.length > MAX_HOSTNAME_LENGTH) throw new PublicFetchError("invalid_url");
  // "localhost." names the same host as "localhost", so trailing dots are ignored.
  const host = trimTrailingDots(url.hostname.toLowerCase());
  if (host === "") throw new PublicFetchError("invalid_url");
  if (isIpLiteral(host)) throw new PublicFetchError("blocked_host");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new PublicFetchError("blocked_host");
  }
}

const familyOf = (address: string): 4 | 6 => (address.includes(":") ? 6 : 4);

/**
 * Resolves `host` and returns the address to connect to. Every answer must be public: a name
 * that maps to a private address anywhere in its answer set is refused, not filtered, so a
 * mixed answer cannot be used to probe the internal network.
 */
async function resolvePinned(host: string, resolve: Resolve, signal: AbortSignal): Promise<PinnedAddress> {
  let answers: PinnedAddress[];
  try {
    answers = await abortable(signal, Promise.resolve().then(() => resolve(host)));
  } catch {
    throw new PublicFetchError("dns_failed");
  }
  if (!Array.isArray(answers) || answers.length === 0) throw new PublicFetchError("dns_failed");
  if (!answers.every((a) => typeof a?.address === "string" && isPublicIp(a.address))) throw new PublicFetchError("blocked_host");

  const addresses = answers.map((a) => a.address);
  const address = addresses.find((a) => familyOf(a) === 4) ?? addresses[0]!;
  return { address, family: familyOf(address) };
}

async function request(httpGet: HttpGet, url: URL, pinned: PinnedAddress, signal: AbortSignal): Promise<Response> {
  const pending = new Promise<Response>((resolve) => resolve(httpGet(url, pinned, signal)));
  // A response that arrives after the deadline would otherwise keep its connection open.
  pending.then((response) => {
    if (signal.aborted) discard(response);
  }, noop);
  try {
    return await abortable(signal, pending);
  } catch {
    throw new PublicFetchError("http_error");
  }
}

// A chunk is charged to the shared budget before it is kept, so downloads running in parallel
// stop as soon as together they pass the total instead of after each has read its own cap. The
// buffer sized from a declared Content-Length is charged before it is allocated: a server can
// declare 10 MiB and then stall, and sixteen of those would otherwise hold 160 MiB of buffers
// while the budget had seen almost nothing. A body shorter than declared keeps its prepayment
// charged; the budget is a pessimistic bound.
async function readBody(response: Response, signal: AbortSignal, budget?: ReadBudget): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  // An unusable header is ignored: the streaming count below is what enforces the limit.
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_IMAGE_BYTES) {
    discard(response);
    throw new PublicFetchError("too_large");
  }
  if (!response.body) return new Uint8Array(0);

  // The body is copied straight into one buffer. Keeping the chunks as they arrive would let a
  // server that sends one byte per write multiply the memory held for the same payload by the
  // per-chunk overhead (measured at over 200x with undici).
  const capacity = initialCapacity(declared);
  let charged = 0;
  if (budget && declared !== null && /^\d+$/.test(declared)) {
    if (!budget.take(capacity)) {
      discard(response);
      throw new PublicFetchError("over_budget");
    }
    charged = capacity;
  }
  let buffer = new Uint8Array(capacity);
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await abortable(signal, reader.read());
      if (done) break;
      if (total + value.byteLength > MAX_IMAGE_BYTES) throw new PublicFetchError("too_large");
      if (budget) {
        const extra = Math.max(0, total + value.byteLength - charged);
        if (!budget.take(extra)) throw new PublicFetchError("over_budget");
        charged += extra;
      }
      if (total + value.byteLength > buffer.byteLength) {
        const grown = new Uint8Array(Math.min(Math.max(buffer.byteLength * 2, total + value.byteLength), MAX_IMAGE_BYTES));
        grown.set(buffer.subarray(0, total));
        buffer = grown;
      }
      buffer.set(value, total);
      total += value.byteLength;
    }
  } catch (error) {
    if (error instanceof PublicFetchError) throw error;
    // The connection broke or the deadline passed (the caller reports the latter as a timeout).
    throw new PublicFetchError("http_error");
  } finally {
    // After a clean read this is a no-op; on every early exit it closes the connection.
    reader.cancel().catch(noop);
  }

  // Return a copy that owns exactly its bytes, so `.buffer` carries no unused capacity.
  return total === buffer.byteLength ? buffer : buffer.slice(0, total);
}

function initialCapacity(declared: string | null): number {
  if (declared !== null && /^\d+$/.test(declared)) return Math.max(1, Math.min(Number(declared), MAX_IMAGE_BYTES));
  return 64 * 1024;
}

async function fetchFollowingRedirects(
  input: string,
  resolve: Resolve,
  httpGet: HttpGet,
  signal: AbortSignal,
  budget?: ReadBudget,
): Promise<Uint8Array> {
  let url = parseUrl(input);
  for (let redirects = 0; ; redirects++) {
    checkUrl(url);
    const pinned = await resolvePinned(url.hostname, resolve, signal);
    const response = await request(httpGet, url, pinned, signal);

    if (REDIRECT_STATUSES.has(response.status)) {
      discard(response);
      if (redirects >= MAX_REDIRECTS) throw new PublicFetchError("too_many_redirects");
      const location = response.headers.get("location");
      if (!location) throw new PublicFetchError("http_error");
      url = parseUrl(location, url);
      continue;
    }
    if (response.status < 200 || response.status > 299) {
      discard(response);
      throw new PublicFetchError("http_error");
    }
    return readBody(response, signal, budget);
  }
}

/**
 * Downloads a public image. The format comes from the magic bytes only (ADR 0007): neither the
 * Content-Type nor the file extension is consulted. One deadline covers DNS, every hop and the
 * body. With a `budget`, the bytes read are charged to it, and a declared length is charged up
 * front, before its buffer is allocated. The download fails with `over_budget` once they no
 * longer fit.
 */
export async function fetchPublicImage(
  url: string,
  opts: { resolve?: Resolve; httpGet?: HttpGet; timeoutMs?: number; budget?: ReadBudget } = {},
): Promise<{ bytes: Uint8Array; info: ImageInfo }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? FETCH_TIMEOUT_MS);

  try {
    const bytes = await fetchFollowingRedirects(url, opts.resolve ?? defaultResolve, opts.httpGet ?? defaultHttpGet, controller.signal, opts.budget);
    const info = sniffImage(bytes);
    if (!info) throw new PublicFetchError("not_image");
    if (info.width > MAX_IMAGE_SIDE || info.height > MAX_IMAGE_SIDE) throw new PublicFetchError("too_many_pixels");
    return { bytes, info };
  } catch (error) {
    // Once the deadline has passed, whatever failed was cut short by it. Transport and body
    // failures are already mapped to PublicFetchError where they happen; anything else is a
    // programming error and propagates unchanged.
    if (timedOut) throw new PublicFetchError("timeout");
    throw error;
  } finally {
    clearTimeout(timer);
    // Releases anything still in flight on an unexpected exit path.
    controller.abort();
  }
}
