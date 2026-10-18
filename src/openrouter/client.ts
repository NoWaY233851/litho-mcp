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
  UNSUPPORTED_OUTPUT_MESSAGE,
  truncate,
  type KeyInfo,
} from "./errors.js";

export { OpenRouterError, describeOpenRouterError, type KeyInfo } from "./errors.js";

const API_BASE = "https://openrouter.ai/api/v1";
// Generation can take 94 s or more and there is no async mode (spec 3.4); Vercel allows 300 s.
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
 * `timedOut`; any other transport failure is rethrown as `network`.
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
    // Never follow a redirect with the Authorization header attached.
    const res = await f(url, { ...init, redirect: "error", signal: controller.signal });
    const text = await res.text();
    return { status: res.status, ok: res.status >= 200 && res.status < 300, text };
  } catch {
    if (timedOut) throw new OpenRouterError(408, "timeout", "OpenRouter call timed out");
    throw new OpenRouterError(502, "network_error", "OpenRouter could not be reached");
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

function httpError(status: number, text: string): OpenRouterError {
  const body = parseJson(text);
  const err = isObj(body) && isObj(body.error) ? body.error : undefined;
  const code = typeof err?.code === "string" && err.code !== "" ? err.code : `http_${status}`;
  const message = typeof err?.message === "string" && err.message !== "" ? err.message : `HTTP ${status}`;
  const metadata = isObj(err?.metadata) ? err.metadata : undefined;
  return new OpenRouterError(status, code, truncate(message, MAX_PASSTHROUGH), metadata);
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

  const invalid = () => new OpenRouterError(res.status, "invalid_response", "OpenRouter returned an unreadable response");
  const parsed = parseJson(res.text);
  if (!isObj(parsed) || !Array.isArray(parsed.data)) throw invalid();
  if (parsed.data.length === 0) {
    throw new OpenRouterError(res.status, "empty_response", "OpenRouter returned no image");
  }
  // Only the first image is used: the tools always ask for one.
  const first: unknown = parsed.data[0];
  if (!isObj(first) || typeof first.b64_json !== "string") throw invalid();

  const unsupported = () => new OpenRouterError(res.status, "unsupported_output", UNSUPPORTED_OUTPUT_MESSAGE);
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

  const cost = isObj(parsed.usage) ? parsed.usage.cost : undefined;
  return { bytes, info, costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null };
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
