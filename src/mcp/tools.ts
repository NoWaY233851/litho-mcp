import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { base64ToBytes, bytesToBase64 } from "../images/base64.js";
import { newImageId, parseImageId } from "../images/ids.js";
import { sniffImage, type ImageInfo } from "../images/sniff.js";
import { makeThumbnail } from "../images/thumbnail.js";
import { MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, PublicFetchError, fetchPublicImage } from "../net/public-fetch.js";
import { createImage, getKeyInfo, type CreatedImage } from "../openrouter/client.js";
import { OpenRouterError, describeOpenRouterError, isLimitError, truncate } from "../openrouter/errors.js";
import {
  IMAGE_PARAMS,
  getImageModels,
  summarizeModel,
  validateRequest,
  type ImageModel,
  type ImageParams,
} from "../openrouter/models.js";
import { errorResult, formatCost, imageResult, textResult } from "./result.js";

// Which parameters a model really takes varies, so they are validated against the live
// catalog rather than enumerated here (docs/design/0003-model-agnostic-openrouter.md).
export const GenerateArgs = z.object({
  prompt: z.string().min(1).describe("What to draw. Any language."),
  model: z.string().optional().describe("OpenRouter image model id. Omit for the default. See list_models."),
  aspect_ratio: z.string().optional().describe('For example "1:1" or "16:9", if the model supports it.'),
  resolution: z.string().optional().describe('For example "1K" or "2K", if the model supports it.'),
  quality: z.string().optional().describe("If the model supports it."),
  background: z.string().optional().describe("If the model supports it."),
  output_format: z.string().optional().describe("png, jpeg or webp, if the model supports it."),
  output_compression: z.number().int().min(0).max(100).optional().describe("0 to 100, if the model supports it."),
  seed: z.number().int().optional().describe("If the model supports it."),
});
export type GenerateArgs = z.infer<typeof GenerateArgs>;

export const GENERATE_DESCRIPTION =
  "Generate an image from a text prompt using an OpenRouter image model. The image is shown to the user inline; you receive a small preview, its id and a link to the original. To change it, call edit_image with the id. Call list_models to see other models and which parameters each supports. Images are kept for a limited time (30 days by default).";

export const LIST_MODELS_DESCRIPTION =
  "List OpenRouter image models: whether each can edit images, how many reference images it accepts, which of the parameters aspect_ratio, resolution, quality, background, output_format, output_compression and seed it supports (with allowed values), and pricing. Optional query filters by id or name.";

export const EDIT_DESCRIPTION =
  "Edit an image, or create a new one from reference images, using an OpenRouter image model. Pass image_ids from earlier results or uploads, and/or public http(s) image_urls. Each edit creates a new image with its own id; earlier versions stay available, so to go back, edit from the earlier id. The model may redraw parts you did not ask to change.";

export const UPLOAD_IMAGE_DESCRIPTION =
  "Show an upload button so the user can pick a photo from their device. The result contains the id the photo will have (up_...); after the user says it is uploaded, use that id with edit_image. Photos the user attached directly to the chat cannot be passed to these tools, so use this instead. If the user says the picker does not work on their device, ask them to open this same conversation on a computer and upload there.";

export const UPLOAD_IMAGE_DATA_DESCRIPTION = "Receive an uploaded image from the litho widget.";

const GENERIC_ERROR = "Something went wrong on the server and the request was not completed. Try again in a moment.";
const CATALOG_ERROR = "Could not load the OpenRouter model catalog. Try again in a moment.";

// Only the message is logged, never the stack, an upstream body or the request.
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : "unknown error");

// Ids, models and URLs come from the caller and are echoed back in messages, so each is cut
// to a length that cannot flood the conversation.
const ECHO_MAX = 200;
const echo = (text: string): string => truncate(text, ECHO_MAX);

export function unknownModelMessage(id: string): string {
  return `Unknown model "${echo(id)}". Call list_models to see the available image models.`;
}

/** The catalog, or an error result when it cannot be loaded. */
export async function loadCatalog(deps: Deps): Promise<ImageModel[] | CallToolResult> {
  try {
    return await getImageModels(deps.config, deps.fetch, deps.now);
  } catch (e) {
    deps.log(`catalog unavailable: ${messageOf(e)}`);
    return errorResult(CATALOG_ERROR);
  }
}

