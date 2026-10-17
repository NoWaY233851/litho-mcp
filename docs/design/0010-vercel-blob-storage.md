# 0010. Store images in a public Vercel Blob store; delete after 30 days

- Status: Accepted. Supersedes [0004](0004-image-storage-and-delivery.md).
- Date: 2026-10-17

## Context

The needs behind [0004](0004-image-storage-and-delivery.md) still hold:

- edits need the source image again, so images persist between calls;
- the full image can't travel inside the tool result;
- Claude understands follow-up edits better when it sees a thumbnail;
- full-size images are delivered through unguessable capability URLs. 0004 explains why the id itself is the credential, with no signature or separate expiry.

Moving to Vercel ([0008](0008-vercel-hobby.md)) removes R2, its lifecycle rules and the Images binding.

**Vercel Blob, public store (checked 2026-10-17)**
- Hobby limits: 1 GB of storage; per month, 10k simple and 2k advanced operations and 10 GB of transfer; 20 simple and 15 advanced operations per second.
- Over a limit, Blob access stops for 30 days. It is never billed.
- URLs look like `https://<store-id>.public.blob.vercel-storage.com/<pathname>`.
- Every response carries `Content-Security-Policy: default-src 'none'`, `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`. Images are served `inline`.
- `Content-Type` is whatever `put` was given.
- There is no per-object custom metadata, and no TTL or lifecycle feature. Deletes are free. `list` is an advanced operation.

**Vercel Cron on Hobby**
- Daily jobs only, with timing precision of plus or minus 59 minutes.
- When `CRON_SECRET` is set, Vercel calls the path with `Authorization: Bearer <CRON_SECRET>`.

**Thumbnails**
- A tool result is documented as holding about 150,000 characters, which is why 0004 capped thumbnails at 100,000 base64 characters.
- Phase 0 (2026-10-16) showed more room in practice. On web, image blocks with long edges from 512 to 1536 px (up to about 0.6M base64 characters) rendered and were visible to Claude. iOS rendered a 1024 px result of about 299k characters.
- sharp's prebuilt Linux binaries and libvips add about 19 MB. No official Vercel doc covers sharp in plain (non-Next.js) Functions, and community reports mention binding failures.

**Options considered**
- **Vercel Blob, public store**: no extra vendor, a hard cap, and the browser loads images without calling the function.
- **Cloudflare R2 through its S3 API**: storage would stay common with the Cloudflare path, with 10 GB free and lifecycle rules. But it needs a payment card and has no hard spending cap.
- **Tigris**: another vendor and account to manage.
- **A private Blob store served through the function**: every image view would cost function invocations and time.

## Decision

**Storage** (`ImageStore` on a public Vercel Blob store)
- Generated images live at `img/<hex>` and uploads at `up/<hex>`. Ids are `img_<hex>` and `up_<hex>`, where `<hex>` is 32 hex characters from 128 random bits.
- Objects are written with `put(pathname, bytes, { access: "public", contentType, addRandomSuffix: false, allowOverwrite })`:
  - `contentType` is always set explicitly, from the detected format;
  - `allowOverwrite` is true only for `up/`, because a re-upload replaces the photo. Generated images are never overwritten.
- Only PNG, JPEG and WebP are stored, detected by magic bytes.
- **No per-object metadata.** Width, height and type are re-read from the bytes when needed. Model, cost and parent are known at call time and go into the tool result text. The prompt isn't stored.

**Full-size delivery**
- The widget and the links in tool results use the object's public Blob URL directly. The 128-bit path makes it unguessable, for the reasons in 0004.
- Blob's own response headers provide `default-src 'none'`, `nosniff`, `X-Frame-Options: DENY` and inline disposition, so the function serves no image routes.
- The widget's CSP lists the Blob store host ([0005](0005-inline-display-mcp-apps.md)).

**Retention**
- A daily Vercel Cron job calls `/cron/cleanup` with `Authorization: Bearer <CRON_SECRET>`. Other callers are rejected.
- The job lists `img/` and `up/` and deletes every object whose `uploadedAt` is older than `RETENTION_DAYS` (default 30).
- Images can outlive the retention period by up to one day plus the cron's timing slack.

**Thumbnails for Claude** (`Thumbnailer` on sharp)
- WebP at quality about 75, 1024 px on the long edge.
- The base64 budget is about **300,000 characters**, raised from 0004's 100,000 because of the Phase 0 results above.
- If the result is over budget, step down to 768 px and then 512 px. If thumbnailing fails, the result carries text only.
- If sharp doesn't work on Vercel, the Blob SDK's `putImage` with `optimizeImage` takes its place behind the same interface.

**Tool results**
- Unchanged from 0004, except that the link is the Blob URL and nothing comes from stored metadata.
- `structuredContent` for the widget: `{ kind: "image", id, url, width, height, mime, model, aspect_ratio, cost_usd, parent? }`.

## Consequences

- Viewing an image never calls the function, so it costs no invocations or Active CPU.
- A 1 GB store with 30-day retention holds roughly 300–500 images, far above personal use. An overrun locks Blob for 30 days but is never billed. The README says so.
- Retention is now this project's code rather than a storage feature. If the cron stops running, images are kept longer. The period changes through `RETENTION_DAYS`, not a storage CLI command.
- Without metadata, the server can't report an old image's model or cost. Claude finds them in the earlier tool result.
- Anyone holding a link can view that image until it is deleted, and links can't be revoked early. The README says so.
- The thumbnail budget relies on observed behavior above the documented result limit. If claude.ai starts enforcing that limit for image blocks, lower the budget; the step-down path already exists.
- The way back to Cloudflare is an R2 `ImageStore` and an Images-binding `Thumbnailer` behind the same interfaces.
- **To verify in Phase 0b:**
  - a Blob public URL loads in the widget's `<img>`. If it doesn't, a widget-only `get_image_data` tool returning base64 is the fallback; Phase 0 showed an uncapped widget-only result of about 299k characters reaches the widget;
  - whether claude.ai honors the wildcard `https://*.public.blob.vercel-storage.com` in the CSP, or needs the exact store host;
  - how the server learns the store's public base URL before anything is stored, which a pre-assigned upload id's URL needs ([0006](0006-photo-uploads.md)): an SDK call, an environment variable set by the Blob integration, or a one-time `put`;
  - that sharp loads, and the thumbnail's size, time and memory.
