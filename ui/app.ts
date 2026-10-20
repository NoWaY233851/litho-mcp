// MCP Apps widget: shows generated images inline and runs the photo uploader. One resource
// serves both, switching on structuredContent.kind (docs/design/0005-inline-display-mcp-apps.md,
// docs/design/0006-photo-uploads.md).
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import {
  MAX_UPLOAD_BASE64_CHARS,
  STRINGS,
  UPLOAD_ENCODE_LADDER,
  bytesToBase64,
  fitWithin,
  formatMeta,
  inlineSize,
  pickLocale,
  withCacheBuster,
} from "./lib.js";
import type { Locale } from "./lib.js";

type ImageResult = {
  url: string;
  model: string;
  aspect_ratio?: string;
  width: number;
  height: number;
  cost_usd: number | null;
};

// Stored as a string key so a locale change re-renders the message in the new language.
type Notice = { key: "uploadFailed" | "decodeFailed" | "tooLarge"; detail?: string };

// Upload phases: "probing" until the mount probe settles, "empty" when nothing is stored,
// "remote" for a photo found at the pre-assigned URL, "local" for the canvas just uploaded.
type UploadView = {
  kind: "upload";
  id: string;
  url: string;
  phase: "probing" | "empty" | "remote" | "local";
  remoteSrc?: string;
  // Natural size of the stored photo, read by the probe so the layout box is known before paint.
  remoteSize?: { w: number; h: number };
  canvas?: HTMLCanvasElement;
  busy: boolean;
  // True once this widget's upload overwrote a photo that was already shown.
  replaced: boolean;
  failure?: Notice;
};

type View =
  | { kind: "empty" }
  | { kind: "waiting"; startedAt: number }
  | { kind: "image"; image: ImageResult; expired: boolean }
  | { kind: "error"; text: string }
  | UploadView;

const app = new App({ name: "litho-widget", version: "0.0.0" }, { availableDisplayModes: ["inline", "fullscreen"] });

const root = document.getElementById("app") as HTMLElement;
const content = document.createElement("div");
content.className = "content";
const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = "image/png,image/jpeg,image/webp";
fileInput.className = "visually-hidden";
fileInput.tabIndex = -1;
fileInput.setAttribute("aria-hidden", "true");
root.append(content, fileInput);

