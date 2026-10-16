# 0001. Run as one stateless Cloudflare Worker

- Status: Accepted
- Date: 2026-10-16

## Context

claude.ai connects to custom connectors from Anthropic's cloud. The server therefore needs to be:

- public HTTPS, reachable over IPv4;
- using Streamable HTTP (SSE is deprecated);
- free of redirects to other hosts, which would drop the `Authorization` header.

A tool call may take up to 240 seconds. Image generation through OpenRouter is synchronous: one documented call took 94 seconds, and there is no async or polling mode.

The project has to stay cheap and low-maintenance, and anyone should be able to deploy their own copy.

Options considered:

- **Cloudflare Workers**:
  - Free plan: 10 ms CPU per request and 100,000 requests per day; time spent waiting on I/O doesn't count as CPU.
  - Paid plan: $5/month.
  - No servers to patch, TLS and DDoS protection included, and the R2, KV and Images bindings are right next to it.
- **A small VPS**:
  - No CPU limits, and native image libraries are available.
  - But you have to patch the OS, manage TLS and firewalls, and keep the API key on disk.
  - Its public IP is exposed.
  - SSRF can reach `localhost` and the provider's internal network.
- **Stateful `McpAgent` (Durable Objects)** vs **stateless `createMcpHandler`**: Cloudflare has frozen `McpAgent`. `createMcpHandler` from `agents/mcp/server` is stateless and still serves 2025-era clients through its default `legacy: "stateless"` lane.

## Decision

- Run everything in **one Worker**:
  - the OAuth server;
  - the MCP endpoint (`createMcpHandler`, with a new `McpServer` per request);
  - the image route.
- No database:
  - R2 holds images;
  - KV holds OAuth data only.
- Start on the **Workers Free plan**. If measured CPU use doesn't fit, move to Workers Paid. Don't add any other usage-billed service without a hard cap.
- Compatibility flags: `nodejs_compat` and `global_fetch_strictly_public`.

## Consequences

- No servers to maintain. Deployment is `wrangler deploy` plus two secrets.
- CPU-heavy work has to stay out of the Worker:
  - image resizing goes to the Images binding;
  - photo resizing happens in the user's browser.
- Decoding the base64 image OpenRouter returns (several MB) is the one step that may not fit Free-plan CPU; it gets measured before deciding Free vs Paid.
- Long generations are fine, because waiting on `fetch` doesn't use CPU.
- A self-hosted or VPS variant is out of scope. Porting would mean rewriting the OAuth, storage and secret layers.