/**
 * The single place a tool failure becomes a result. An OpenRouterError is shown through
 * describeOpenRouterError, which owns what is safe to say about billing; the key limits are
 * fetched only for errors they can explain. Nothing else is shown: an unexpected error gets a
 * fixed message and its text goes to the log.
 */
export async function failureResult(deps: Deps, e: unknown): Promise<CallToolResult> {
  if (e instanceof OpenRouterError) {
    const key = isLimitError(e) ? await getKeyInfo(deps.config, deps.fetch) : null;
    return errorResult(describeOpenRouterError(e, key));
  }
  deps.log(`unexpected error: ${messageOf(e)}`);
  return errorResult(GENERIC_ERROR);
}

/**
 * Stores a created image and builds the tool result. Shared by every tool that creates an
 * image. A failed save is reported as such, with the cost, because the provider has already
 * accepted (and billed) the generation. A missing thumbnail never fails the call.
 */
export async function saveAndShow(
  deps: Deps,
  created: CreatedImage,
  meta: { model: string; aspectRatio?: string; parent?: string },
): Promise<CallToolResult> {
  const id = newImageId("img");
  let url: string;
  try {
    url = await deps.store.put(id, created.bytes, created.info);
  } catch (e) {
    deps.log(`image save failed: ${messageOf(e)}`);
    const cost = created.costUsd === null ? "The call may have been billed" : `OpenRouter reported a cost of ${formatCost(created.costUsd)}`;
    return errorResult(
      `The image was generated but could not be saved, so it can't be shown or edited. ${cost}; generate it again if you still want it.`,
    );
  }
  const thumbnail = await makeThumbnail(deps.thumbnailer, created.bytes);
  if (!thumbnail) deps.log("thumbnail unavailable");
  return imageResult({
    id,
    url,
    info: created.info,
    model: meta.model,
    ...(meta.aspectRatio !== undefined ? { aspectRatio: meta.aspectRatio } : {}),
    costUsd: created.costUsd,
    ...(meta.parent !== undefined ? { parent: meta.parent } : {}),
    thumbnail,
  });
}

export async function generateImage(deps: Deps, args: GenerateArgs): Promise<CallToolResult> {
  try {
    const modelId = args.model?.trim() || deps.config.defaultModel;
    const catalog = await loadCatalog(deps);
    if (!Array.isArray(catalog)) return catalog;
    const model = catalog.find((m) => m.id === modelId);
    if (!model) return errorResult(unknownModelMessage(modelId));

    const params: ImageParams = {};
    for (const name of IMAGE_PARAMS) {
      const value = args[name];
      if (value !== undefined) Object.assign(params, { [name]: value });
    }
    const problem = validateRequest(model, params, 0, "generate");
    if (problem) return errorResult(problem);

    let created: CreatedImage;
    try {
      created = await createImage(
        deps.config,
        { model: model.id, prompt: args.prompt, params, references: [] },
        deps.fetch,
      );
    } catch (e) {
      return await failureResult(deps, e);
    }
    return await saveAndShow(deps, created, {
      model: model.id,
      ...(params.aspect_ratio !== undefined ? { aspectRatio: params.aspect_ratio } : {}),
    });
  } catch (e) {
    return await failureResult(deps, e);
  }
}

// The whole result has to stay small enough for the host to hand to the model.
const LIST_RESULT_BUDGET = 150_000;

export async function listModels(deps: Deps, args: { query?: string }): Promise<CallToolResult> {
  try {
    const catalog = await loadCatalog(deps);
    if (!Array.isArray(catalog)) return catalog;
    const query = args.query?.trim().toLowerCase();
    const matches = catalog.filter(
      (m) => !query || m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query),
    );
    const summaries = matches.map(summarizeModel);

    const build = (count: number): CallToolResult =>
      textResult(
        JSON.stringify({
          default_model: deps.config.defaultModel,
          models: summaries.slice(0, count),
          ...(count < summaries.length
            ? { truncated: true, total: summaries.length, note: "List cut to fit; pass query to narrow it." }
            : {}),
        }),
      );
    let count = summaries.length;
    let result = build(count);
    while (JSON.stringify(result).length >= LIST_RESULT_BUDGET && count > 0) {
      count = Math.floor(count * 0.8);
      result = build(count);
    }
    return result;
  } catch (e) {
    return await failureResult(deps, e);
  }
}

// --- edit_image -----------------------------------------------------------------------------

