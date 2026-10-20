// OpenRouter image client: one synchronous POST /api/v1/images per generation or edit
// (https://openrouter.ai/docs/guides/overview/multimodal/image-generation), plus the key-limit
// lookup that makes spending-limit errors actionable.
//
// The call is paid, so every outcome becomes either a CreatedImage or an OpenRouterError that
// describeOpenRouterError can turn into an honest message. The API key goes only into the
// Authorization header. Errors carry OpenRouter's own message (cut to 500 characters) and never
// the request, the response body or the original transport error. This module logs nothing.

import type { Config } from "../config.js";
import { base64ToBytes } from "../images/base64.js";
import { sniffImage, type ImageInfo } from "../images/sniff.js";
import { IMAGE_PARAMS, type ImageParams } from "./models.js";
import {
  MAX_PASSTHROUGH,
  OpenRouterError,
  SERVER_ERROR_CODES,
  UNSUPPORTED_OUTPUT_MESSAGE,
  truncate,
  type KeyInfo,
} from "./errors.js";

export { OpenRouterError, describeOpenRouterError, type KeyInfo } from "./errors.js";

const API_BASE = "https://openrouter.ai/api/v1";
// Generation can take 94 s or more and there is no async mode; Vercel Hobby allows 300 s (ADR 0008).
const GENERATE_TIMEOUT_MS = 200_000;
const KEY_TIMEOUT_MS = 15_000;

export interface CreateImageRequest {
  model: string;
  prompt: string;
  params: ImageParams;
  /** Data URLs of reference images; empty for plain generation. */
  references: string[];
}

