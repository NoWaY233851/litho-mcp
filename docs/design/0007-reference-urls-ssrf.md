# 0007. Fetch reference URLs ourselves, behind SSRF checks

- Status: Accepted
- Date: 2026-10-16

## Context

`edit_image` accepts public image URLs. OpenRouter can fetch URLs itself, but then this server can't enforce size or format limits. Fetching user-supplied URLs from the Worker brings SSRF risk.

Facts about Workers:

- `fetch()` can't target IP addresses directly.
- With `global_fetch_strictly_public`, requests to your own zone go out over the public internet instead of straight to the origin.
- A Worker isn't inside any private network.
- How `fetch()` behaves for hostnames that resolve to private addresses isn't documented.
- There's no way to pin a connection to an address checked beforehand, so DNS rebinding can't be ruled out completely.

## Decision

The Worker always fetches and validates reference images itself, then sends them to OpenRouter as data URLs. **User-supplied URLs are never forwarded.**

An image URL that points at this server (`<origin>/img/<id>`) is treated as that image id and read from R2 directly.

For any other URL, `fetchPublicImage` runs these steps:

1. **URL checks**
   - only `http:` or `https:`;
   - only ports 80 and 443;
   - no credentials in the URL;
   - the hostname is not an IP literal, in any notation, after WHATWG normalization;
   - the hostname is not `localhost` and doesn't end in `.local`, `.internal` or `.localhost`.
2. **DNS checks**
   - Resolve A and AAAA records through DoH (`https://cloudflare-dns.com/dns-query`).
   - Reject if any answer falls in one of these ranges:

     | Range | Addresses |
     |---|---|
     | Private (RFC 1918) | 10/8, 172.16/12, 192.168/16 |
     | Loopback | 127/8, ::1 |
     | Link-local | 169.254/16, fe80::/10 |
     | CGNAT | 100.64/10 |
     | "This network" | 0/8 |
     | Unique local | fc00::/7 |
     | Multicast | 224/4, ff00::/8 |
     | Reserved and documentation | 240/4, 192.0.2/24, 198.18/15, 2001:db8::/32, and others |
     | Translated IPv6 | NAT64 64:ff9b::/96; IPv4-mapped addresses are checked against their embedded IPv4 address |
3. **Redirects**
   - `redirect: "manual"`;
   - at most 3 hops;
   - steps 1–2 run again on every hop.
4. **Limits**
   - one 15-second timeout covers the whole fetch;
   - `Content-Length` is checked first, then bytes are counted while streaming;
   - the fetch aborts past 10 MiB.
5. **Content**
   - the format is detected from magic bytes (PNG, JPEG, WebP only), ignoring `Content-Type`;
   - neither side may exceed 8192 px.

Each failure has a specific reason that is reported back to Claude.

## Consequences

- The size and format limits apply to every reference image, whatever its source.
- One DoH lookup per address family, plus at most 3 redirect hops, all fit within the Free plan's 50 subrequests per call.
- **Residual risk:** DNS rebinding between the check and the connection. The impact is limited because a Worker has no private network to reach. The README states this.
- Large references cost Worker CPU for base64 encoding. This is covered by the same measurement as [0001](0001-cloudflare-workers.md).
