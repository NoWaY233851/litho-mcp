import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// A throwaway server: it only proves the pinned SDK serves both protocol eras
// through one factory, which the real endpoint will rely on.
function makeHandler() {
  return createMcpHandler(() => {
    const server = new McpServer({ name: "scaffold-probe", version: "0.0.0" });
    server.registerTool(
      "echo",
      { description: "Echo the input.", inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => ({ content: [{ type: "text" as const, text }] }),
    );
    return server;
  });
}

async function connect(mode: "legacy" | { pin: string }) {
  const handler = makeHandler();
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { versionNegotiation: { mode } },
  );
  const transport = new StreamableHTTPClientTransport(new URL("https://x.test/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  await client.connect(transport);
  return { client, transport, handler };
}

describe("createMcpHandler era support", () => {
  it("serves a 2026-07-28 client", async () => {
    const { client, handler } = await connect({ pin: "2026-07-28" });
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
    await client.close();
    await handler.close();
  });

  it("serves a 2025-11-25 client (versionNegotiation: legacy)", async () => {
    const { client, transport, handler } = await connect("legacy");
    expect(transport.protocolVersion).toBe("2025-11-25");
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
    await client.close();
    await handler.close();
  });
});
