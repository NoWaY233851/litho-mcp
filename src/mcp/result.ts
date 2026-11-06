import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ImageInfo } from "../images/sniff.js";
import { SHEET_MAX_FRAMES } from "../images/limits.js";
import type { Animation } from "../images/thumbnail.js";
import { formatCost } from "../openrouter/cost.js";

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export interface ImageResultInput {
  id: string;
  url: string;
  info: ImageInfo;
  model: string;
  /** The aspect ratio that was requested, not one derived from the pixels. */
  aspectRatio?: string;
  costUsd: number | null;
  /** Id of the image an edit started from. */
  parent?: string;
  thumbnail: { data: string; mimeType: "image/webp" } | null;
  /** Read for GIFs only; null when it could not be read. */
  animation?: Animation | null;
}

const seconds = (ms: number): string => `${Number((ms / 1000).toFixed(2))} s`;

// Claude can't open the image URL, so for a GIF these lines are its only way to tell a still
// from an animation (docs/design/0011-animated-gif-output.md).
function gifLines(animation: Animation | null | undefined, hasPreview: boolean): string[] {
  if (!animation) return ["format: GIF"];
  const { frames, delaysMs, loop } = animation;
  if (frames <= 1) return ["format: GIF, a single frame (not animated)"];
  let timing = "";
  if (delaysMs.length === frames && delaysMs.every((d) => Number.isFinite(d) && d >= 0)) {
    const total = delaysMs.reduce((sum, d) => sum + d, 0);
    timing = delaysMs.every((d) => d === delaysMs[0])
      ? `, ${delaysMs[0]} ms each (${seconds(total)})`
      : `, ${seconds(total)} in total`;
  }
  const looping = loop === 0 ? ", loops forever" : `, loop count ${loop}`;
  const lines = [`format: animated GIF, ${frames} frames${timing}${looping}`];
  if (hasPreview) {
    const shown = Math.min(frames, SHEET_MAX_FRAMES);
    lines.push(
      shown === frames
        ? `preview: all ${frames} frames in a grid, in order left to right, then top to bottom`
        : `preview: ${shown} of the ${frames} frames, evenly spaced, in a grid, in order left to right, then top to bottom`,
    );
  }
  return lines;
}

// `content` is what Claude sees: a bounded thumbnail and a few short lines it can quote
// back. `structuredContent` is what the widget renders, which shows the full-size image
// from `url` (docs/design/0005-inline-display-mcp-apps.md). Keeping the lines separate
// items makes each one easy to pick out.
export function imageResult(r: ImageResultInput): CallToolResult {
  const lines = [
    `id: ${r.id}`,
    `url: ${r.url}`,
    `model: ${r.model}`,
    r.aspectRatio ? `aspect ratio: ${r.aspectRatio}` : `size: ${r.info.width}×${r.info.height}`,
    r.costUsd === null ? "cost: unknown" : `cost: ${formatCost(r.costUsd)}`,
  ];
  if (r.info.mime === "image/gif") lines.push(...gifLines(r.animation, r.thumbnail !== null));
  if (r.parent) lines.push(`edited from ${r.parent}`);

  const content: CallToolResult["content"] = [];
  if (r.thumbnail) content.push({ type: "image", data: r.thumbnail.data, mimeType: r.thumbnail.mimeType });
  for (const text of lines) content.push({ type: "text", text });

  return {
    content,
    structuredContent: {
      kind: "image",
      id: r.id,
      url: r.url,
      width: r.info.width,
      height: r.info.height,
      mime: r.info.mime,
      model: r.model,
      aspect_ratio: r.aspectRatio ?? null,
      cost_usd: r.costUsd,
      ...(r.parent ? { parent: r.parent } : {}),
    },
  };
}
