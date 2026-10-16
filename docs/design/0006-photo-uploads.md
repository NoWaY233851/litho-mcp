# 0006. Upload photos through the widget

- Status: Accepted, pending platform validation
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

## Decision

**The upload flow**
1. The `upload_image` tool (no arguments) opens the widget in upload mode, with one "Choose photo" button: `<input type="file" accept="image/png,image/jpeg,image/webp">`.
2. In the browser:
   - decode the photo with `createImageBitmap`;
   - scale it to at most 2048 px on the long edge;
   - re-encode it as JPEG at quality 0.9.

   This shrinks the upload and **strips EXIF, including GPS location**.
3. The bytes reach the server through one of two transports. Platform validation picks which:
   - **(a)** the widget-only tool `upload_image_data({ data })`. This is preferred, because it reuses the connector's OAuth session, as long as Claude relays a few MB of arguments.
   - **(b)** a direct `POST /upload` with a 10-minute HMAC token. The token comes from `upload_image`, and its key is derived from the owner password, so no extra secret is needed.
4. The server applies the same checks as reference URLs ([0007](0007-reference-urls-ssrf.md)) and stores the photo as `up_<id>`:
   - PNG, JPEG or WebP, by magic bytes;
   - at most 10 MiB;
   - at most 8192 px per side.
5. The widget shows a local preview. It tells Claude the new id with `ui/update-model-context`. If that doesn't reach the model, it shows the id for the user to pass on.

**Failure handling**
- If the file picker doesn't work on some platform, users upload from a computer instead. Conversations sync across devices and images are stored by id, so they can keep editing on the phone.
- The `upload_image` description tells Claude to suggest this.

**Rejected options**
- Options 2 and 3 are rejected for simplicity.

## Consequences

- Uploading takes one extra step compared with attaching a photo: ask Claude to open the uploader.
- Photos never carry location metadata to the server.
- HEIC handling on iPhone, and the Android WebView file picker, are checked during platform validation.
