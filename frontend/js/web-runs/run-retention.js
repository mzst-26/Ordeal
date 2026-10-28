// Retention and size rules for the web run store. A saved run is kept for 24 hours. Each browser may hold at most
// 100 MB of saved runs, and the whole store may hold at most 1.5 GB. A save that would take its browser over 100 MB is
// refused. When a save would take the whole store over 1.5 GB, the oldest runs are removed first until it fits.
// These are pure functions: they take plain objects and return plain results. They send nothing and read no
// clock, so the browser and the Netlify functions can both use them, and a test can give them any time it likes.

/** How many hours a saved run is kept before it counts as expired. */
export const RETENTION_HOURS = 24;

/** One hour in milliseconds. */
export const HOUR_MS = 60 * 60 * 1000;

/** One day in milliseconds. */
export const DAY_MS = 24 * HOUR_MS;

/** How long a saved run is kept, in milliseconds. */
export const RETENTION_MS = RETENTION_HOURS * HOUR_MS;

/**
 * The most bytes one browser may hold in saved runs: 100 MB, counted as 100 times 1024 squared. A browser is named by
 * the id it sends with each save. The id is not a login, so this limits ordinary use, not a determined visitor.
 */
export const BROWSER_CAP_BYTES = 100 * 1024 * 1024;

/**
 * The most bytes the whole store may hold: 1.5 GB, counted as 1.5 times 1024 cubed. The store is shared by every run,
 * so the cap is checked against the total of all runs plus the new save.
 */
export const MAX_STORE_BYTES = 1.5 * 1024 * 1024 * 1024;

/**
 * Return true when a run is expired at time nowMs. A run is expired only when it is older than 24 hours, so a run
 * exactly 24 hours old is still kept. Times are in milliseconds since the epoch.
 */
export function isExpired(createdAtMs, nowMs) {
  return nowMs - createdAtMs > RETENTION_MS;
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
 * Return the bytes that one browser's runs hold. A run belongs to the browser whose id matches its owner. Runs with
 * no owner, or with another owner, do not count.
 */
export function browserBytes(runs, owner) {
  return runs.filter((run) => run.owner === owner).reduce((sum, run) => sum + run.bytes, 0);
}

/**
 * Return true when a new save of incomingBytes keeps this browser within its cap. The check is only about the one
 * browser: other browsers' runs do not count here, and no run is removed to make room.
 */
export function fitsBrowserCap(runs, owner, incomingBytes, capBytes = BROWSER_CAP_BYTES) {
  return browserBytes(runs, owner) + incomingBytes <= capBytes;
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
