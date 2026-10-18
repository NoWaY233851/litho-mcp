// OpenRouter failures and the short, honest messages Claude sees for them (ADR 0003).
//
// Billing claims are made only where OpenRouter documents them. Its image guide states that a
// failed generation returns 502 and is not billed (https://openrouter.ai/docs/guides/overview/multimodal/image-generation);
// it says nothing about 408, 504, 524, 529 or a client-side timeout, so those messages say the
// call failed and can be retried without promising anything about the charge.
//
// Text that comes from OpenRouter is cut to MAX_PASSTHROUGH characters. Nothing here logs, and
// no message includes a header, a request body or the API key.

export interface KeyInfo {
  limit: number | null;
  limitRemaining: number | null;
  limitReset: string | null;
}

// Upstream metadata is kept only for the keys this module reads. Content-policy errors carry
// `raw` (provider output, which can echo the prompt) and other fields we never need, so they are
// dropped at construction rather than carried around.
const METADATA_KEYS = ["limit_source", "limit_usd", "provider_name", "reasons", "flagged_input"] as const;

function pickMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const kept: Record<string, unknown> = {};
  for (const k of METADATA_KEYS) if (k in metadata) kept[k] = metadata[k];
  return kept;
}

/**
 * Callers must show `describeOpenRouterError(e, key)` and never branch on `status` alone: some
 * codes reuse a status with different billing semantics. `network_error` is status 502 but, unlike
 * a real 502, says nothing about whether the call was charged.
 */
export class OpenRouterError extends Error {
  readonly metadata?: Record<string, unknown>;

  constructor(
    readonly status: number,
    // Always a string: the error body's code when it is a non-empty string, otherwise
    // "http_<status>", or one of the codes this module raises itself (timeout, network_error,
    // response_interrupted, invalid_response, empty_response, unsupported_output).
    readonly code: string,
    message: string,
    metadata?: Record<string, unknown>,
    // The cost OpenRouter reported on a 2xx that then failed locally. A 2xx means the provider
    // accepted the request, and OpenRouter bills a generation all or nothing.
    readonly costUsd: number | null = null,
  ) {
    super(message);
    this.name = "OpenRouterError";
    this.metadata = pickMetadata(metadata);
  }
}

export const MAX_PASSTHROUGH = 500;

/** At most `max` UTF-16 units including the ellipsis, never splitting a surrogate pair. */
export function truncate(text: string, max = MAX_PASSTHROUGH): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

export const UNSUPPORTED_OUTPUT_MESSAGE =
  "The model returned an image format that can't be used (for example SVG). Only PNG, JPEG and WebP are supported.";

const LIMIT_SOURCES = new Set(["openrouter_credits", "openrouter_key_limit", "openrouter_in_flight_budget"]);

/** True for errors that /api/v1/key can explain (spending limits); callers fetch the key only then. */
export function isLimitError(e: OpenRouterError): boolean {
  if (e.status === 402) return true;
  if (e.status !== 403) return false;
  const m = e.metadata;
  if (!m) return false;
  return (typeof m.limit_source === "string" && LIMIT_SOURCES.has(m.limit_source)) || "limit_usd" in m;
}

// Only a 403 that carries moderation details is a refusal. Other 403s (permissions, guardrail
// blocks) are not about the content, so they are passed through instead of mislabelled.
const MODERATION_KEYS = ["reasons", "flagged_input", "provider_name"];
const isModeration = (e: OpenRouterError): boolean => !!e.metadata && MODERATION_KEYS.some((k) => k in e.metadata!);

const money = (n: number): string => `$${Number(n.toFixed(2))}`;

// Sub-cent costs are common for cheap models, so keep four decimals here.
const reported = (cost: number | null): string =>
  cost === null ? "" : ` (reported cost $${Number(cost.toFixed(4))})`;

function describeLimit(key: KeyInfo | null): string {
  const parts: string[] = [];
  if (key?.limit != null) parts.push(`limit ${money(key.limit)}`);
  if (key?.limitRemaining != null) parts.push(`remaining ${money(key.limitRemaining)}`);
  if (key?.limitReset) parts.push(`resets ${truncate(key.limitReset, 50)}`);
  const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `OpenRouter spending limit reached${detail}. Raise the limit or add credits on OpenRouter, then try again.`;
}

function describeModeration(e: OpenRouterError): string {
  const provider = e.metadata?.provider_name;
  const reasons = e.metadata?.reasons;
  const who = typeof provider === "string" && provider.trim() ? `${truncate(provider.trim(), 100)} ` : "";
  const list = Array.isArray(reasons)
    ? reasons.filter((r): r is string => typeof r === "string" && r.trim() !== "").join(", ")
    : typeof reasons === "string"
      ? reasons
      : "";
  const why = list ? ` Reason: ${truncate(list)}` : "";
  return `The request was rejected by ${who}content moderation.${why} Change the prompt or the image and try again.`;
}

/**
 * @param key limits from GET /api/v1/key, or null when they could not be fetched
 */
export function describeOpenRouterError(e: OpenRouterError, key: KeyInfo | null): string {
  // Codes this module raises itself come first: their statuses (408, 502, 200) would otherwise
  // be mistaken for upstream failures with different billing semantics.
  switch (e.code) {
    case "timeout":
      return "The OpenRouter call timed out after 200 s. The generation may still finish and be billed, so check OpenRouter activity before retrying.";
    case "network_error":
      return "Could not reach OpenRouter (network error). The call can be retried.";
    case "response_interrupted":
      return "The OpenRouter response was cut off after the request was accepted. The image may have been generated and billed, so check OpenRouter activity before retrying.";
    // The four cases below follow a 2xx, which means the provider accepted the request. OpenRouter
    // returns a non-completion as 502, so these are the possibly billed branch.
    case "invalid_response":
      return `OpenRouter returned an unreadable response, which is not retryable as is. The call may have been billed${reported(e.costUsd)}; check OpenRouter activity before trying another model.`;
    case "empty_response":
      return `OpenRouter accepted the request but returned no image. The call may have been billed${reported(e.costUsd)}. Change the prompt or the model before trying again.`;
    case "unsupported_output":
      return `${UNSUPPORTED_OUTPUT_MESSAGE} The call may have been billed${reported(e.costUsd)}. Try a different model or output_format.`;
  }
  if (isLimitError(e)) return describeLimit(key);
  if (e.status === 403 && isModeration(e)) return describeModeration(e);
  if (e.status === 502) {
    return "The OpenRouter generation failed or timed out (502). You were not charged, and you can retry.";
  }
  if ([408, 504, 524, 529].includes(e.status)) {
    return `The OpenRouter generation failed or timed out (HTTP ${e.status}). The call can be retried.`;
  }
  return `OpenRouter error ${e.status}: ${truncate(e.message)}`;
}
