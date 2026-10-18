// Kept free of package imports so configuration loading can validate a store id
// against the exact URL the store will build, without pulling the Blob SDK in.
export const BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";

export function blobBaseUrl(storeId: string): string {
  return `https://${storeId}${BLOB_HOST_SUFFIX}`;
}