// 16 is the largest reference count any catalog model offers; the model's own limit is
// checked by validateRequest. The bound only keeps a request from naming thousands of images.
const MAX_REFERENCE_ARGS = 16;
// Every reference is held in memory twice (bytes, then base64) before the request is sent.
const MAX_TOTAL_REFERENCE_BYTES = 4 * MAX_IMAGE_BYTES;

export const EditArgs = GenerateArgs.extend({
  prompt: z.string().min(1).describe("The edit to make, or what to create from the references. Any language."),
  image_ids: z
    .array(z.string())
    .max(MAX_REFERENCE_ARGS)
    .optional()
    .describe("Ids of earlier results (img_...) or uploaded photos (up_...)."),
  image_urls: z
    .array(z.string())
    .max(MAX_REFERENCE_ARGS)
    .optional()
    .describe("Public http(s) URLs of PNG, JPEG or WebP images."),
});
export type EditArgs = z.infer<typeof EditArgs>;

/** A seam for tests; production always uses the pinned-DNS fetch (docs/design/0007-reference-urls-ssrf.md). */
export interface EditOptions {
  fetchPublic?: typeof fetchPublicImage;
}

type Reference = { kind: "id"; id: string } | { kind: "url"; url: string };
type Loaded = { ok: true; bytes: Uint8Array; info: ImageInfo } | { ok: false; message: string };

const notFoundMessage = (id: string): string =>
  id.startsWith("up_")
    ? `Photo ${echo(id)} has not been uploaded yet, or it expired.`
    : `Image ${echo(id)} was not found; it may have expired after the retention period.`;

const FETCH_REASON_PHRASES: Record<string, string> = {
  invalid_url: "the URL is not allowed",
  blocked_host: "the host is not allowed",
  dns_failed: "the host could not be resolved",
  too_many_redirects: "too many redirects",
  http_error: "the download failed",
  too_large: "larger than 10 MiB",
  timeout: "the download took too long",
  not_image: "not a PNG, JPEG or WebP image",
  too_many_pixels: "larger than 8192 px on a side",
};

function fetchFailureMessage(url: string, e: PublicFetchError): string {
  return `Could not use image URL ${echo(url)}: ${e.reason} (${FETCH_REASON_PHRASES[e.reason] ?? "rejected"}).`;
}

async function loadReference(
  deps: Deps,
  ref: Reference,
  fetchPublic: typeof fetchPublicImage,
): Promise<Loaded> {
  if (ref.kind === "id") {
    const stored = await deps.store.get(ref.id);
    return stored ? { ok: true, bytes: stored.bytes, info: stored.info } : { ok: false, message: notFoundMessage(ref.id) };
  }
  try {
    return { ok: true, ...(await fetchPublic(ref.url)) };
  } catch (e) {
    if (e instanceof PublicFetchError) return { ok: false, message: fetchFailureMessage(ref.url, e) };
    throw e;
  }
}

