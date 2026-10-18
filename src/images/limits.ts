// Size limits shared by modules that must not depend on each other: the public fetch pulls in
// undici and node:dns, and the store pulls in the Blob SDK.

/**
 * Largest image accepted from an upload or a download. Images OpenRouter generates are not
 * capped: the call is already paid for, so refusing one would lose it.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Largest object the store will read back. Generated images have no size cap of their own, so
 * this bounds what one stored id can cost in memory when an edit loads it as a reference. It is
 * the same size as the cap on all references of one edit.
 */
export const MAX_STORED_READ_BYTES = 4 * MAX_IMAGE_BYTES;

/** The message of the error ImageStore.get throws for an object over MAX_STORED_READ_BYTES. */
export const STORED_TOO_LARGE_MESSAGE = "stored object too large";
