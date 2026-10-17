# 0006. Upload photos through the widget

- Status: Accepted. Revised on 2026-10-16 after platform validation on web and iOS; desktop and Android are still pending.
- Date: 2026-10-16

## Context

Users want to edit their own photos as well as generated images. A photo attached to a claude.ai message can't be handed to an MCP tool:

- Claude can look at the photo, but it can't reproduce the photo's bytes as a tool argument.
- MCP tools never receive chat attachments.

Options considered:

1. **An upload button inside the MCP Apps widget**:
   - It uses the platform's own photo picker.
   - The widget can call a widget-only tool, or `POST` directly to the Worker.
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
   - It returns the id in its text and in `structuredContent: { kind: "upload", id }`.
   - It opens the widget in upload mode.
   - Because the id is in the tool result from the start, Claude already knows it. Nothing has to be sent back from the widget.
2. **On mount**, the widget checks whether `/img/<id>` exists:
   - if it does, it shows the uploaded photo;
   - otherwise it shows one "Choose photo" button: `<input type="file" accept="image/png,image/jpeg,image/webp">`.

   This lets the widget's state survive page reloads and device switches.
3. **In the browser**:
   - decode the photo with `createImageBitmap`;
   - scale it to at most 2048 px on the long edge;
   - re-encode it as JPEG at quality 0.9.

   This shrinks the upload and **strips EXIF, including GPS location**. The preview comes from that output, not from the file input.
4. **Transport.** The bytes go to the widget-only tool `upload_image_data({ id, data })`, which reuses the connector's existing session.
   - A direct `POST /upload` with a short-lived token bound to the id also works. It is kept only as a fallback.
5. **The server** accepts only ids matching `^up_[0-9a-f]{32}$`, applies the same checks as reference URLs ([0007](0007-reference-urls-ssrf.md)), and stores the photo under that id:
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
- **Size ceiling:** `@modelcontextprotocol/server` 2.x caps MCP request bodies at 4 MiB. A 2048 px JPEG stays well under it.
- **Direct `POST`:** it also worked from the widget's sandbox origin (`https://<32 hex>.claudemcpcontent.com`).
- **The iOS picker:**
  - converts HEIC to JPEG on pick;
  - decodes ProRAW DNG;
  - handles 48 MP photos (6048×8064), which scale to about 0.6–1.2 MB of JPEG.
  - The file input's own thumbnail rendered black for such a photo, which is why the preview comes from the re-encoded output.
- **`ui/update-model-context`:** its contents disappeared after a page reload.
- **Not yet tested:** desktop and Android, including the Android WebView file picker.

## Consequences

- Uploading takes one extra step compared with attaching a photo: ask Claude to open the uploader.
- Photos never carry location metadata to the server.
- The upload id appears in the conversation before the photo exists, so Claude may try to edit too early. The `edit_image` error covers this case.
- An unused pre-assigned id costs nothing, because no object is written until upload.
