import { randomBytes } from "node:crypto";

// `img` ids name generated images, `up` ids name uploads (the only ones that
// may be replaced). The 128 random bits are the unguessable capability in the
// public URL, see docs/design/0010-vercel-blob-storage.md.
export type ImageKind = "img" | "up";

const ID_PATTERN = /^(img|up)_([0-9a-f]{32})$/;

export function newImageId(kind: ImageKind): string {
  return `${kind}_${randomBytes(16).toString("hex")}`;
}

export function parseImageId(id: string): { kind: ImageKind; hex: string } | null {
  const match = ID_PATTERN.exec(id);
  return match ? { kind: match[1] as ImageKind, hex: match[2]! } : null;
}
