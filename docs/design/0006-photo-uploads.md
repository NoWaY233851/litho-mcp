# 0006. Upload photos through the widget

- Status: Accepted. Revised on 2026-10-16 after platform validation on web and iOS, on 2026-10-17 for the move to Vercel, and on 2026-10-18 for the upload size ladder. Validated on web, desktop and iOS, including in acceptance on 2026-10-18 and 2026-10-19; Android is untested.
- Date: 2026-10-16

## Context

Users want to edit their own photos as well as generated images. A photo attached to a claude.ai message can't be handed to an MCP tool:

- Claude can look at the photo, but it can't reproduce the photo's bytes as a tool argument.
- MCP tools never receive chat attachments.

Options considered:

1. **An upload button inside the MCP Apps widget**:
   - It uses the platform's own photo picker.
   - The widget can call a widget-only tool, or `POST` directly to the server.
2. **Relaying the attachment through Claude's code-execution sandbox**:
   - Claude would `POST` the file to a one-time URL.
   - This needs code execution enabled and the domain allowlisted.
   - Whether attachments appear in the sandbox wasn't verified.
3. **A separate, signed-in upload page**: it always works, but it leaves the conversation and adds another surface to maintain.

The widget also has to get the new image's id to Claude. The MCP Apps host offers two ways, and validation found problems with both:

- **`ui/update-model-context`**: the context is held per widget and is **lost when the page reloads**.
- **`ui/message`**: it only prefills the user's message box, under a "Use caution before running this prompt" warning.

## Decision

**The upload flow**
1. **`upload_image`** (no arguments) pre-assigns the id the photo will get, `up_<32 hex>`, without writing anything.
   - It returns the id in its text and in `structuredContent: { kind: "upload", id, url }`, where `url` is the public Blob URL the photo will have ([0010](0010-vercel-blob-storage.md)).
   - It opens the widget in upload mode.
   - Because the id is in the tool result from the start, Claude already knows it. Nothing has to be sent back from the widget.
2. **On mount**, the widget probes that URL with an `<img>` load:
   - if it loads, it shows the uploaded photo, "Uploaded" and "Replace photo". After a successful replacement it also says Claude can use the new photo in about a minute; a first upload shows no note;
   - otherwise it shows one "Choose photo" button: `<input type="file" accept="image/png,image/jpeg,image/webp">`. The native input stays hidden behind the widget's own button, and only the widget's preview is shown.

   The probe adds a cache-busting query to the URL, because the upload object is cached for only a short time ([0010](0010-vercel-blob-storage.md)).

   This lets the widget's state survive page reloads and device switches.
3. **In the browser**:
   - decode the photo with `createImageBitmap`;
   - scale it to at most 2048 px on the long edge;
   - re-encode it as JPEG at quality 0.9.

   If the result is too big for the transport (see the size ladder under Revision 2026-10-18), the widget retries with lower settings.

   This shrinks the upload and **strips EXIF, including GPS location**. The preview comes from that output, not from the file input. If the browser can't decode the file, the widget says so and suggests JPEG, PNG or WebP.
4. **Transport.** The bytes go to the widget-only tool `upload_image_data({ id, data })`, which travels through the connector like any other tool call and needs no separate credential. This was confirmed on Vercel.
   - A direct `POST /upload` with a short-lived token bound to the id worked from the widget's sandbox origin in validation. It is a recorded fallback only and is not built: nothing serves `/upload`.
   - The recorded design is a 10-minute HMAC token bound to the id, keyed from `CONNECTOR_SECRET` ([0009](0009-connector-secret-header.md)) with a fixed label, so no extra secret would be needed.
5. **The server** accepts only ids matching `^up_[0-9a-f]{32}$`, applies the same checks as reference URLs ([0007](0007-reference-urls-ssrf.md)), and stores the photo at `up/<hex>`:
   - PNG, JPEG or WebP, by magic bytes;
   - at most 10 MiB;
   - at most 8192 px per side.

   A re-upload to the same id replaces the photo.
6. **`edit_image`**: if nothing is stored under an `up_` id, the error says the photo hasn't been uploaded yet or has expired.

**Failure handling**
- If the file picker doesn't work on some platform, users upload from a computer instead. Conversations sync across devices and images are stored by id, so they can keep editing on the phone.
- The `upload_image` description tells Claude to suggest this.

**Rejected options**
- Options 2 and 3 are rejected for simplicity.
- `ui/update-model-context` and `ui/message` are rejected for passing the id, for the reasons in Context.

## Validation (2026-10-16, claude.ai web and iOS app)

- **Arguments:** the widget-only tool received 1 MB and 3 MB base64 arguments on web (1.6–1.7 s) and iOS (0.75–1.1 s).
- **Size ceiling:** `@modelcontextprotocol/server` 2.x caps MCP request bodies at 4 MiB. The 2048 px JPEGs tested stayed well under it; the ladder in the 2026-10-18 revision covers detail-rich photos that do not.
- **Direct `POST`:** it also worked from the widget's sandbox origin (`https://<32 hex>.claudemcpcontent.com`).
- **The iOS picker:**
  - converts HEIC to JPEG on pick;
  - decodes ProRAW DNG;
  - handles 48 MP photos (6048×8064), which scale to about 0.6–1.2 MB of JPEG.
  - The file input's own thumbnail rendered black for such a photo, which is why the preview comes from the re-encoded output.
