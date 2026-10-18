# 0008. Host on Vercel Hobby as one Node function

- Status: Accepted. Supersedes [0001](0001-cloudflare-workers.md). Validated on a Vercel deployment on 2026-10-17.
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
- The function exports a Web-standard `fetch` handler (`export default { fetch }`). It routes on the request's pathname, which keeps the original path (`/mcp`) after a `vercel.json` rewrite.
- **No keep-alive.** Long tool calls need no progress notifications or keep-alives (see Validation).
- MCP uses the SDK's own `createMcpHandler`, stateless, with ext-apps for the widget. It accepts 2025-era clients (`initialize` with 2025-06-18 or 2025-11-25) and current ones. Legacy support is required, not optional: the iOS app's widget-initiated calls and `resources/read` use 2025-11-25.
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

**Build and static files**
- The build is a `vercel-build` script only, with no `build` script. It generates the widget and other build outputs before the function is bundled.
- `public/` must exist and be non-empty (a `robots.txt` is enough). Without it, Vercel's builder would serve uploaded files outside `api/` as static files.
- An allowlist `.vercelignore` uploads only the build inputs and `public/`.
- Together, these mean only `public/` is served statically. Sources, `package.json`, `vercel.json` and generated files return 404.

## Consequences

- Infrastructure costs $0 with a hard stop. The price is availability: exceeding a Hobby limit pauses the service for up to 30 days. Personal use is expected to stay far below the limits. The README says what happens on overrun.
- Native code is available in-process: sharp makes thumbnails ([0010](0010-vercel-blob-storage.md)), and Node's DNS and undici allow pinned connections for SSRF protection ([0007](0007-reference-urls-ssrf.md)).
- The 300-second limit covers the 200-second OpenRouter timeout inside Claude's 240-second tool-call limit.
- The 4.5 MB body cap sits above the SDK's 4 MiB MCP body cap, so uploads stay bound by the MCP cap.
- Commercial use of a deployment needs a paid Vercel plan.
- Vendor coupling is limited to three adapters. Moving back to Cloudflare would still mean Workers Paid, given the CPU measured above.
- Per-deployment URLs answer 302 to Vercel's login under Standard Protection, so only the production alias works as a connector URL.
- A rejected or unauthenticated request still invokes the function, which counts against the Hobby allowance.

## Validation (2026-10-17, Vercel)

Tested with throwaway deployments on Node 24 (linux x64), from claude.ai web (macOS Safari), Claude desktop (macOS) and the Claude iOS app (iOS 18.7).

- **Build:** a plain `api/index.ts` exporting `{ fetch }`, built with a `vercel-build` script and no `build` script, deployed and ran. Relative `.js` imports of build-generated `.ts` modules resolved.
- **Routing:** after a `vercel.json` rewrite (`/mcp` to `/api/index`), `request.url` keeps the original pathname, and query parameters added by the rewrite destination also arrive. Routing on the pathname works.
- **Static exposure:** with a non-empty `public/` and the allowlist `.vercelignore`, only `public/` was served. `/package.json`, `/vercel.json`, `/tsconfig.json`, sources and generated files returned 404, and `/api/index.ts` reached the function rather than returning source. That static serving happens without `public/` is inferred from the builder's source, not tested.
- **Production alias:** publicly reachable with no protection wall.
- **Long calls (decision: no keep-alive):** a tool call that waited 200 s with no bytes on the wire (protocol 2026-07-28, plain JSON response) completed on web and on iOS. claude.ai sends no `progressToken` on model-initiated tool calls, so progress notifications wouldn't be available anyway. Logging notifications would be.
- **Protocol versions:** model-initiated calls use 2026-07-28 (`server/discover`, no `initialize`) on every platform. The iOS app's widget-initiated calls and `resources/read` use 2025-11-25.
- **CPU:** a generate-like request (fetch and `res.json()` of a ~6 MB OpenRouter-shaped body, base64-decode of a 4.5 MB PNG, Blob `put`, 1024 px WebP thumbnail) took 515-601 ms of process CPU, 0.75-0.88 s wall and about 197 MB peak RSS over three warm runs. `JSON.parse` of the body is about 200-265 ms of that and the thumbnail about 175-212 ms. Hobby's 4 Active CPU-hours a month cover roughly 20,000 such requests.
- **sharp:** version 0.35.5 (libvips 8.18.7) loads in a plain Vercel Function. See [0010](0010-vercel-blob-storage.md) for the thumbnail results.
