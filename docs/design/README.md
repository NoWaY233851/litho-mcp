# litho-mcp design

litho-mcp is a remote MCP server that runs on Vercel (Hobby plan) as a single Node.js function. Add it to claude.ai as a custom connector and Claude can generate and edit images through OpenRouter during a conversation. It works on claude.ai web, Claude desktop, and the Claude iOS and Android apps.

A typical use: ask Claude for a recipe card with four steps, then ask it to change only step 3.

This directory records the design as Architecture Decision Records (ADRs). Each ADR states one decision: the context that led to it, what was decided, and the consequences, including what was given up.

## Goals

1. Generate images from text (`generate_image`).
2. Edit images (`edit_image`) using images this server generated, photos the user uploaded, or public http(s) URLs.
3. Show results inline in the conversation on every Claude platform.
4. Work with any OpenRouter model that outputs images, chosen per call.
5. Stay safe on the public internet:
   - the API key never leaves the server;
   - the MCP endpoint accepts only requests that carry the connector secret, sent as a request header;
   - OpenRouter spending is capped;
   - fetching user-supplied URLs is protected against SSRF.
6. Keep a way back to Cloudflare. Host-specific code stays behind three small adapters (storage, thumbnailing, HTTP entry), so moving hosts means replacing adapters, not rewriting the core.

## Non-goals

- Multiple users or multi-tenancy. Each deployment serves the person who deployed it.
- OAuth. Deployers need claude.ai's "Request headers" connector feature, which is in beta for a limited set of organizations.
- Fixing model quality, such as misspelled text or edits that change other parts of the image.
- A VPS or self-hosted variant.
- Version-history UI, download buttons, or "generate another" buttons in the chat.
- More than one image per call.
- Passing through provider-specific parameters.

## Anti-goals

The project counts as failed, even if every feature works, if any of these happen:

- It becomes heavy or hard to maintain. **Simplicity wins ties.**
- It is awkward to use on a phone.
- Users have to sign in again often.
- It is slow for reasons other than the model, such as extra round trips or slow image loading.
- It needs noticeable infrastructure spend. Model spend is the user's choice and doesn't count.
- Personal data ends up in the repository.

## Architecture at a glance

```
api/index.ts (one Node.js function, Fluid compute; vercel.json rewrites)
├─ /mcp ◀── claude.ai backend (HTTPS + connector secret header)
│   ├─ auth: constant-time secret check
│   └─ MCP: createMcpHandler (SDK 2.x, stateless) + ext-apps widget
├─ /cron/cleanup ◀── Vercel Cron (daily, Bearer CRON_SECRET)
├─ ImageStore ──▶ Vercel Blob (public store)
├─ Thumbnailer ──▶ sharp
└─ OpenRouter client, SSRF-safe fetch (undici, pinned DNS)

claude.ai widget (sandbox iframe) ──<img src>──▶ Blob public URL (no function call)

Env (secret):    OPENROUTER_API_KEY, CONNECTOR_SECRET, CRON_SECRET
Env (plain):     DEFAULT_MODEL, RETENTION_DAYS, OPENROUTER_REFERER, BLOB_STORE_ID (required without a token), BLOB_READ_WRITE_TOKEN (CLI path only, plain)
```

There is no database and no OAuth state. Everything except `ImageStore`, `Thumbnailer` and the HTTP entry is host-neutral TypeScript.

## Decisions

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-cloudflare-workers.md) | Run as one stateless Cloudflare Worker | Superseded by 0008 |
| [0002](0002-single-user-owner-password-oauth.md) | Single user per deployment; OAuth with an owner password | Superseded by 0009 |
| [0003](0003-model-agnostic-openrouter.md) | Model-agnostic via the OpenRouter Image API | Accepted |
| [0004](0004-image-storage-and-delivery.md) | Store images in R2 behind unguessable URLs; delete after 30 days | Superseded by 0010 |
| [0005](0005-inline-display-mcp-apps.md) | Show images inline with an MCP Apps widget | Accepted; validated on web, desktop and iOS (acceptance 2026-10-18/19), Android untested; revised for Blob URLs |
| [0006](0006-photo-uploads.md) | Upload photos through the widget, to a pre-assigned id | Accepted; validated on web, desktop and iOS (acceptance 2026-10-18/19), Android untested; revised for Vercel |
| [0007](0007-reference-urls-ssrf.md) | Fetch reference URLs ourselves, behind SSRF checks | Accepted; revised for pinned DNS on Node; validated in acceptance 2026-10-18/19 |
| [0008](0008-vercel-hobby.md) | Host on Vercel Hobby as one Node function | Accepted; validated 2026-10-17 and in acceptance 2026-10-18/19 |
| [0009](0009-connector-secret-header.md) | Authenticate with a connector secret in a request header | Accepted; validated 2026-10-17 and in acceptance 2026-10-18/19 |
| [0010](0010-vercel-blob-storage.md) | Store images in a public Vercel Blob store; delete after 30 days | Accepted; validated 2026-10-17, with OIDC 2026-10-19, and in acceptance 2026-10-18/19 |

To change a decision, add a new ADR that supersedes the old one, and update the old ADR's status. Don't rewrite history.

Host and platform behavior is checked on throwaway deployments before the real server depends on it. Phase 0 was a Cloudflare Worker tested on claude.ai web and iOS on 2026-10-16. Phase 0b was a Vercel project that verified the Vercel-specific assumptions of ADRs 0005–0010 on claude.ai web, Claude desktop and the Claude iOS app on 2026-10-17. Its results are in dated Validation sections of the affected ADRs. An acceptance run on the production deployment followed on 2026-10-18 and 2026-10-19 on web, desktop and iOS. Android has not been tested on any deployment.

External facts quoted in these ADRs were checked on 2026-10-16 (OpenRouter, MCP Apps, Cloudflare) and 2026-10-17 (Vercel and claude.ai connector request headers) against official docs and OpenRouter's live API. Re-check them when they matter.
