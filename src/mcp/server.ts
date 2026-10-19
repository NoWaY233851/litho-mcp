import { McpServer, createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import type { McpUiResourceMeta, McpUiToolMeta } from "@modelcontextprotocol/ext-apps";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import type { Deps } from "../deps.js";
import APP_HTML from "../generated/app-html.js";
import { BLOB_HOST_SUFFIX } from "../images/blob-url.js";
import {
  EDIT_DESCRIPTION,
  EditArgs,
  GENERATE_DESCRIPTION,
  GenerateArgs,
  LIST_MODELS_DESCRIPTION,
  UPLOAD_IMAGE_DATA_DESCRIPTION,
  UPLOAD_IMAGE_DESCRIPTION,
  editImage,
  generateImage,
  listModels,
  openUploader,
  uploadImageData,
} from "./tools.js";

export const UI_URI = "ui://litho/app.html";

// The widget shows the original from its public Blob URL. A wildcard keeps the CSP free of
// any per-deployment value, and the host honors it on web, desktop and iOS
// (docs/design/0010-vercel-blob-storage.md). There are no connectDomains: uploads go
// through a tool call, not a direct request from the widget.
const WIDGET_RESOURCE_DOMAINS = [`https://*${BLOB_HOST_SUFFIX}`];

export function createLithoServer(deps: Deps): McpServer {
  // The tools and the widget resource never change within a deployment. Advertising list changes
  // makes clients hold a subscriptions/listen stream open until Vercel's 300 s limit cuts it
  // (docs/design/0008-vercel-hobby.md).
  const server = new McpServer(
    { name: "litho-mcp", version: "0.0.0" },
    { capabilities: { tools: { listChanged: false }, resources: { listChanged: false } } },
  );

  registerAppResource(server, "litho-widget", UI_URI, { mimeType: RESOURCE_MIME_TYPE }, async (uri) => ({
    contents: [
      {
        uri: uri.href,
        // registerAppResource does not add the mime type or the CSP to read results.
        mimeType: RESOURCE_MIME_TYPE,
        text: APP_HTML,
        _meta: { ui: { csp: { resourceDomains: WIDGET_RESOURCE_DOMAINS } } satisfies McpUiResourceMeta },
      },
    ],
  }));

  registerAppTool(
    server,
    "generate_image",
    {
      description: GENERATE_DESCRIPTION,
      inputSchema: GenerateArgs,
      _meta: { ui: { resourceUri: UI_URI } satisfies McpUiToolMeta },
    },
    (args) => generateImage(deps, args),
  );

  registerAppTool(
    server,
    "edit_image",
    {
      description: EDIT_DESCRIPTION,
      inputSchema: EditArgs,
      _meta: { ui: { resourceUri: UI_URI } satisfies McpUiToolMeta },
    },
    (args) => editImage(deps, args),
  );

  registerAppTool(
    server,
    "upload_image",
    {
      description: UPLOAD_IMAGE_DESCRIPTION,
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: UI_URI } satisfies McpUiToolMeta },
    },
    () => openUploader(deps),
  );

  // Called by the widget with the photo's base64; hidden from the model so it never tries to
  // send image data itself (docs/design/0006-photo-uploads.md).
  registerAppTool(
    server,
    "upload_image_data",
    {
      description: UPLOAD_IMAGE_DATA_DESCRIPTION,
      inputSchema: z.object({ id: z.string(), data: z.string() }),
      _meta: { ui: { resourceUri: UI_URI, visibility: ["app"] } satisfies McpUiToolMeta },
    },
    (args) => uploadImageData(deps, args),
  );

  // Plain text for the model; the widget has nothing to show for it.
  server.registerTool(
    "list_models",
    {
      description: LIST_MODELS_DESCRIPTION,
      inputSchema: z.object({ query: z.string().optional().describe("Filter by model id or name.") }),
    },
    (args) => listModels(deps, args),
  );

  return server;
}

// One handler per Deps. The factory builds a new McpServer for every request, as the SDK
// requires. Default options on purpose: the legacy leg serves 2025-11-25 clients, which
// claude.ai's iOS widget still uses for tools/call and resources/read.
const handlers = new WeakMap<Deps, McpHttpHandler>();

export function mcpFetch(req: Request, deps: Deps): Promise<Response> {
  let handler = handlers.get(deps);
  if (!handler) {
    handler = createMcpHandler(() => createLithoServer(deps));
    handlers.set(deps, handler);
  }
  return handler.fetch(req);
}
