// Retention and size rules for the web run store. A saved run is kept for 7 days. Each visitor may hold at most
// 200 MB, and the whole store may hold at most 1.5 GB. When a new save would break either cap, the visitor's own
// oldest runs are removed first, and only as many as needed. If that cannot make room, the save is refused.
// These are pure functions: they take plain objects and return plain results. They send nothing and read no
// clock, so the browser and the Netlify functions can both use them, and a test can give them any time it likes.

/** How many days a saved run is kept before it counts as expired. */
export const RETENTION_DAYS = 7;

/** One day in milliseconds. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The most bytes one visitor may hold: 200 MB, counted as 200 times 1024 squared. A visitor's runs are added up
 * against this cap before a save is allowed.
 */
export const VISITOR_MAX_BYTES = 200 * 1024 * 1024;

/**
 * The most bytes the whole store may hold: 1.5 GB, counted as 1.5 times 1024 cubed. The store is shared by every
 * visitor, so the cap is checked against the total of all runs plus the new save.
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
 * object with id, createdAt (milliseconds) and bytes. The daily prune uses this across every visitor.
 */
export function expiredRunIds(runs, nowMs) {
  return runs.filter((run) => isExpired(run.createdAt, nowMs)).map((run) => run.id);
}

/** Return the total bytes of a list of runs. An empty list holds 0 bytes. */
export function totalBytes(runs) {
  return runs.reduce((sum, run) => sum + run.bytes, 0);
}

/**
 * Return true when both caps have room for the new save. The visitor total and the store total are each checked
 * with the save added, so a save must fit under both to be allowed.
 */
function fitsBothCaps(visitorTotal, storeTotal, incomingBytes, visitorMax, storeMax) {
  return visitorTotal + incomingBytes <= visitorMax && storeTotal + incomingBytes <= storeMax;
}

/**
 * Plan a save for one visitor. visitorRuns are this visitor's runs; storeRuns are every run in the store, which
 * includes the visitor's runs. The visitor's oldest runs are removed first, one at a time, until both caps fit.
 * Other visitors' runs are never removed.
 *
 * Returns { removeIds, fits, reason }:
 * - fits true, reason "ok": the save can go ahead after the removeIds runs are deleted.
 * - fits false, reason "visitor": the save alone is bigger than the visitor cap, so it can never fit.
 * - fits false, reason "store": even with all of this visitor's runs removed, the store is still too full.
 * When fits is false, removeIds is empty, so a refused save never costs the visitor a run.
 */
export function planVisitorSave({
  visitorRuns,
  storeRuns,
  incomingBytes,
  visitorMax = VISITOR_MAX_BYTES,
  storeMax = MAX_STORE_BYTES,
}) {
  // A save bigger than the visitor cap can never fit, however many runs are removed.
  if (incomingBytes > visitorMax) {
    return { removeIds: [], fits: false, reason: "visitor" };
  }
  // Oldest first: the run created earliest is the first to go. A copy is sorted so the caller's order stays as it was.
  const oldestFirst = [...visitorRuns].sort((a, b) => a.createdAt - b.createdAt);
  let visitorTotal = totalBytes(oldestFirst);
  let storeTotal = totalBytes(storeRuns);
  const removeIds = [];
  for (const run of oldestFirst) {
    if (fitsBothCaps(visitorTotal, storeTotal, incomingBytes, visitorMax, storeMax)) {
      break;
    }
    removeIds.push(run.id);
    visitorTotal -= run.bytes;
    storeTotal -= run.bytes;
  }
  if (fitsBothCaps(visitorTotal, storeTotal, incomingBytes, visitorMax, storeMax)) {
    return { removeIds, fits: true, reason: "ok" };
  }
  // Removing every run of this visitor was not enough, so other visitors fill the store. Nothing is removed.
  return { removeIds: [], fits: false, reason: "store" };
}
