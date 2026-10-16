# litho-mcp design

litho-mcp is a remote MCP server that runs on Cloudflare Workers. Add it to claude.ai as a custom connector and Claude can generate and edit images through OpenRouter during a conversation. It works on claude.ai web, Claude desktop, and the Claude iOS and Android apps.

A typical use: ask Claude for a recipe card with four steps, then ask it to change only step 3.

This directory records the design as Architecture Decision Records (ADRs). Each ADR states one decision: the context that led to it, what was decided, and the consequences, including what was given up.

## Goals

1. Generate images from text (`generate_image`).
2. Edit images (`edit_image`) using images this server generated, photos the user uploaded, or public http(s) URLs.
3. Show results inline in the conversation on every Claude platform.
4. Work with any OpenRouter model that outputs images, chosen per call.
5. Stay safe on the public internet:
   - the API key never leaves the server;
   - every endpoint sits behind OAuth;
   - OpenRouter spending is capped;
   - fetching user-supplied URLs is protected against SSRF.

## Non-goals

- Multiple users or multi-tenancy. Each deployment serves the person who deployed it.
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
claude.ai ──HTTPS──▶ Worker
                     ├─ OAuth (workers-oauth-provider)
                     │   ├─ /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server
                     │   ├─ /register (DCR), /token
                     │   └─ /authorize ── owner password + consent page
                     ├─ /mcp ── stateless MCP handler ── tools + ui:// widget
                     └─ /img/<id> ── full-size images (unguessable URLs)

Bindings: R2 (images) · KV (OAuth data only) · Images (thumbnails)
Secrets:  OPENROUTER_API_KEY, OWNER_PASSWORD
```

## Decisions

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-cloudflare-workers.md) | Run as one stateless Cloudflare Worker | Accepted |
| [0002](0002-single-user-owner-password-oauth.md) | Single user per deployment; OAuth with an owner password | Accepted |
| [0003](0003-model-agnostic-openrouter.md) | Model-agnostic via the OpenRouter Image API | Accepted |
| [0004](0004-image-storage-and-delivery.md) | Store images in R2 behind unguessable URLs; delete after 30 days | Accepted |
| [0005](0005-inline-display-mcp-apps.md) | Show images inline with an MCP Apps widget | Accepted, pending platform validation |
| [0006](0006-photo-uploads.md) | Upload photos through the widget | Accepted, pending platform validation |
| [0007](0007-reference-urls-ssrf.md) | Fetch reference URLs ourselves, behind SSRF checks | Accepted |

To change a decision, add a new ADR that supersedes the old one, and update the old ADR's status. Don't rewrite history.

External facts quoted in these ADRs were checked on 2026-10-16 against official docs and OpenRouter's live API. Re-check them when they matter.