let locale: Locale = pickLocale(navigator.language);
let view: View = { kind: "empty" };
let waitingLine: HTMLElement | undefined;
let timer: number | undefined;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function textOf(result: { content?: { type: string; text?: string }[] }): string {
  return (result.content ?? [])
    .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function stopTimer(): void {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
}

function waitingText(startedAt: number): string {
  const s = STRINGS[locale];
  return `${s.generating} ${Math.floor((Date.now() - startedAt) / 1000)} ${s.seconds}`;
}

function setView(next: View): void {
  view = next;
  render();
}

function requestFullscreen(): void {
  const ctx = app.getHostContext();
  if (!ctx?.availableDisplayModes?.includes("fullscreen") || ctx.displayMode === "fullscreen") return;
  // A refused request leaves the image inline, which is fine.
  void app.requestDisplayMode({ mode: "fullscreen" }).catch(() => undefined);
}

function renderImage(v: Extract<View, { kind: "image" }>): Node[] {
  const s = STRINGS[locale];
  if (v.expired) return [el("p", { className: "error", role: "alert", textContent: s.expired })];
  const img = el("img", {
    src: v.image.url, // img/ objects never change, so no cache-buster (unlike up/ URLs)
    referrerPolicy: "no-referrer",
    className: "zoomable",
    alt: "",
    width: v.image.width,
    height: v.image.height,
  });
  img.onclick = requestFullscreen;
  img.onerror = () => {
    if (view === v) setView({ ...v, expired: true });
  };
  return [img, el("p", { className: "meta", textContent: formatMeta(v.image) })];
}

function renderUpload(v: UploadView): Node[] {
  const s = STRINGS[locale];
  const out: Node[] = [];

  if (v.phase === "local" && v.canvas) out.push(v.canvas);
  if (v.phase === "remote" && v.remoteSrc) {
    const img = el("img", { src: v.remoteSrc, referrerPolicy: "no-referrer", alt: "" });
    if (v.remoteSize) {
      img.width = v.remoteSize.w;
      img.height = v.remoteSize.h;
    }
    // The photo vanished between the probe and the display: offer the picker instead.
    img.onerror = () => {
      if (view === v) setView({ ...v, phase: "empty", remoteSrc: undefined, remoteSize: undefined });
    };
    out.push(img);
  }

  if (v.phase === "probing") return out;

  const shown = v.phase === "remote" || v.phase === "local";
  const button = el("button", {
    type: "button",
    textContent: shown ? s.replacePhoto : s.choosePhoto,
    disabled: v.busy,
  });
  // The picker must open inside the tap's user gesture, hence a click on the hidden input.
  button.onclick = () => fileInput.click();
  const row = el("div", { className: "row" }, button);
  if (v.busy) row.append(el("span", { className: "status", textContent: s.uploading }));
  else if (shown) row.append(el("span", { className: "status", textContent: s.uploaded }));
  out.push(row);

  if (v.replaced && v.phase === "local" && !v.busy) {
    out.push(el("p", { className: "status", textContent: s.replaceDelay }));
  }

  if (v.failure) {
    const note = el("div", { role: "alert" }, el("p", { className: "error", textContent: s[v.failure.key] }));
    if (v.failure.detail) note.append(el("p", { className: "detail", textContent: v.failure.detail }));
    out.push(note);
  }
  return out;
}

// The size of the picture the view shows, if any; it sets the inline column width.
function pictureSize(v: View): { w: number; h: number } | undefined {
  if (v.kind === "image" && !v.expired) return { w: v.image.width, h: v.image.height };
  if (v.kind !== "upload") return undefined;
  if (v.phase === "local" && v.canvas) return { w: v.canvas.width, h: v.canvas.height };
  if (v.phase === "remote") return v.remoteSize;
  return undefined;
}

function render(): void {
  document.documentElement.lang = locale;
  waitingLine = undefined;
  const v = view;
  const size = pictureSize(v);
  // Read by the inline max-width in app.html, so the caption and buttons follow the picture.
  if (size) content.style.setProperty("--fit-w", `${inlineSize(size.w, size.h).w}px`);
  else content.style.removeProperty("--fit-w");
  switch (v.kind) {
    case "empty":
      content.replaceChildren();
      break;
    case "waiting":
      waitingLine = el("p", { className: "status", textContent: waitingText(v.startedAt) });
      waitingLine.setAttribute("aria-live", "polite");
      content.replaceChildren(waitingLine);
      break;
    case "image":
      content.replaceChildren(...renderImage(v));
      break;
    case "error":
      content.replaceChildren(el("p", { className: "detail", role: "alert", textContent: v.text }));
      break;
    case "upload":
      content.replaceChildren(...renderUpload(v));
      break;
  }
}

function applyContext(ctx: McpUiHostContext | undefined): void {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);

  // On iOS the host overlays its top bar and composer over the fullscreen view.
  const inset = ctx.safeAreaInsets;
  const fullscreen = ctx.displayMode === "fullscreen";
  document.documentElement.dataset.mode = fullscreen ? "fullscreen" : "inline";
  const [top, right, bottom, left] = fullscreen && inset ? [inset.top, inset.right, inset.bottom, inset.left] : [0, 0, 0, 0];
  root.style.padding = fullscreen ? `${top + 8}px ${right + 8}px ${bottom + 8}px ${left + 8}px` : "0 0 8px";
  root.style.setProperty("--pad-y", `${fullscreen ? top + bottom + 16 : 0}px`);

  const next = pickLocale(ctx.locale ?? navigator.language);
  if (next !== locale) {
    locale = next;
    render();
  }
}

// --- Uploader ---------------------------------------------------------------

// Loads the up/ URL with a fresh cache-buster: browsers, WebKit's in-page memory cache
// included, otherwise keep answering with the result from before the last upload.
function probe(v: UploadView): void {
  const src = withCacheBuster(v.url, Date.now());
  const img = new Image();
  img.referrerPolicy = "no-referrer";
  img.onload = () => {
    // A zero size would make the column 0 px wide, so an unreadable size leaves it unbounded.
    const { naturalWidth: w, naturalHeight: h } = img;
    if (view === v) setView({ ...v, phase: "remote", remoteSrc: src, remoteSize: w > 0 && h > 0 ? { w, h } : undefined });
  };
  img.onerror = () => {
    if (view === v) setView({ ...v, phase: "empty" });
  };
  img.src = src;
}

function patchUpload(v: UploadView, patch: Partial<UploadView>): UploadView {
  const next = { ...v, ...patch };
  if (view === v) setView(next);
  return next;
}

