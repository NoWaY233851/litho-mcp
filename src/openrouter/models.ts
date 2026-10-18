// OpenRouter image-model catalog and local parameter validation (ADR 0003).
//
// Every generate/edit call is checked against the live catalog before any paid request, so Claude
// gets a short, precise message instead of an upstream rejection. The catalog comes from two
// public endpoints: /api/v1/images/models (capabilities) and /api/v1/models?output_modalities=image
// (pricing), joined by model id.
//
// Failures name the endpoint path and HTTP status only. Request keys, response bodies and the
// original transport errors never reach a message, and this module logs nothing.

import type { Config } from "../config.js";

export const IMAGE_PARAMS = [
  "aspect_ratio",
  "resolution",
  "quality",
  "background",
  "output_format",
  "output_compression",
  "seed",
] as const;

export type ImageParamName = (typeof IMAGE_PARAMS)[number];

export type ImageParams = {
  aspect_ratio?: string;
  resolution?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  output_compression?: number;
  seed?: number;
};

// A boolean descriptor means "supported, value unconstrained", not that the value is a boolean.
export type ParamDescriptor =
  | { type: "enum"; values: string[] }
  | { type: "range"; min: number; max: number }
  | { type: "boolean" };

export interface ImageModel {
  id: string;
  name: string;
  inputModalities: string[];
  // Every descriptor the catalog declares, including n, size and input_references. Only the
  // IMAGE_PARAMS keys are exposed to callers; the rest drive validation internally.
  params: Record<string, ParamDescriptor>;
  pricing: Record<string, string>;
}

const API_BASE = "https://openrouter.ai";
const CATALOG_PATH = "/api/v1/images/models";
const PRICING_PATH = "/api/v1/models";
const PRICING_QUERY = "?output_modalities=image";
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 3_600_000;
const PRICE_KEYS = ["image", "image_output", "prompt"] as const;

// Module-level so a reused Fluid instance shares one catalog; a cold instance simply refetches.
// Only successful results are stored, so a transient failure is retried by the next call.
let cache: { models: ImageModel[]; fetchedAt: number } | undefined;

