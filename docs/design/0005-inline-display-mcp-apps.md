# 0005. Show images inline with an MCP Apps widget

- Status: Accepted. Validated on claude.ai web and iOS on 2026-10-16, and on web, desktop and iOS with Blob-hosted images on 2026-10-17; Android is untested. Revised on 2026-10-17 for Blob-hosted images and host theming.
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
- Full-size images load from the image's public Blob URL ([0010](0010-vercel-blob-storage.md)) with `referrerpolicy="no-referrer"`. The CSP's `resourceDomains` lists only the wildcard `https://*.public.blob.vercel-storage.com`.
- Text is in English and Traditional Chinese, chosen from `hostContext.locale`, falling back to `navigator.language`.
- The widget applies the host's theme, style tokens and fonts (`applyDocumentTheme`, `applyHostStyleVariables`, `applyHostFonts`), and stays readable in dark mode.
- In fullscreen, content is padded by `hostContext.safeAreaInsets`.

**Platform failures**
- If validation shows the widget doesn't render on some **mobile** platform, that platform degrades: it shows the tool result's thumbnail (collapsed) and the link in the text. Both are already in the result.
- If it fails on **web or desktop**, this decision is revisited.

**Platform validation (before building the real server)**
A throwaway Worker is deployed and tested on web, desktop, iOS and Android. It checks:
1. whether the widget renders;
2. whether full-size image URLs load in `<img>`;
3. whether fullscreen works;
4. whether long-press saves the image;
5. the widget's HTML size;
6. the negotiated protocol version.

Results update this ADR.

## Validation (2026-10-16, claude.ai web and iOS)

A throwaway Worker (Phase 0) was tested on claude.ai web (macOS Safari) and the iOS app.

- **Rendering:** the widget renders on both, served by a stateless `createMcpHandler` with the ext-apps `registerAppTool` and `registerAppResource` helpers.
- **Images:** full-size images load in `<img>` from the server's origin with no CSP violations. `resourceDomains` and `connectDomains` in `_meta.ui.csp` are honored.
- **Sandbox origin:** without `_meta.ui.domain`, it is `https://<32 hex>.claudemcpcontent.com`.
- **Fullscreen:** works on both. On iOS, content needs padding by `hostContext.safeAreaInsets` (observed: top 113, bottom 140).
- **Saving:** long-press saves the image on iOS; right-click works on web.
- **`downloadFile`:** listed in `hostCapabilities` on web only, not on iOS, so a download button built on it wouldn't work on phones.
- **Scrolling:** on mobile, inline widgets can't scroll internally; swipes go to the chat. The inline view has to fit without scrolling.
- **Host context:** it provides `theme`, the `styles.variables` tokens and a per-app `locale` (web reported en-US, iOS zh-TW). The Phase 0 widget ignored them and was unreadable in dark mode, so the widget must use the host's theme tokens and locale.
- **Protocol version:** claude.ai sent `MCP-Protocol-Version: 2026-07-28`, and `2025-11-25` in one session.
- **Not tested then:** desktop and Android. Desktop was covered on 2026-10-17 (below).

## Validation (2026-10-17, Vercel)

Tested on claude.ai web (macOS Safari), Claude desktop (macOS) and the Claude iOS app (iOS 18.7) against a throwaway Vercel deployment.

- **Blob images:** a public Blob URL loads in the widget `<img>` on all three. The CSP wildcard `https://*.public.blob.vercel-storage.com` is honored: web and desktop echo it in `hostCapabilities.sandbox.csp`, and iOS does not report `sandbox` but loads the image. The exact store host also works (tested on web after the resource was re-read in a new conversation). The wildcard is the decision, so the CSP needs no per-deployment value. The `get_image_data` fallback is not needed.
- **Desktop:** the widget renders, fullscreen works and dark mode is readable. No Allow / Always allow prompt appeared. The context menu offers only Copy Image (which did not work) and Copy Image Address, so there is no direct save. A download button stays a non-goal.
- **`downloadFile`:** advertised on web and desktop, not on iOS.
- **iOS:** fullscreen content stays clear of the host's top bar and composer when the widget pads by `hostContext.safeAreaInsets` (top 113, bottom 140 on the test phone). Long-press saves the image. `locale` was zh-TW, while web and desktop reported en-US.
- **Theming:** the widget stayed readable in light (iOS) and dark (web, desktop) themes using the host's style variables.
- **Sandbox origin:** `https://<32 hex>.claudemcpcontent.com`, different for each conversation. claude.ai re-reads the UI resource once per new conversation.
- **Android:** not tested (no device). Mobile degradation as described under Platform failures applies if it fails there.

## Consequences

- Images are visible inline without expanding anything. Phones are the most constrained target.
- Saving or downloading relies on long-press on phones, right-click on web, or asking Claude for the link, because there's no download button. Desktop has no direct save at all; the link is the way.
- The bundled widget adds a build step: `npm run build:ui` runs before tests and deploys.
- Blob URLs load inside the iframe, so no base64 fallback tool is needed. If a platform stops allowing them, a widget-only `get_image_data` tool returning base64 is the fallback.

## Revision (2026-10-17)

- Full-size images now load from the image's public Blob URL ([0010](0010-vercel-blob-storage.md)) instead of the server's `/img/<id>` route, which no longer exists. The CSP's `resourceDomains` therefore lists the wildcard `https://*.public.blob.vercel-storage.com`, which claude.ai honors (see the 2026-10-17 validation). `connectDomains` lists the server origin only if the direct-POST upload fallback ([0006](0006-photo-uploads.md)) is used.
- UI language now comes from `hostContext.locale`, which is set per app, falling back to `navigator.language`.
- Theme, style tokens, fonts and fullscreen safe-area padding were added after the validation above.
