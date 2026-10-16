# 0002. Single user per deployment; OAuth with an owner password

- Status: Accepted
- Date: 2026-10-16

## Context

The server spends the deployer's OpenRouter credit, so it must not be open. Some earlier image MCP servers pass the API key in the connector URL's query string. That leaks the key into logs and history; Claude's own connector docs say never to accept credentials in query parameters.

What claude.ai custom connectors support:

**Sign-in options**
- no authentication;
- OAuth with Client ID Metadata Documents (CIMD);
- OAuth with dynamic client registration (DCR);
- a pre-registered OAuth client.

**When Claude uses CIMD**
- Claude uses CIMD only when the authorization-server metadata advertises `client_id_metadata_document_supported: true` and lists `"none"` in `token_endpoint_auth_methods_supported`.

**Protocol requirements**
- The callback is `https://claude.ai/api/mcp/auth_callback`.
- PKCE must be S256.
- Unauthenticated requests must get `401` with `WWW-Authenticate: Bearer resource_metadata=...`.
- The protected-resource metadata `resource` must equal the connector URL exactly.

**Refresh behavior**
- Claude refreshes tokens shortly before expiry and on a 401.

Each deployment has exactly one user, the person who deployed it.

Sign-in options considered:

- **GitHub (or another IdP) sign-in**:
  - You get 2FA.
  - But every deployer must create an OAuth app and manage two more secrets, and the code needs an upstream flow.
  - Cloudflare's GitHub template also had a weak allowlist, which only hid one tool.
- **Owner password**:
  - A long random password is generated at deploy time and stored as a secret.
  - The authorize page asks for it.
  - This is the least code and setup.
  - With about 190 bits of entropy, online guessing is infeasible, especially since the Free plan itself caps requests at 100,000 per day.
  - The cost is no second factor.

## Decision

**OAuth library and grants**
- Use `@cloudflare/workers-oauth-provider` (1.2.x) with CIMD enabled and DCR kept.
- Grants use `userId: "owner"`.

**Owner password**
- Sign-in is an **owner password**:
  - Generated with something like `openssl rand -base64 32` and stored with `wrangler secret put OWNER_PASSWORD`.
  - Human-chosen passwords aren't supported.
  - Input and secret are both trimmed of surrounding whitespace.
  - They are compared in constant time.
- The authorize page shows the client name and redirect host.
- It uses the library's consent helpers, which give a single-use, browser-bound handle, with `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- Error messages stay generic.

**Claude-only redirects**
- Allowed redirect URIs are exactly `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`.
- `EXTRA_REDIRECT_URIS` may add loopback URLs for local testing (MCP Inspector).
- The allowlist is checked at DCR registration, and in `/authorize` both after parsing the request and again before completing it. CIMD clients have no registration step, so `/authorize` is where they're checked.

**Instant revocation**
- Each grant stores `pwv`, the first 16 hex characters of `SHA-256(password)`.
- Every `/mcp` request and every refresh compares it with the current password.
- On mismatch, the grant is revoked and a 401 carrying `WWW-Authenticate` is returned.
- Rotating the password therefore signs every client out at once.

**Rare re-authentication**
- Access tokens last 1 hour.
- Refresh tokens rotate, with a 90-day sliding idle lifetime and no absolute expiry.

## Consequences

- One secret to manage. Keep the password in a password manager.
- If the password leaks, the damage is bounded:
  - someone can spend OpenRouter credit up to the key's spending limit;
  - they can view images until those images expire;
  - they can't get the API key itself.
  - Rotating the password ends every session.
- Claude Code and other clients using loopback redirects can't connect unless the deployer sets `EXTRA_REDIRECT_URIS`.
- Anyone can still hit `/authorize` and use up the Free plan's daily request quota. This affects availability only. On a custom domain, a free WAF rate-limiting rule mitigates it.