export async function editImage(deps: Deps, args: EditArgs, options: EditOptions = {}): Promise<CallToolResult> {
  try {
    // Nothing is loaded or fetched until every cheap check has passed. A URL that points at
    // this deployment's own store is just another stored id, so it never takes the network
    // path (docs/design/0007-reference-urls-ssrf.md).
    const refs: Reference[] = [
      ...(args.image_ids ?? []).map((id): Reference => ({ kind: "id", id })),
      ...(args.image_urls ?? []).map((url): Reference => {
        const id = deps.store.idFromUrl(url);
        return id ? { kind: "id", id } : { kind: "url", url };
      }),
    ];
    for (const ref of refs) {
      if (ref.kind === "id" && !parseImageId(ref.id)) return errorResult(notFoundMessage(ref.id));
    }
    if (refs.length === 0) {
      return errorResult("edit_image needs at least one reference image: pass image_ids or image_urls.");
    }

    const modelId = args.model?.trim() || deps.config.defaultModel;
    const catalog = await loadCatalog(deps);
    if (!Array.isArray(catalog)) return catalog;
    const model = catalog.find((m) => m.id === modelId);
    if (!model) return errorResult(unknownModelMessage(modelId));

    const params: ImageParams = {};
    for (const name of IMAGE_PARAMS) {
      const value = args[name];
      if (value !== undefined) Object.assign(params, { [name]: value });
    }
    const problem = validateRequest(model, params, refs.length, "edit");
    if (problem) return errorResult(problem);

    // allSettled so the failure reported is the first in input order, not the fastest.
    const fetchPublic = options.fetchPublic ?? fetchPublicImage;
    const settled = await Promise.allSettled(refs.map((ref) => loadReference(deps, ref, fetchPublic)));
    const loaded: { bytes: Uint8Array; info: ImageInfo }[] = [];
    for (const outcome of settled) {
      if (outcome.status === "rejected") throw outcome.reason;
      if (!outcome.value.ok) return errorResult(outcome.value.message);
      loaded.push(outcome.value);
    }

    const total = loaded.reduce((sum, r) => sum + r.bytes.length, 0);
    if (total > MAX_TOTAL_REFERENCE_BYTES) {
      return errorResult(
        `The reference images total more than ${MAX_TOTAL_REFERENCE_BYTES / (1024 * 1024)} MiB. Use fewer or smaller images.`,
      );
    }
    // Only data URLs the server built from sniffed bytes leave this process; a caller's URL is
    // never forwarded to OpenRouter.
    const references = loaded.map((r) => `data:${r.info.mime};base64,${bytesToBase64(r.bytes)}`);

    let created: CreatedImage;
    try {
      created = await createImage(deps.config, { model: model.id, prompt: args.prompt, params, references }, deps.fetch);
    } catch (e) {
      return await failureResult(deps, e);
    }
    const parent = refs.find((ref): ref is Extract<Reference, { kind: "id" }> => ref.kind === "id")?.id;
    return await saveAndShow(deps, created, {
      model: model.id,
      ...(params.aspect_ratio !== undefined ? { aspectRatio: params.aspect_ratio } : {}),
      ...(parent !== undefined ? { parent } : {}),
    });
  } catch (e) {
    return await failureResult(deps, e);
  }
}

// --- uploads --------------------------------------------------------------------------------

/**
 * Hands out the id a photo will have. Nothing is written: the widget probes the id's public URL
 * to learn whether a photo is already there, which is what lets the state survive a reload
 * (docs/design/0006-photo-uploads.md).
 */
export function openUploader(deps: Deps): CallToolResult {
  const id = newImageId("up");
  return {
    content: [
      {
        type: "text",
        text: `Upload slot ${id}. The photo will be available as ${id} once the user uploads it; then use it with edit_image.`,
      },
    ],
    structuredContent: { kind: "upload", id, url: deps.store.url(id) },
  };
}

const UPLOAD_ID = /^up_[0-9a-f]{32}$/;
// The longest base64 text that can decode to MAX_IMAGE_BYTES, checked before decoding anything.
const MAX_UPLOAD_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

/**
 * App-only: the widget sends the photo it re-encoded in the browser. The id was pre-assigned by
 * openUploader, and a repeat upload to the same id replaces the photo. Messages never include
 * the payload.
 */
export async function uploadImageData(deps: Deps, args: { id: string; data: string }): Promise<CallToolResult> {
  try {
    if (!UPLOAD_ID.test(args.id)) {
      return errorResult(`Invalid upload id "${echo(args.id)}". It must look like up_ followed by 32 lowercase hex digits.`);
    }
    if (args.data.startsWith("data:")) {
      return errorResult("Send the photo as plain base64, without a data: prefix.");
    }
    if (args.data.length > MAX_UPLOAD_BASE64_LENGTH) {
      return errorResult("The photo is larger than the 10 MiB limit.");
    }
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(args.data);
    } catch {
      return errorResult("The photo data is not valid base64.");
    }
    if (bytes.length > MAX_IMAGE_BYTES) return errorResult("The photo is larger than the 10 MiB limit.");
    const info = sniffImage(bytes);
    if (!info) return errorResult("The photo is not a PNG, JPEG or WebP image.");
    if (info.width > MAX_IMAGE_SIDE || info.height > MAX_IMAGE_SIDE) {
      return errorResult(`The photo is larger than ${MAX_IMAGE_SIDE} pixels on a side.`);
    }
    try {
      await deps.store.put(args.id, bytes, info);
    } catch (e) {
      deps.log(`upload save failed: ${messageOf(e)}`);
      return errorResult("The photo could not be saved. Try uploading it again.");
    }
    return {
      content: [{ type: "text", text: `Uploaded ${args.id} (${info.width}×${info.height}).` }],
      structuredContent: { kind: "uploaded", id: args.id, width: info.width, height: info.height },
    };
  } catch (e) {
    return await failureResult(deps, e);
  }
}