- **`ui/update-model-context`:** its contents disappeared after a page reload.
- **Not tested then:** desktop and Android. Desktop was covered on 2026-10-17 (below).

## Validation (2026-10-17, Vercel)

Tested on claude.ai web (macOS Safari), Claude desktop (macOS) and the Claude iOS app against a throwaway Vercel deployment.

- **Transport (decision confirmed):** `upload_image_data({ id, data })` carried 1 MB and 3 MB base64 arguments through Vercel on web (695 / 1,170 ms), desktop (726 / 1,344 ms) and iOS (736 / 1,336 ms). Both are below the SDK's 4 MiB cap and Vercel's 4.5 MB body cap. The direct-POST fallback was not needed and is not built.
- **Real photos:** a 40 MB PNG (web), a 48 MP iPhone photo and a ProRAW DNG (iOS) and a JPEG (desktop) were each scaled to at most 2048 px and re-encoded as JPEG at 0.9, giving 0.1-1.2 MB.
- **State across reloads:** after a page reload, the widget's mount probe found the uploaded photo.
- **Undecodable formats:** iOS converts HEIC to JPEG when picked and decodes ProRAW DNG. The desktop app (Chromium) can't decode DNG ("The source image could not be decoded") and probably not HEIC, and its file dialog offered the DNG despite the `accept` list. The widget therefore reports undecodable formats clearly and suggests JPEG, PNG or WebP.
- **Native file input:** on iOS its own thumbnail is black for some photos while the widget's canvas preview is correct, so the widget hides the native input behind its own button.
- **Android:** not tested (no device), including the Android WebView file picker.

## Validation (2026-10-18 and 2026-10-19, acceptance)

Tested on the production deployment from claude.ai web (macOS, Chrome), Claude desktop (macOS) and the Claude iOS app. The first test was `upload_image` and picking a photo, which costs nothing.

- **Upload:** picking a photo in the widget works on all three. On iOS the button opens the photo library and the preview is not black, and portrait photos upload upright.
- **Undecodable format:** on desktop, a DNG shows "This device can't read this photo's format. Choose a JPEG, PNG or WebP, or export the photo first."
- **Size ladder:** a detail-rich 48 MP iPhone photo uploaded, which exercises the step-down.
- **Replace photo:** the new photo displays at once, and an edit requested later used it. The delay of about a minute is the CDN propagation described in the 2026-10-17 revision.
- **Replace note (fixed 2026-10-19):** the widget did not mention that delay. The note was verified on web (English) and iOS (zh-TW).
- **Upload then edit:** `edit_image` with the `up_` id worked on all three on 2026-10-18, and again on 2026-10-19 on the final deployment.
- **Android:** not tested (no device).

## Consequences

- Uploading takes one extra step compared with attaching a photo: ask Claude to open the uploader.
- Photos never carry location metadata to the server.
- The upload id appears in the conversation before the photo exists, so Claude may try to edit too early. The `edit_image` error covers this case.
- An unused pre-assigned id costs nothing, because no object is written until upload.

## Revision (2026-10-17)

- The server-side steps are now worded for any host, after the move to Vercel ([0008](0008-vercel-hobby.md)). Photos are stored in the Blob store at `up/<hex>` ([0010](0010-vercel-blob-storage.md)).
- The recorded direct-POST fallback token was keyed from the owner password. That password went away with OAuth, so its key would now be derived from `CONNECTOR_SECRET` ([0009](0009-connector-secret-header.md)).
- On mount, the widget probes the upload id's public Blob URL instead of `/img/<id>`, and `upload_image` returns that URL. The server builds the URL from the store id taken from its Blob credentials, as described in [0010](0010-vercel-blob-storage.md), so it knows the URL before the first write. Host names compare case-insensitively.
- Vercel caps non-streamed function bodies at 4.5 MB. That is above the 4 MiB MCP cap, so the MCP cap still sets the ceiling.
- Widget-initiated tool calls carry the connector's request header ([0009](0009-connector-secret-header.md)).
- Photos are stored with a 60-second cache lifetime and the widget adds a cache-busting query when it shows or probes them. An edit started within about 60 seconds of replacing a photo may still read the previous photo. This is accepted ([0010](0010-vercel-blob-storage.md)).

## Revision (2026-10-18)

- **Upload size ladder.** The server rejects MCP request bodies over 4 MiB, and a detail-rich photo can exceed that as a 2048 px JPEG at quality 0.9. The widget therefore keeps the `data` argument at or under 4 MiB minus 64 KiB of base64 characters (the margin covers the JSON-RPC envelope). It re-encodes from the decoded image, never from a previous JPEG, and uses the first step that fits:
  1. 2048 px long edge, quality 0.9
  2. 2048 px, quality 0.8
  3. 2048 px, quality 0.7
  4. 1536 px, quality 0.8

  If no step fits, the widget reports that the photo is still too large after shrinking. The ladder is defined in `ui/lib.ts`.
- The server-side 10 MiB check on uploads is unchanged. It no longer limits the widget in practice, because the transport cap is lower, and stays as defense in depth for other callers.

## Revision (2026-10-19)

- The widget now shows a note after a replacement, because an overwrite can take up to about 60 seconds to reach the Blob CDN ([0010](0010-vercel-blob-storage.md)).