async function uploadPhoto(file: File): Promise<void> {
  const start = view;
  if (start.kind !== "upload" || start.busy) return;
  // An overwrite can take up to 60 s to reach the Blob CDN (docs/design/0010-vercel-blob-storage.md),
  // so only a replacement gets the delay note; a first upload has nothing cached to replace.
  const replaces = start.phase === "remote" || start.phase === "local";
  const v = patchUpload(start, { busy: true, replaced: false, failure: undefined });
  const fail = (failure: Notice) => patchUpload(v, { busy: false, failure });

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Chromium-based clients can't decode DNG or HEIC even though the file dialog offers them.
    fail({ key: "decodeFailed" });
    return;
  }

  let data: string | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    // Each step re-encodes from the decoded bitmap, never from the previous JPEG.
    for (const { edge, quality } of UPLOAD_ENCODE_LADDER) {
      const { w, h } = fitWithin(bitmap.width, bitmap.height, edge);
      const c = el("canvas", { width: w, height: h });
      const g = c.getContext("2d");
      if (!g) throw new Error("no 2d context");
      g.drawImage(bitmap, 0, 0, w, h);
      // Re-encoding drops EXIF and GPS; the canvas, not the input's own thumbnail, is the preview.
      const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/jpeg", quality));
      if (!blob) throw new Error("encode failed");
      const encoded = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
      if (encoded.length <= MAX_UPLOAD_BASE64_CHARS) {
        data = encoded;
        canvas = c;
        break;
      }
    }
  } catch {
    fail({ key: "uploadFailed" });
    return;
  } finally {
    bitmap.close();
  }
  if (data === undefined || !canvas) {
    // Every ladder step stayed over the cap; retrying the same photo can't help.
    fail({ key: "tooLarge" });
    return;
  }

  try {
    const result = await app.callServerTool({ name: "upload_image_data", arguments: { id: v.id, data } });
    if (result.isError) {
      fail({ key: "uploadFailed", detail: textOf(result) || undefined });
      return;
    }
  } catch {
    fail({ key: "uploadFailed" });
    return;
  }
  patchUpload(v, {
    busy: false,
    replaced: replaces,
    phase: "local",
    canvas,
    remoteSrc: undefined,
    remoteSize: undefined,
    failure: undefined,
  });
}

fileInput.onchange = () => {
  const file = fileInput.files?.[0];
  // Clearing lets the same file be picked again after a failure.
  const done = () => {
    fileInput.value = "";
  };
  if (!file) return;
  void uploadPhoto(file).finally(done);
};

// --- Tool events ------------------------------------------------------------
// Every handler is registered before connect() so no early notification is missed.

app.ontoolinput = (params) => {
  if (typeof params.arguments?.prompt !== "string") return;
  stopTimer();
  const startedAt = Date.now();
  setView({ kind: "waiting", startedAt });
  timer = window.setInterval(() => {
    if (waitingLine) waitingLine.textContent = waitingText(startedAt);
  }, 1000);
};

app.ontoolcancelled = () => {
  stopTimer();
  setView({ kind: "empty" });
};

function isImageResult(sc: Record<string, unknown>): boolean {
  return (
    typeof sc.url === "string" &&
    typeof sc.model === "string" &&
    typeof sc.width === "number" &&
    typeof sc.height === "number" &&
    (sc.cost_usd === null || typeof sc.cost_usd === "number")
  );
}

app.ontoolresult = (result) => {
  stopTimer();
  applyContext(app.getHostContext());
  if (result.isError) {
    setView({ kind: "error", text: textOf(result) });
    return;
  }
  const sc = (result.structuredContent ?? {}) as Record<string, unknown>;
  if (sc.kind === "image" && isImageResult(sc)) {
    setView({ kind: "image", image: sc as unknown as ImageResult, expired: false });
  } else if (sc.kind === "upload" && typeof sc.id === "string" && typeof sc.url === "string") {
    const v: UploadView = { kind: "upload", id: sc.id, url: sc.url, phase: "probing", busy: false, replaced: false };
    setView(v);
    probe(v);
  } else {
    setView({ kind: "empty" });
  }
};

app.onhostcontextchanged = () => applyContext(app.getHostContext());

void app
  .connect()
  .then(() => applyContext(app.getHostContext()))
  .catch(() => {
    // Not embedded in a host: nothing to show.
  });
