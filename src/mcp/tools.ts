import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { makeThumbnail } from "../images/thumbnail.js";
import { newImageId } from "../images/ids.js";
import { createImage, getKeyInfo, type CreatedImage } from "../openrouter/client.js";
import { OpenRouterError, describeOpenRouterError, isLimitError } from "../openrouter/errors.js";
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

const GENERIC_ERROR = "Something went wrong on the server and the request was not completed. Try again in a moment.";
const CATALOG_ERROR = "Could not load the OpenRouter model catalog. Try again in a moment.";

// Only the message is logged, never the stack, an upstream body or the request.
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : "unknown error");

export function unknownModelMessage(id: string): string {
  return `Unknown model "${id}". Call list_models to see the available image models.`;
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
