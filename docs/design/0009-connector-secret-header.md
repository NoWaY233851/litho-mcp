# 0009. Authenticate with a connector secret in a request header

- Status: Accepted. Supersedes [0002](0002-single-user-owner-password-oauth.md). Validated on web, desktop and iOS on 2026-10-17, and in production acceptance on 2026-10-18 and 2026-10-19.
- Date: 2026-10-17

## Context

The server spends the deployer's OpenRouter credit, so `/mcp` must not be open. Each deployment still has exactly one user, the person who deployed it. Anthropic's connector docs say never to accept credentials in query parameters, because they leak into logs and history.

**Request headers for custom connectors (documented, checked 2026-10-17)**
- In the add-connector dialog, choose **No sign-in** and add up to four request headers.
- `authorization`, `x-api-key` and `x-auth-token` are accepted as header names without review.
- Values are stored encrypted and never shown again after saving.
- They are sent on every request to the server, exactly as entered. No `Bearer ` prefix is added.
- They can't be edited. To rotate one, remove the connector and add it again.
- The feature is in beta and available to a limited set of organizations.
- Anthropic recommends header authentication for a fixed credential.
- Requests come from Anthropic's backend, from the stable outbound range `160.79.104.0/21`. That range is shared by every Anthropic user. Widget-initiated tool calls are proxied through the same backend.

**Not documented (measured on 2026-10-17, see Validation)**
- Whether widget-initiated `tools/call` and `resources/read` requests carry the headers.
- How claude.ai reacts to a 401 or 403 from a "No sign-in" connector.

**Why OAuth ([0002](0002-single-user-owner-password-oauth.md)) was dropped**
- 0002 relied on `@cloudflare/workers-oauth-provider` and KV. On Vercel ([0008](0008-vercel-hobby.md)) the server would need its own authorization server (metadata, client registration, an authorize page, token issuing and refresh rotation) plus a token store such as Redis. That is another vendor, another quota and much more code.
- A single-user deployment doesn't need per-user identity. A static secret that never expires also avoids re-authentication entirely.

## Decision

**Setup**
- At deploy time, generate a 256-bit random secret, for example with `openssl rand -base64 32`.
- Store it as the encrypted environment variable `CONNECTOR_SECRET`, and keep a copy in a password manager.
- In claude.ai, add a custom connector:
  - URL: `https://<project>.vercel.app/mcp`;
  - authentication: **No sign-in**;
  - request header: `Authorization` = `Bearer <secret>`.

**Checking the secret**
- Every request to `/mcp` is checked before the MCP handler runs.
- The server accepts `Authorization: Bearer <secret>`, and also the bare secret without the prefix, because claude.ai sends the value exactly as entered.
- Both the presented value and `CONNECTOR_SECRET` are hashed with SHA-256, and the digests are compared with `crypto.timingSafeEqual`.
- **Fail closed.** If `CONNECTOR_SECRET` (or `CRON_SECRET`) is missing, or shorter than 32 characters after trimming, configuration loading fails and the server answers nothing but errors. An empty or unset secret can never match an empty header.
- Headers are never logged. The secret never appears in URLs, logs, tool results or the repo.

**Rejected requests**
- A missing or wrong secret gets `401` with no `WWW-Authenticate` header and a generic JSON body with no detail.
- 401 is chosen over 403 because it gives a smoother first-time setup (see Validation).

**Rotation**
- Set a new `CONNECTOR_SECRET` and redeploy.
- In claude.ai, remove the connector and add it again with the new value.

**Scope**
- Only `/mcp` uses the connector secret.
- `/cron/cleanup` checks `CRON_SECRET` instead ([0010](0010-vercel-blob-storage.md)).
- A direct-POST upload fallback, if it is ever built, would key its token from `CONNECTOR_SECRET` ([0006](0006-photo-uploads.md)). It is not built, and nothing serves `/upload`.
- Image URLs are capability URLs and need no secret ([0010](0010-vercel-blob-storage.md)).
- Nothing else is exposed.

**Not in v1**
- Restricting `/mcp` to `160.79.104.0/21`. Because the range is shared by every Anthropic user, it would only narrow the attack surface, not authenticate.

## Consequences

- No OAuth code, no token store and no extra vendor. Sign-in never expires.
- Deployers need claude.ai's Request headers feature. Those without it can't use litho-mcp until it is generally available; the README says so up front. If the feature goes away, OAuth has to come back, and 0002 records one way to do it.
- Rotating the secret means removing and re-adding the connector, because header values can't be edited. After the redeploy, the old connector fails at once.
- If the secret leaks, the damage is bounded:
  - someone can spend OpenRouter credit up to the key's spending limit;
  - they can't get the API key itself;
  - rotating the secret ends their access.
- A leaked secret also allows free writes. `upload_image_data` accepts any well-formed `up_` id, and its app-only visibility is a host convention, not a server check. Enough uploads can exhaust Blob's operation or storage quota and pause Blob ([0010](0010-vercel-blob-storage.md)) without any OpenRouter spend. Rotating the secret ends this too.
- There is no second factor, the same trade-off as 0002's owner password. A 256-bit secret can't be guessed online.
- Rejected requests still count as function invocations, so a flood could use up the Hobby allowance and pause the service ([0008](0008-vercel-hobby.md)). This affects availability only.
- When a connector is added, claude.ai first sends an `initialize` probe without the configured headers, so a server that enforces the secret always rejects it. The server must tolerate that rejection, and the add flow must not depend on the probe succeeding.

## Validation (2026-10-17, Vercel)

Tested on claude.ai web (macOS Safari), Claude desktop (macOS) and the Claude iOS app (iOS 18.7).

- **Header delivery:** the `Authorization: Bearer <secret>` header reached the server on model-initiated `tools/call`, widget-initiated `tools/call` and `resources/read`, on all three platforms. claude.ai sends the value exactly as entered, including the `Bearer ` prefix the user typed.
- **Add-time probe:** when a connector is added, claude.ai first sends an `initialize` (2025-11-25) that carries none of the configured headers, so an enforcing server always rejects it.
- **Response `401` without `WWW-Authenticate`:** after the rejected probe, claude.ai looks for OAuth metadata (`GET /.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`). All returned 404, served statically in production, so they cost no function invocation. The add then completes directly with "No sign-in" and the header, and a connector with the correct secret works normally.
- **Response `403`:** no OAuth lookup, but the add dialog shows "Couldn't check the server - Couldn't determine how this server signs in" and requires "Continue anyway". After that, a correct secret works.
- **Wrong or missing secret, either status:** claude.ai shows "Connection issue" messages, including one saying the connector was set up as not requiring sign-in but the server asked for sign-in (status 401 or 403), and retries `initialize` before giving up. A misconfigured connector is therefore visible to the user.
- **Decision:** `401` with no `WWW-Authenticate` and a generic JSON body.

## Validation (2026-10-18 and 2026-10-19, acceptance)

Checked on the production deployment from claude.ai web.

- **Adding the connector:** with No sign-in and an `Authorization: Bearer <secret>` request header, the add completed directly, with no "Continue anyway" step. claude.ai shows a warning when No sign-in is chosen.
- **Request log during the add:** a header-less `POST /mcp` answered `401` (user agent python-httpx), and three `/.well-known/oauth-*` requests got Vercel's static `404`.
- **Rotation:** after the secret was replaced and the project redeployed, the old connector's calls got `401` and claude.ai showed "This connector's stored credential was rejected". Removing the connector and adding it again with the new value restored service, and `list_models` listed 61 models.