export function _resetModelCache(): void {
  cache = undefined;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchJson(
  path: string,
  query: string,
  key: string,
  f: typeof fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await f(`${API_BASE}${path}${query}`, {
      headers: { Authorization: `Bearer ${key}` },
      // The catalog never redirects; refusing one keeps the key from following it anywhere.
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new Error(`OpenRouter ${path} ${timedOut ? "timed out" : "request failed"}`);
  }
  if (!response.ok) throw new Error(`OpenRouter ${path} returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`OpenRouter ${path} returned invalid JSON (HTTP ${response.status})`);
  }
}

function dataArray(body: unknown, path: string): unknown[] {
  if (isObject(body) && Array.isArray(body.data)) return body.data;
  throw new Error(`OpenRouter ${path} returned an unexpected shape`);
}

// Unknown or malformed descriptors are dropped: treating a parameter as unsupported is the safe
// reading of something this module cannot validate.
function parseDescriptor(raw: unknown): ParamDescriptor | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.type === "boolean") return { type: "boolean" };
  if (raw.type === "enum" && Array.isArray(raw.values) && raw.values.every((v) => typeof v === "string")) {
    return { type: "enum", values: raw.values as string[] };
  }
  if (raw.type === "range" && typeof raw.min === "number" && typeof raw.max === "number") {
    return { type: "range", min: raw.min, max: raw.max };
  }
  return undefined;
}

function parseModel(raw: unknown, prices: Map<string, Record<string, string>>): ImageModel | undefined {
  if (!isObject(raw) || typeof raw.id !== "string") return undefined;
  const architecture = isObject(raw.architecture) ? raw.architecture : {};
  const inputModalities = Array.isArray(architecture.input_modalities)
    ? architecture.input_modalities.filter((m): m is string => typeof m === "string")
    : [];
  const params: Record<string, ParamDescriptor> = {};
  if (isObject(raw.supported_parameters)) {
    for (const [name, descriptor] of Object.entries(raw.supported_parameters)) {
      const parsed = parseDescriptor(descriptor);
      if (parsed) params[name] = parsed;
    }
  }
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : raw.id,
    inputModalities,
    params,
    pricing: prices.get(raw.id) ?? {},
  };
}

function parsePrices(rows: unknown[]): Map<string, Record<string, string>> {
  const prices = new Map<string, Record<string, string>>();
  for (const row of rows) {
    if (!isObject(row) || typeof row.id !== "string" || !isObject(row.pricing)) continue;
    const kept: Record<string, string> = {};
    for (const name of PRICE_KEYS) {
      const value = row.pricing[name];
      if (typeof value === "string" && value !== "0") kept[name] = value;
    }
    prices.set(row.id, kept);
  }
  return prices;
}

export async function getImageModels(
  cfg: Pick<Config, "openrouterApiKey">,
  f: typeof fetch = globalThis.fetch,
  now: () => number = Date.now,
): Promise<ImageModel[]> {
  if (cache && now() - cache.fetchedAt < CACHE_TTL_MS) return cache.models;

  const [catalog, pricing] = await Promise.all([
    fetchJson(CATALOG_PATH, "", cfg.openrouterApiKey, f),
    fetchJson(PRICING_PATH, PRICING_QUERY, cfg.openrouterApiKey, f),
  ]);
  const prices = parsePrices(dataArray(pricing, PRICING_PATH));
  const models: ImageModel[] = [];
  for (const raw of dataArray(catalog, CATALOG_PATH)) {
    const model = parseModel(raw, prices);
    if (model) models.push(model);
  }
  cache = { models, fetchedAt: now() };
  return models;
}

interface ReferenceLimits {
  min: number;
  max: number;
  canEdit: boolean;
}

// Reference limits come from the input_references descriptor. Without a range descriptor an
// image-capable model is taken to accept a single reference, and a text-only one none.
function referenceLimits(model: ImageModel): ReferenceLimits {
  const acceptsImages = model.inputModalities.includes("image");
  const descriptor = model.params.input_references;
  const range = descriptor?.type === "range" ? descriptor : undefined;
  const max = range ? range.max : acceptsImages ? 1 : 0;
  const min = range ? range.min : 0;
  return { min, max, canEdit: acceptsImages && max >= 1 };
}

function supportedParams(model: ImageModel): ImageParamName[] {
  return IMAGE_PARAMS.filter((name) => name in model.params);
}

function checkValue(modelId: string, name: ImageParamName, descriptor: ParamDescriptor, value: unknown): string | null {
  if (descriptor.type === "enum") {
    if (typeof value === "string" && descriptor.values.includes(value)) return null;
    return `Model "${modelId}" does not accept ${name} ${JSON.stringify(value)}. Allowed values: ${descriptor.values.join(", ")}.`;
  }
  if (descriptor.type === "range") {
    if (typeof value === "number" && Number.isFinite(value) && value >= descriptor.min && value <= descriptor.max) {
      return null;
    }
    return `Model "${modelId}" needs ${name} to be a number in ${descriptor.min}–${descriptor.max}.`;
  }
  return null;
}

// Returns a message for Claude, or null when the request may go to OpenRouter.
export function validateRequest(
  model: ImageModel,
  params: ImageParams,
  refCount: number,
  mode: "generate" | "edit",
): string | null {
  // SVG is rejected before anything else: the server only stores sniffed PNG, JPEG and WebP.
  if (typeof params.output_format === "string" && params.output_format.toLowerCase() === "svg") {
    return `Model "${model.id}": SVG output is not supported. Use output_format png, jpeg or webp where the model offers it.`;
  }

  const limits = referenceLimits(model);
  if (mode === "edit") {
    if (!limits.canEdit) {
      return `Model "${model.id}" cannot edit images because it does not accept reference images. Use list_models to find models with can_edit.`;
    }
    if (refCount > limits.max) {
      return `Model "${model.id}" accepts at most ${limits.max} reference image${limits.max === 1 ? "" : "s"}, but ${refCount} were given.`;
    }
    if (refCount < limits.min) {
      return `Model "${model.id}" requires at least ${limits.min} reference image${limits.min === 1 ? "" : "s"}, but ${refCount} were given.`;
    }
  } else if (refCount < limits.min) {
    return `Model "${model.id}" requires a reference image. Use edit_image with it instead of generate_image.`;
  }

  for (const name of IMAGE_PARAMS) {
    const value = params[name];
    if (value === undefined) continue;
    const descriptor = model.params[name];
    if (!descriptor) {
      const supported = supportedParams(model);
      return `Model "${model.id}" does not support "${name}". Supported parameters: ${supported.length > 0 ? supported.join(", ") : "none"}.`;
    }
    const problem = checkValue(model.id, name, descriptor, value);
    if (problem) return problem;
  }
  return null;
}

export function summarizeModel(m: ImageModel): {
  id: string;
  name: string;
  can_edit: boolean;
  max_references: number;
  params: Partial<Record<ImageParamName, ParamDescriptor>>;
  pricing: Record<string, string>;
} {
  const limits = referenceLimits(m);
  const params: Partial<Record<ImageParamName, ParamDescriptor>> = {};
  for (const name of supportedParams(m)) params[name] = m.params[name];
  return { id: m.id, name: m.name, can_edit: limits.canEdit, max_references: limits.max, params, pricing: m.pricing };
}
