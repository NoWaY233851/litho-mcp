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

/**
 * Bytes still available to the reads of one edit. An edit loads all its references in parallel,
 * so the per-read caps alone would let 16 reads hold 16 times their cap at once; every read
 * charges each chunk here before keeping it.
 */
export interface ReadBudget {
  /** Charges `bytes` and returns true if they fit in what remains; otherwise returns false and charges nothing. */
  take(bytes: number): boolean;
}

export function readBudget(limit: number): ReadBudget {
  let remaining = limit;
  return {
    take(bytes) {
      if (bytes > remaining) return false;
      remaining -= bytes;
      return true;
    },
  };
}

/** The message of the error ImageStore.get throws when a read does not fit its ReadBudget. */
export const READ_BUDGET_EXCEEDED_MESSAGE = "reference read budget exceeded";
