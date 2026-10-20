# 0007. Fetch reference URLs ourselves, behind SSRF checks

- Status: Accepted. Revised on 2026-10-17 for Node on Vercel ([0008](0008-vercel-hobby.md)). Validated on web in acceptance on 2026-10-18 and 2026-10-19.
- Date: 2026-10-16

## Context

`edit_image` accepts public image URLs. OpenRouter can fetch URLs itself, but then this server can't enforce size or format limits. Fetching user-supplied URLs from the server brings SSRF risk.

Facts about the Node.js runtime on Vercel:

- Vercel documents no outbound filtering, so the code must block private and loopback destinations itself.
- The Lambda runtime API underneath a Vercel function listens on 127.0.0.1, so loopback is a real target.
- `node:dns` resolves A and AAAA records directly.
- undici's `Agent` accepts a `connect.lookup` function, so a connection can be pinned to an address that was checked beforehand.

## Decision

The server always fetches and validates reference images itself, then sends them to OpenRouter as data URLs. **User-supplied URLs are never forwarded.**

A URL that points at this deployment's own Blob store (`<store host>/img/<hex>` or `<store host>/up/<hex>`, see [0010](0010-vercel-blob-storage.md)) is treated as that image id and read through `ImageStore`, with no network fetch.

For any other URL, `fetchPublicImage` runs these steps:

1. **URL checks**
   - only `http:` or `https:`;
   - only ports 80 and 443;
   - no credentials in the URL;
   - the hostname is not an IP literal, in any notation, after WHATWG normalization;
   - the hostname is not `localhost` and doesn't end in `.local`, `.internal` or `.localhost`.
2. **DNS checks and pinning**
   - Resolve A and AAAA records with `node:dns`.
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

   - Connect only to a validated address, through an undici `Agent` whose `connect.lookup` returns that address. The address that was checked is the address that is used.
   - Loopback stays blocked in particular, because the runtime API listens on 127.0.0.1.
3. **Redirects**
   - `redirect: "manual"`;
   - at most 3 hops;
   - steps 1–2 run again on every hop, including the pinning.
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
- Pinning closes the DNS-rebinding gap between the check and the connection. A unit test covers it, since a regression would silently reopen the gap.
- Large references cost Active CPU for base64 encoding, which counts against the Hobby allowance ([0008](0008-vercel-hobby.md)).

## Historical note: Cloudflare Workers (2026-10-16)

This ADR was first written for Cloudflare Workers ([0001](0001-cloudflare-workers.md)). There, `fetch()` couldn't target IP addresses directly, and `global_fetch_strictly_public` sent requests to the deployer's own zone over the public internet. A Worker isn't inside any private network. How `fetch()` behaved for hostnames resolving to private addresses wasn't documented, and a connection couldn't be pinned to a checked address.

So the DNS checks used DNS over HTTPS through Cloudflare's resolver, and DNS rebinding between the check and the connection remained a residual risk. It was accepted, and stated for deployers, because a Worker had no private network to reach. The lookups and up to 3 redirect hops fit within the Free plan's 50 subrequests per call.

## Revision (2026-10-17)

- The context and the DNS step now describe Node.js on Vercel. DNS is resolved with `node:dns` instead of DNS over HTTPS, and the connection is pinned to the validated address through undici's `connect.lookup`. This closes the rebinding gap that Workers left open.
- Blocking loopback matters more than before, because a Vercel function has a runtime API on 127.0.0.1.
- "This server's own image URL" now means this deployment's Blob store URL, not `<origin>/img/<id>`.
- The Workers-specific context moved to the historical note above.

## Revision (2026-10-20)

- All reference reads of one `edit_image` call, stored ids and URLs alike, share one 40 MiB budget. Each kept chunk is charged before it is held, and a download's declared length is charged up front, before its buffer is allocated.
- A budget failure is reported with the total-size message, not a per-URL reason.
- The loads stay parallel so one 15-second deadline covers them. Loading them one by one would stack the per-load deadlines.

## Validation (2026-10-18 and 2026-10-19, acceptance)

Tested on the production deployment from claude.ai web.

- **Public URL:** `edit_image` with a public reference URL worked. The URL first given was a Wikimedia file description page, so Claude found the original file's URL and passed that.
- **Own Blob URL:** `edit_image` with the image's own Blob URL instead of its id also worked, because the server maps its own Blob URLs back to the stored image.