export interface CreatedImage {
  bytes: Uint8Array;
  info: ImageInfo;
  costUsd: number | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Runs one fetch and reads its whole body under a single deadline. A deadline hit surfaces as
 * `timeout`. A failure before any response is `network_error`. A body that breaks after a 2xx
 * is `response_interrupted`, because the provider had already accepted the request; after a
 * non-2xx the status alone is still usable, so the body is treated as empty.
 */
async function exchange(
  f: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; ok: boolean; text: string }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let res: Response;
    try {
      // Never follow a redirect with the Authorization header attached.
      res = await f(url, { ...init, redirect: "error", signal: controller.signal });
    } catch {
      if (timedOut) throw new OpenRouterError(408, "timeout", "OpenRouter call timed out");
      throw new OpenRouterError(502, "network_error", "OpenRouter could not be reached");
    }
    const ok = res.status >= 200 && res.status < 300;
    try {
      return { status: res.status, ok, text: await res.text() };
    } catch {
      if (timedOut) throw new OpenRouterError(408, "timeout", "OpenRouter call timed out");
      if (!ok) return { status: res.status, ok, text: "" };
      throw new OpenRouterError(res.status, "response_interrupted", "OpenRouter response was cut off");
    }
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Builds the error from an OpenRouter `error` object; `status` is the HTTP status it applies to. */
function fromErrorObject(status: number, err: Obj | undefined): OpenRouterError {
  // A string code that collides with one of the server's own would be mistaken for a local failure.
  const code =
    typeof err?.code === "string" && err.code !== "" && !SERVER_ERROR_CODES.has(err.code) ? err.code : `http_${status}`;
  const message = typeof err?.message === "string" && err.message !== "" ? err.message : `HTTP ${status}`;
  const metadata = isObj(err?.metadata) ? err.metadata : undefined;
  return new OpenRouterError(status, code, truncate(message, MAX_PASSTHROUGH), metadata);
}

function httpError(status: number, text: string): OpenRouterError {
  const body = parseJson(text);
  return fromErrorObject(status, isObj(body) && isObj(body.error) ? body.error : undefined);
}

// A generation that fails after the response started can arrive as HTTP 200 with an `error`
// object (https://openrouter.ai/docs/api/reference/errors-and-debugging). It is classified like
// any other error, using the status the error itself reports.
function inBodyError(httpStatus: number, err: Obj): OpenRouterError {
  const n = err.code;
  const status = typeof n === "number" && Number.isInteger(n) && n >= 100 && n <= 599 ? n : httpStatus;
  return fromErrorObject(status, err);
}

export async function createImage(
  cfg: Pick<Config, "openrouterApiKey" | "openrouterReferer">,
  req: CreateImageRequest,
  f: typeof fetch = globalThis.fetch,
  timeoutMs = GENERATE_TIMEOUT_MS,
): Promise<CreatedImage> {
  const body: Obj = { model: req.model, prompt: req.prompt };
  for (const name of IMAGE_PARAMS) {
    if (req.params[name] !== undefined) body[name] = req.params[name];
  }
  if (req.references.length > 0) {
    body.input_references = req.references.map((url) => ({ type: "image_url", image_url: { url } }));
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.openrouterApiKey}`,
    "Content-Type": "application/json",
    "X-OpenRouter-Title": "litho-mcp",
  };
  if (cfg.openrouterReferer !== "") headers["HTTP-Referer"] = cfg.openrouterReferer;

  const res = await exchange(f, `${API_BASE}/images`, { method: "POST", headers, body: JSON.stringify(body) }, timeoutMs);
  if (!res.ok) throw httpError(res.status, res.text);

  const parsed = parseJson(res.text);
  // Read before any failure below: a 2xx that then fails here was probably billed.
  const usage = isObj(parsed) ? parsed.usage : undefined;
  const rawCost = isObj(usage) ? usage.cost : undefined;
  const costUsd = typeof rawCost === "number" && Number.isFinite(rawCost) ? rawCost : null;
  const invalid = () =>
    new OpenRouterError(res.status, "invalid_response", "OpenRouter returned an unreadable response", undefined, costUsd);
  if (isObj(parsed) && isObj(parsed.error)) throw inBodyError(res.status, parsed.error);
  if (!isObj(parsed) || !Array.isArray(parsed.data)) throw invalid();
  if (parsed.data.length === 0) {
    throw new OpenRouterError(res.status, "empty_response", "OpenRouter returned no image", undefined, costUsd);
  }
  // Only the first image is used: the tools always ask for one.
  const first: unknown = parsed.data[0];
  if (!isObj(first) || typeof first.b64_json !== "string") throw invalid();

  const unsupported = () =>
    new OpenRouterError(res.status, "unsupported_output", UNSUPPORTED_OUTPUT_MESSAGE, undefined, costUsd);
  if (typeof first.media_type === "string" && first.media_type.trim().toLowerCase() === "image/svg+xml") {
    throw unsupported();
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(first.b64_json);
  } catch {
    throw invalid();
  }
  // The magic bytes decide, not media_type: a mislabelled or unknown format is rejected here
  // before anything is stored.
  const info = sniffImage(bytes);
  if (!info) throw unsupported();

  return { bytes, info, costUsd };
}

const nullableNumber = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));

/** Returns null on any failure: the limits only enrich an error message, they never gate a call. */
export async function getKeyInfo(
  cfg: Pick<Config, "openrouterApiKey">,
  f: typeof fetch = globalThis.fetch,
): Promise<KeyInfo | null> {
  try {
    const res = await exchange(
      f,
      `${API_BASE}/key`,
      { method: "GET", headers: { Authorization: `Bearer ${cfg.openrouterApiKey}` } },
      KEY_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const parsed = parseJson(res.text);
    const data = isObj(parsed) ? parsed.data : undefined;
    if (!isObj(data)) return null;
    const { limit, limit_remaining: limitRemaining, limit_reset: limitReset } = data;
    if (!nullableNumber(limit) || !nullableNumber(limitRemaining)) return null;
    if (limitReset !== null && typeof limitReset !== "string") return null;
    return { limit, limitRemaining, limitReset };
  } catch {
    return null;
  }
}
