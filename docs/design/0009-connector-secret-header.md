# 0009. Authenticate with a connector secret in a request header

- Status: Accepted. Supersedes [0002](0002-single-user-owner-password-oauth.md).
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

**Not documented**
- Whether widget-initiated `tools/call` and `resources/read` requests carry the headers. They are expected to, since the host proxies them.
- How claude.ai reacts to a 401 or 403 from a "No sign-in" connector. A 401 might start OAuth discovery.

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
- A missing or wrong secret gets an error with no detail.
- Whether that error is `401` without `WWW-Authenticate`, or `403`, is decided by how claude.ai behaves under "No sign-in" on the Vercel validation deployment (Phase 0b).

**Rotation**
- Set a new `CONNECTOR_SECRET` and redeploy.
- In claude.ai, remove the connector and add it again with the new value.

**Scope**
- Only `/mcp` uses the connector secret.
- `/cron/cleanup` checks `CRON_SECRET` instead ([0010](0010-vercel-blob-storage.md)).
- The fallback upload token is keyed from `CONNECTOR_SECRET` ([0006](0006-photo-uploads.md)).
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
- There is no second factor, the same trade-off as 0002's owner password. A 256-bit secret can't be guessed online.
- Rejected requests still count as function invocations, so a flood could use up the Hobby allowance and pause the service ([0008](0008-vercel-hobby.md)). This affects availability only.
- **To confirm in Phase 0b:**
  - the header reaches the server on model-initiated `tools/call`, widget-initiated `tools/call` and `resources/read` (logging presence only, never values);
  - claude.ai's reaction to `401` versus `403` for a missing or wrong secret.
