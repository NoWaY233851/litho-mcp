# 0008. Host on Vercel Hobby as one Node function

- Status: Accepted. Supersedes [0001](0001-cloudflare-workers.md).
- Date: 2026-10-17

## Context

The connector requirements behind [0001](0001-cloudflare-workers.md) still hold:

- public HTTPS, reachable over IPv4, with no redirects to other hosts;
- Streamable HTTP;
- a tool call may take up to 240 seconds, and OpenRouter generation is synchronous (94 seconds or more, with no async mode).

**What Phase 0 measured on Workers (2026-10-16)**
- A generate-like request (parse a 6 MB JSON response, decode 4.5 MB of base64, write to R2, make a thumbnail) took 94, 109 and 122 ms of CPU.
- Other MCP requests, with no image work at all, took 6–92 ms.
- The Free plan allows 10 ms per request, so it isn't viable, even with an optimized decode path. MCP overhead alone can exceed it.
- Workers Paid ($5/month) has the CPU, but it bills usage past its included amounts and has no hard spending cap. The project's rule is $0 infrastructure, and no usage-billed service without a hard cap.

**Vercel Hobby (checked 2026-10-17)**
- $0. When a limit is exceeded, Hobby pauses the service for up to 30 days instead of billing.
- Functions run on the Node.js runtime with Fluid compute:
  - maximum duration 300 s;
  - 2 GB of memory and 1 vCPU;
  - per month: 4 Active CPU-hours, 360 GB-hours of provisioned memory and 1M invocations. Waiting on I/O doesn't count as Active CPU.
- Function request and response bodies are capped at 4.5 MB unless streamed.
- Hobby is for non-commercial personal use. A personal deployment of an open-source tool fits.
- Production aliases (`<project>.vercel.app`) are public under the default Standard Protection; per-deployment URLs aren't.

**Other hosts considered**
- **Cloudflare Workers Paid**: fits technically, but has no hard spending cap.
- **Deno Deploy**: free, but unproven for this workload.
- **Netlify Functions**: a 60-second limit, shorter than a long generation.
- **Supabase Edge Functions**: a 150-second limit, below the 200-second OpenRouter timeout ([0003](0003-model-agnostic-openrouter.md)).
- **Google Cloud Run and similar clouds**: they need a payment card, and their budgets don't stop spending instantly.

**SDK**
- `@modelcontextprotocol/server` 2.x ships its own stateless `createMcpHandler`, with a fallback that still serves 2025-era clients.
- The `agents` package and `@cloudflare/workers-oauth-provider` were only needed on Workers and for OAuth, which [0009](0009-connector-secret-header.md) drops.

## Decision

**One function**
- One Vercel project on the Hobby plan, with one Node.js function, `api/index.ts`, on Fluid compute.
- `vercel.json` sets `maxDuration: 300` for it, rewrites `/mcp` and `/cron/cleanup` (and `/upload`, only if the upload fallback in [0006](0006-photo-uploads.md) is used) to it, and declares the daily cleanup cron ([0010](0010-vercel-blob-storage.md)).
- The function exports a Web-standard `fetch` handler.
- MCP uses the SDK's own `createMcpHandler`, stateless, with ext-apps for the widget. It accepts 2025-era clients (`initialize` with 2025-06-18 or 2025-11-25) and current ones.
- No `agents`, no `@cloudflare/workers-oauth-provider`, no extra MCP adapter package.
- No database and no session state.

**A way back to Cloudflare**
- Everything except three adapters is plain TypeScript with no Vercel imports: format sniffing, SSRF checks, the model catalog and validation, the OpenRouter client, the tools and result building.
- The three adapters:
  - **`ImageStore`**: `put`, `get`, `exists`, `url`, `listOlderThan`, `delete`; on Vercel Blob ([0010](0010-vercel-blob-storage.md));
  - **`Thumbnailer`**: image bytes to WebP bytes; on sharp ([0010](0010-vercel-blob-storage.md));
  - **the HTTP entry**: `api/index.ts`.
- Moving back means writing R2 and Images-binding adapters and a Worker entry, not rewriting the core.

**Configuration**
- Encrypted environment variables: `OPENROUTER_API_KEY`, `CONNECTOR_SECRET` ([0009](0009-connector-secret-header.md)), `CRON_SECRET` ([0010](0010-vercel-blob-storage.md)), and `BLOB_READ_WRITE_TOKEN`, which the Blob integration sets.
- Plain environment variables: `DEFAULT_MODEL`, `RETENTION_DAYS`, `OPENROUTER_REFERER` (optional).
- Only the production alias is registered as the connector, never a per-deployment URL.
- `.vercel/` holds the project and org ids, so it is gitignored.

## Consequences

- Infrastructure costs $0 with a hard stop. The price is availability: exceeding a Hobby limit pauses the service for up to 30 days. Personal use is expected to stay far below the limits. The README says what happens on overrun.
- Native code is available in-process: sharp makes thumbnails ([0010](0010-vercel-blob-storage.md)), and Node's DNS and undici allow pinned connections for SSRF protection ([0007](0007-reference-urls-ssrf.md)).
- The 300-second limit covers the 200-second OpenRouter timeout inside Claude's 240-second tool-call limit.
- The 4.5 MB body cap sits above the SDK's 4 MiB MCP body cap, so uploads stay bound by the MCP cap.
- Commercial use of a deployment needs a paid Vercel plan.
- Vendor coupling is limited to three adapters. Moving back to Cloudflare would still mean Workers Paid, given the CPU measured above.
- **To verify on a throwaway Vercel deployment (Phase 0b) before building:**
  - A tool call that waits silently for about 200 s completes through claude.ai. No idle timeout separate from the maximum duration is documented. If the call is cut off, the server sends MCP progress notifications or keep-alives while it waits.
  - sharp loads in a plain (non-Next.js) Function, plus the size, time and memory of a 1024 px WebP thumbnail. The fallback is in [0010](0010-vercel-blob-storage.md).
  - The production alias is reachable with no protection wall.
  - Active CPU per generate-like request, read from Vercel's observability, to confirm the headroom.
