// Pure helpers for the widget. Nothing here touches the DOM, so vitest can run it on Node.

export type Locale = "en" | "zh-TW";

/** Scales (w, h) to fit a max x max box, keeping the aspect ratio and never upscaling. */
export function fitWithin(w: number, h: number, max: number): { w: number; h: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  if (scale === 1) return { w, h };
  // Rounding must not collapse a very thin side to zero: canvases reject a 0 size.
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** "model · aspect ratio · $cost", with the aspect ratio falling back to W×H. */
export function formatMeta(sc: {
  model: string;
  aspect_ratio?: string;
  width: number;
  height: number;
  cost_usd: number | null;
}): string {
  const model = sc.model.slice(sc.model.lastIndexOf("/") + 1);
  const parts = [model, sc.aspect_ratio ?? `${sc.width}×${sc.height}`];
  if (sc.cost_usd !== null) parts.push(`$${sc.cost_usd.toFixed(3)}`);
  return parts.join(" · ");
}

/** Every Chinese variant maps to Traditional Chinese: it is the only Chinese copy shipped. */
export function pickLocale(lang: string | undefined): Locale {
  return lang?.toLowerCase().startsWith("zh") ? "zh-TW" : "en";
}

export const STRINGS: Record<
  Locale,
  Record<
    | "generating"
    | "seconds"
    | "choosePhoto"
    | "uploading"
    | "uploaded"
    | "replacePhoto"
    | "expired"
    | "uploadFailed"
    | "decodeFailed",
    string
  >
> = {
  en: {
    generating: "Generating image…",
    seconds: "s",
    choosePhoto: "Choose photo",
    uploading: "Uploading…",
    uploaded: "Uploaded",
    replacePhoto: "Replace photo",
    expired: "This image is no longer available. It may have expired.",
    uploadFailed: "Upload failed. Try again.",
    decodeFailed:
      "This device can't read this photo's format. Choose a JPEG, PNG or WebP, or export the photo first.",
  },
  "zh-TW": {
    generating: "圖片產生中…",
    seconds: "秒",
    choosePhoto: "選擇照片",
    uploading: "上傳中…",
    uploaded: "已上傳",
    replacePhoto: "更換照片",
    expired: "這張圖片已無法顯示，可能已超過保存期限。",
    uploadFailed: "上傳失敗，請再試一次。",
    decodeFailed: "這台裝置無法讀取這張照片的格式。請改選 JPEG、PNG 或 WebP，或先將照片匯出。",
  },
};

/**
 * Adds `v=<token>` to a URL, keeping any existing query and fragment. Browsers (WebKit's
 * in-page memory cache included) otherwise return the pre-upload result for an `up/` URL; the
 * Blob CDN ignores the query (docs/design/0006-photo-uploads.md).
 */
export function withCacheBuster(url: string, token: string | number): string {
  const hash = url.indexOf("#");
  const base = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? "" : url.slice(hash);
  return `${base}${base.includes("?") ? "&" : "?"}v=${token}${fragment}`;
}

/** Encoded size of the server's 10 MiB image limit; a larger `data` argument is refused. */
export const MAX_UPLOAD_BASE64_CHARS = Math.ceil((10 * 1024 * 1024) / 3) * 4;

/** Plain base64 (no `data:` prefix). Chunked so large photos don't overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
