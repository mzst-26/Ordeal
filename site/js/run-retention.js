// Retention and size rules for the web run store. A saved run is kept for 7 days, and the whole store may hold
// at most 1.5 GB. When a new save would go over the cap, the oldest runs are removed first until it fits.
// These are pure functions: they take plain objects and return plain results. They send nothing and read no
// clock, so the browser and the Netlify functions can both use them, and a test can give them any time it likes.

/** How many days a saved run is kept before it counts as expired. */
export const RETENTION_DAYS = 7;

/** One day in milliseconds. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The most bytes the whole store may hold: 1.5 GB, counted as 1.5 times 1024 cubed. The store is shared by every run,
 * so the cap is checked against the total of all runs plus the new save.
 */
export const MAX_STORE_BYTES = 1.5 * 1024 * 1024 * 1024;

/**
 * Return true when a run is expired at time nowMs. A run is expired only when it is older than 7 days, so a run
 * exactly 7 days old is still kept. Times are in milliseconds since the epoch.
 */
export function isExpired(createdAtMs, nowMs) {
  return nowMs - createdAtMs > RETENTION_DAYS * DAY_MS;
}

/**
 * Return the ids of the runs that are expired at nowMs, in the order they were given. Each run is a plain
 * object with id, createdAt (milliseconds) and bytes.
 */
export function expiredRunIds(runs, nowMs) {
  return runs.filter((run) => isExpired(run.createdAt, nowMs)).map((run) => run.id);
}

/** Return the total bytes of a list of runs. An empty list holds 0 bytes. */
export function totalBytes(runs) {
  return runs.reduce((sum, run) => sum + run.bytes, 0);
}

/**
 * Plan the removals that make room for a new save of incomingBytes. The oldest runs go first, and removal stops as
 * soon as the total plus the new save fits under maxBytes. Returns { removeIds, fits }: fits is false only when the
 * save is too big for the cap even with every run removed, in which case the caller must refuse the save.
 * The runs list is copied before sorting, so the caller's array is not changed.
 */
export function planSizeCleanup(runs, incomingBytes, maxBytes = MAX_STORE_BYTES) {
  // Oldest first: the run created earliest is the first to go. A copy is sorted so the caller's order stays as it was.
  const oldestFirst = [...runs].sort((a, b) => a.createdAt - b.createdAt);
  let remaining = totalBytes(oldestFirst);
  const removeIds = [];
  for (const run of oldestFirst) {
    if (remaining + incomingBytes <= maxBytes) {
      break;
    }
    removeIds.push(run.id);
    remaining -= run.bytes;
  }
  return { removeIds, fits: remaining + incomingBytes <= maxBytes };
}
