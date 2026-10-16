# 0005. Show images inline with an MCP Apps widget

- Status: Accepted, pending platform validation
- Date: 2026-10-16

## Context

claude.ai collapses images returned by MCP tools inside the tool-call block, so users don't see results unless they expand it. claude.ai also doesn't render external images in Markdown replies, so a plain link means an extra tap and a confirmation dialog.

MCP Apps (SEP-1865, stable since 2026-01-26) lets a tool name a `ui://` HTML resource (`text/html;profile=mcp-app`). The host renders it in a sandboxed iframe and passes it the tool input and result.

**What the widget can do**
- call server tools, including tools hidden from the model (`visibility: ["app"]`);
- request fullscreen;
- open links (custom connectors always show a confirmation first);
- add text to the model's context.

**CSP**
- External origins are blocked unless listed in `_meta.ui.csp`.

**Platform support**
- Claude supports MCP Apps on web, desktop, iOS and Android, on all plans, including custom connectors.
- Desktop asks the user to allow an app the first time.
- On mobile:
  - inline height is capped;
  - vertical swipes scroll the chat;
  - camera, microphone and location aren't available.

**Unknowns**
- Cloudflare doesn't document MCP Apps together with `createMcpHandler`.

Options considered for the in-chat layout:

1. **Image only**: full-width image and a one-line caption.
2. **Image plus action buttons**: download, open, regenerate.
3. **Image plus a version strip with before/after comparison.**

## Decision

**The widget**
- One widget resource, `ui://litho/app.html`, built from TypeScript with the official `App` class.
- It has no framework, and is bundled into a single HTML file with Vite and `vite-plugin-singlefile`.
- It switches mode based on `structuredContent.kind`.
- **Layout: image only.**
  - The image fills the width.
  - A small caption below reads `model · aspect ratio · $cost`.
  - Tapping the image requests fullscreen.
  - No buttons and no version strip.
- While a generation is running, it shows "Generating…" and the elapsed seconds. Generation often takes 30–90 seconds.
- `img.onerror` shows an "expired" note.
- Full-size images load from `/img/<id>` with `referrerpolicy="no-referrer"`. The CSP lists only the Worker's own origin.
- Text is in English and Traditional Chinese, chosen from `navigator.language`.

**Platform failures**
- If validation shows the widget doesn't render on some **mobile** platform, that platform degrades: it shows the tool result's thumbnail (collapsed) and the link in the text. Both are already in the result.
- If it fails on **web or desktop**, this decision is revisited.

**Platform validation (before building the real server)**
A throwaway Worker is deployed and tested on web, desktop, iOS and Android. It checks:
1. whether the widget renders;
2. whether `/img` URLs load in `<img>`;
3. whether fullscreen works;
4. whether long-press saves the image;
5. the widget's HTML size;
6. the negotiated protocol version.

Results update this ADR.

## Consequences

- Images are visible inline without expanding anything. Phones are the most constrained target.
- Saving or downloading relies on the platform's long-press, or on asking Claude for the link, because there's no download button.
- The bundled widget adds a build step: `npm run build:ui` runs before tests and deploys.
- If the `/img` URL approach fails inside the iframe, a widget-only `get_image_data` tool returning base64 is the fallback.
