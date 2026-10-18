import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ImageInfo } from "../images/sniff.js";

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

// Six decimals keep sub-cent costs exact, and Number() drops trailing zeros without ever
// printing an exponent at that precision.
export const formatCost = (usd: number): string => `$${Number(usd.toFixed(6))}`;

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
