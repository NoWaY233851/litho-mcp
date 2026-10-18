# 0010. Store images in a public Vercel Blob store; delete after 30 days

- Status: Accepted. Supersedes [0004](0004-image-storage-and-delivery.md). Validated on web, desktop and iOS on 2026-10-17.
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
- sharp's prebuilt Linux binaries and libvips add about 19 MB. No official Vercel doc covers sharp in plain (non-Next.js) Functions, and community reports mention binding failures. sharp 0.35.0 and 0.35.1 are known to fail on Vercel because libvips isn't traced into the function; 0.35.3 and later fix it.

**Options considered**
- **Vercel Blob, public store**: no extra vendor, a hard cap, and the browser loads images without calling the function.
- **Cloudflare R2 through its S3 API**: storage would stay common with the Cloudflare path, with 10 GB free and lifecycle rules. But it needs a payment card and has no hard spending cap.
- **Tigris**: another vendor and account to manage.
- **A private Blob store served through the function**: every image view would cost function invocations and time.

## Decision

**Storage** (`ImageStore` on a public Vercel Blob store)
- Generated images live at `img/<hex>` and uploads at `up/<hex>`. Ids are `img_<hex>` and `up_<hex>`, where `<hex>` is 32 hex characters from 128 random bits.
- Objects are written with `put(pathname, bytes, { access: "public", contentType, addRandomSuffix: false, allowOverwrite, cacheControlMaxAge })`:
  - `contentType` is always set explicitly, from the detected format;
  - `allowOverwrite` is true only for `up/`, because a re-upload replaces the photo. Generated images are never overwritten;
  - `cacheControlMaxAge` is 60 for `up/` objects. `img/` objects keep the default cache lifetime, since they never change.
- Only PNG, JPEG and WebP are stored, detected by magic bytes.
- **No per-object metadata.** Width, height and type are re-read from the bytes when needed. Model, cost and parent are known at call time and go into the tool result text. The prompt isn't stored.

**Full-size delivery**
- The widget and the links in tool results use the object's public Blob URL directly. The 128-bit path makes it unguessable, for the reasons in 0004.
- Blob's own response headers provide `default-src 'none'`, `nosniff`, `X-Frame-Options: DENY` and inline disposition, so the function serves no image routes.
- The widget's CSP lists the wildcard `https://*.public.blob.vercel-storage.com` ([0005](0005-inline-display-mcp-apps.md)).
- The widget adds a cache-busting query when it shows or probes an `up/` URL. The Blob CDN ignores the query in its cache key, but browsers don't.

**Public base URL**
- The server needs the store's public base URL before anything is stored, because `upload_image` returns the URL a photo will get ([0006](0006-photo-uploads.md)).
- The base URL is `https://<store-id>.public.blob.vercel-storage.com`. The store id comes from `BLOB_STORE_ID` (with a `store_` prefix removed) when set, and otherwise from `BLOB_READ_WRITE_TOKEN`. It is always lowercased. Configuration loading fails if neither yields one.
- The token's store id is mixed case while hostnames returned by `put` are lowercase, so URL comparisons ignore host case.
- Vercel doesn't document the token format. The derivation was checked against real `put` results; if a future token format breaks it, `BLOB_STORE_ID` takes precedence.

**Retention**
- A daily Vercel Cron job calls `/cron/cleanup` with `Authorization: Bearer <CRON_SECRET>`. Other callers are rejected.
- The job lists `img/` and `up/` and deletes every object whose `uploadedAt` is older than `RETENTION_DAYS` (default 30).
- Images can outlive the retention period by up to one day plus the cron's timing slack.

**Thumbnails for Claude** (`Thumbnailer` on sharp)
- WebP at quality about 75, 1024 px on the long edge.
- The base64 budget is about **300,000 characters**, raised from 0004's 100,000 because of the Phase 0 results above.
- If the result is over budget, step down to 768 px and then 512 px. If thumbnailing fails, the result carries text only.
- sharp is pinned at 0.35.3 or later (0.35.5 was validated). The Blob SDK's `putImage` with `optimizeImage` remains an alternative behind the same interface if sharp stops working on Vercel.

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
- An edit started within about 60 seconds of replacing an uploaded photo may still read the previous photo, because overwrites can take up to 60 seconds to propagate and browsers cache the object for its cache lifetime. This is accepted.
- `BLOB_READ_WRITE_TOKEN` can arrive as a plain (non-secret) environment variable when the store is created from the CLI, so setup must store it as a Secret. Connecting the store from the dashboard is documented to add `BLOB_STORE_ID` and an OIDC token instead; that path is untested.
- The way back to Cloudflare is an R2 `ImageStore` and an Images-binding `Thumbnailer` behind the same interfaces.

## Validation (2026-10-17, Vercel)

Tested on claude.ai web (macOS Safari), Claude desktop (macOS) and the Claude iOS app (iOS 18.7).

- **Widget images:** a public Blob URL loads in the widget `<img>` on all three platforms, so no `get_image_data` fallback is needed. The CSP wildcard is honored (web and desktop echo it in `hostCapabilities.sandbox.csp`; iOS doesn't report `sandbox` but loads the image). The exact store host also works. The wildcard is the decision.
- **Thumbnail:** sharp 0.35.5 (libvips 8.18.7) loads in a plain Vercel Function, with a cold load of about 135-185 ms. A 1024 px WebP at quality 75 of a deliberately noisy 1536x1024 sample was 209,174 bytes, or 278,900 base64 characters, inside the 300,000 budget, and took 175-272 ms. The CPU of a whole generate-like request is in [0008](0008-vercel-hobby.md).
- **Credentials:** creating the store with `vercel blob create-store <name> --access public --yes` set only `BLOB_READ_WRITE_TOKEN`, as a plain (non-secret) variable, in Production, Preview and Development. It set no `BLOB_STORE_ID`. Vercel's docs say connecting a store from the dashboard adds `BLOB_STORE_ID` and an OIDC token instead; that was not tested. The SDK resolves an explicit token first, then OIDC (which needs `BLOB_STORE_ID`), then `BLOB_READ_WRITE_TOKEN`.
- **Base URL:** the rule under Public base URL above follows from these results. The token's store id is mixed case while hostnames returned by `put` are lowercase.
- **Caching:** the Blob CDN ignores query strings in its cache key, and 404s aren't cached. Per Vercel's docs, overwrites and deletes can take up to 60 seconds to propagate through the CDN, and browsers keep their own copy for the object's cache lifetime (by default up to a month). Right after an upload or overwrite, probes of the same URL sometimes returned the previous object or a miss, while a cache-busting query always returned the current object in the browser. Hence the 60-second lifetime on `up/` objects and the widget's cache-busting query.
