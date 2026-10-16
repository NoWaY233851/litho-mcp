# 0004. Store images in R2 behind unguessable URLs; delete after 30 days

- Status: Accepted
- Date: 2026-10-16

## Context

**What has to be delivered**
- Edits need the source image again, so images must persist between calls.
- A claude.ai tool result is limited to about 150,000 characters, and a single full-size PNG of a few MB is larger than that once base64-encoded. So the full image can't travel inside the tool result.
- Claude still benefits from seeing the result. It understands "change step 3" better when it can see the image.

**Cloudflare facts**
- R2 free tier: 10 GB-month, 1M Class A ops and 10M Class B ops per month, no egress fees, and lifecycle rules for day-granular expiry.
- The Images binding resizes images outside the Worker's CPU budget. The Free plan includes 5,000 unique transformations per month. Past that, new transformations fail with error 9422 and are **not charged**.

## Decision

**Storage**
- Generated images live at `img/<hex>` and uploads at `up/<hex>`. Ids are `img_<hex>` / `up_<hex>`, from 128 random bits.
- Custom metadata holds:
  - width, height and creation time;
  - model, parent id and cost;
  - the prompt, URI-encoded and truncated to 500 characters.
- Only PNG, JPEG and WebP are stored, detected by magic bytes.

**Retention**
- R2 lifecycle rules delete `img/` and `up/` objects after **30 days**.
- Deployers set or change this with `wrangler r2 bucket lifecycle`.

**Full-size delivery**
- Full-size images are served at `GET /img/<id>`:
  - the unguessable id *is* the credential, with no signature or separate expiry;
  - links work for as long as the image exists;
  - the response sets the real `Content-Type`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=86400` and `Content-Security-Policy: default-src 'none'`;
  - CORS allows `https://*.claudemcpcontent.com`;
  - `Referer` isn't checked, because iOS WebKit doesn't send it;
  - deleted images return 404.

**Tool results**
`generate_image` and `edit_image` return:
- A thumbnail for Claude:
  - WebP from the Images binding at 1024 px on the long edge;
  - stepped down to 768 or 512 px if the base64 exceeds 100,000 characters;
  - omitted if resizing fails, including on error 9422.
- Text listing:
  - the new id;
  - the `/img/<id>` link;
  - the model;
  - the aspect ratio or size;
  - the cost;
  - for edits, the parent id.
- `structuredContent` for the widget.

**Versions**
- Each edit creates a new image that records its `parent`. Going back means editing from an earlier id; no separate tool is needed.

## Consequences

- Reopening a conversation within 30 days still shows its images. After that the widget says the image expired.
- Anyone holding a link can view that image until it expires. A link can leak, for example through a shared conversation, and links can't be revoked early. The README says so.
- No signing key to manage. Storage stays small and self-cleaning.
- Claude may not see thumbnails reliably on every platform. Community reports are inconsistent, so this is checked during platform validation.
