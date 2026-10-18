import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import APP_HTML from "../src/generated/app-html.js";
import { UI_URI, mcpFetch } from "../src/mcp/server.js";
import { _resetModelCache } from "../src/openrouter/models.js";
import { PNG_B64, fakeDeps, fakeOpenRouter, fullEnv } from "./helpers.js";

const FLARE = "openai/gpt-image-2.5-flare";
const WILDCARD_BLOB = "https://*.public.blob.vercel-storage.com";

// Both protocol eras go through the same endpoint: claude.ai's iOS widget uses 2025-11-25 for
// tools/call and resources/read, so the legacy run is not optional.
const ERAS = [
  ["2026-07-28 (modern)", { pin: "2026-07-28" } as const],
  ["2025-11-25 (legacy)", "legacy" as const],
] as const;

beforeEach(() => _resetModelCache());

async function connect(mode: "legacy" | { pin: string }) {
  const or = fakeOpenRouter();
  const deps = fakeDeps({ config: loadConfig({ ...fullEnv, DEFAULT_MODEL: FLARE }), fetch: or.f });
  const client = new Client({ name: "test-client", version: "0.0.0" }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(new URL("https://x.test/mcp"), {
    fetch: (url, init) => mcpFetch(new Request(url, init), deps),
  });
  await client.connect(transport);
  return { client, transport, deps, or };
}

describe.each(ERAS)("MCP endpoint, %s client", (_label, mode) => {
  it("lists generate_image with _meta.ui.resourceUri and list_models as a plain tool", async () => {
    const { client } = await connect(mode);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.has("generate_image")).toBe(true);
    expect(byName.has("list_models")).toBe(true);
    expect((byName.get("generate_image")!._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe(UI_URI);
    expect(UI_URI).toBe("ui://litho/app.html");
    const listUi = (byName.get("list_models")!._meta as { ui?: unknown } | undefined)?.ui;
    expect(listUi).toBeUndefined();
    expect(byName.get("generate_image")!.description).toContain("Images are kept for a limited time (30 days by default).");
    await client.close();
  });

  it("lists edit_image and upload_image with the widget, and upload_image_data as app-only", async () => {
    const { client } = await connect(mode);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const ui = (name: string) => (byName.get(name)!._meta as { ui: { resourceUri: string; visibility?: string[] } }).ui;
    expect(ui("edit_image").resourceUri).toBe(UI_URI);
    expect(ui("upload_image").resourceUri).toBe(UI_URI);
    expect(ui("upload_image_data")).toEqual({ resourceUri: UI_URI, visibility: ["app"] });
    expect(ui("edit_image").visibility).toBeUndefined();
    expect(ui("upload_image").visibility).toBeUndefined();
    expect(byName.get("edit_image")!.description).toMatch(/^Edit an image, or create a new one from reference images/);
    expect(byName.get("upload_image")!.description).toContain("(up_...)");
    expect(byName.get("upload_image_data")!.description).toBe("Receive an uploaded image from the litho widget.");
    await client.close();
  });

  it("uploads a photo through upload_image and upload_image_data, then edits it", async () => {
    const { client, or } = await connect(mode);
    const slot = await client.callTool({ name: "upload_image", arguments: {} });
    const { kind, id } = slot.structuredContent as { kind: string; id: string };
    expect(kind).toBe("upload");
    expect(id).toMatch(/^up_[0-9a-f]{32}$/);

    const uploaded = await client.callTool({ name: "upload_image_data", arguments: { id, data: PNG_B64 } });
    expect(uploaded.structuredContent).toEqual({ kind: "uploaded", id, width: 1, height: 1 });

    const edited = await client.callTool({ name: "edit_image", arguments: { prompt: "make it blue", image_ids: [id] } });
    expect(edited.isError).toBeFalsy();
    expect(edited.structuredContent).toMatchObject({ kind: "image", parent: id });
    const refs = (or.posts()[0]!.body!.input_references as { image_url: { url: string } }[]).map((r) => r.image_url.url);
    expect(refs).toEqual([`data:image/png;base64,${PNG_B64}`]);
    await client.close();
  });

  it("answers an edit of a missing photo as a tool-level error", async () => {
    const { client, or } = await connect(mode);
    const result = await client.callTool({
      name: "edit_image",
      arguments: { prompt: "a", image_ids: ["up_00000000000000000000000000000001"] },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("has not been uploaded yet, or it expired");
    expect(or.posts()).toHaveLength(0);
    await client.close();
  });

  it("reads the widget as text/html;profile=mcp-app with the wildcard blob host and no connectDomains", async () => {
    const { client } = await connect(mode);
    const { contents } = await client.readResource({ uri: UI_URI });
    expect(contents).toHaveLength(1);
    const content = contents[0]!;
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect("text" in content && content.text).toBe(APP_HTML);
    const csp = (content._meta as { ui: { csp: Record<string, unknown> } }).ui.csp;
    expect(csp.resourceDomains).toEqual([WILDCARD_BLOB]);
    expect(csp).not.toHaveProperty("connectDomains");
    await client.close();
  });

  it("calls generate_image and returns the thumbnail, the text lines and structuredContent", async () => {
    const { client, or } = await connect(mode);
    const result = await client.callTool({
      name: "generate_image",
      arguments: { prompt: "番茄炒蛋菜譜，四個步驟", aspect_ratio: "2:3" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as { type: string; mimeType?: string; text?: string }[];
    expect(content[0]).toMatchObject({ type: "image", mimeType: "image/webp" });
    expect(content.filter((c) => c.type === "text").map((c) => c.text)).toContain(`model: ${FLARE}`);
    expect(result.structuredContent).toMatchObject({
      kind: "image",
      model: FLARE,
      aspect_ratio: "2:3",
      url: expect.stringMatching(/\/img\/[0-9a-f]{32}$/),
    });
    expect(or.posts()[0]!.body!.prompt).toBe("番茄炒蛋菜譜，四個步驟");
    await client.close();
  });

  it("calls list_models", async () => {
    const { client } = await connect(mode);
    const result = await client.callTool({ name: "list_models", arguments: { query: "krea" } });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    expect(JSON.parse(text).models.map((m: { id: string }) => m.id)).toEqual(["krea/k3-edit"]);
    await client.close();
  });

  it("answers a tool-level failure as an error result, not a protocol error", async () => {
    const { client } = await connect(mode);
    const result = await client.callTool({ name: "generate_image", arguments: { prompt: "a", model: "nope/missing" } });
    expect(result.isError).toBe(true);
    await client.close();
  });
});

describe("transport era", () => {
  it("negotiates 2025-11-25 for the legacy client", async () => {
    const { client, transport } = await connect("legacy");
    expect(transport.protocolVersion).toBe("2025-11-25");
    await client.close();
  });
});
