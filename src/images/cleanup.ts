import type { ImageStore } from "./store.js";

const DAY_MS = 86_400_000;

// Deletes everything uploaded before `now - retentionDays`. Objects exactly at
// the boundary stay until the next run. A failed delete throws and leaves the
// rest for the next daily run, so a retry never needs any state.
export async function runCleanup(
  store: ImageStore,
  now: number,
  retentionDays: number,
): Promise<{ deleted: number }> {
  const expired = await store.listOlderThan(now - retentionDays * DAY_MS);
  if (expired.length === 0) return { deleted: 0 };
  await store.delete(expired.map((object) => object.url));
  return { deleted: expired.length };
}
