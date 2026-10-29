// Totals for one saved run, added up over every Start. A Start is one press of Start or Resume. Each Start counts its
// own calls, and this module adds them to what the run already has, so the numbers do not reset when a run is stopped
// and started again. Why keep them on the run: the counts shown for a Start used to be forgotten at the next Start,
// so a failed call looked as if it had never happened.

// The failures kept with the run. Only the most recent are kept, so a long run does not grow without limit. The counts
// still cover every failure; only the list of their details is cut short.
export const MAX_RECENT_FAILURES = 50;

/** Return the totals of a run that has no calls yet. Every count starts at zero and the failure list is empty. */
export function emptyTotals() {
  return {
    calls: 0,
    reused: 0,
    failed: 0,
    unusable: 0,
    retries: 0,
    rateLimits: 0,
    activeSeconds: 0,
    failures: [],
  };
}

/**
 * Return the totals saved on a run. A run saved before totals existed, or one whose totals are only partly there,
 * reads the missing parts as zero, so an old run opens without an error.
 */
export function readTotals(run) {
  const saved = run && run.totals ? run.totals : {};
  const empty = emptyTotals();
  const totals = {};
  for (const key of Object.keys(empty)) {
    if (key === 'failures') continue;
    totals[key] = typeof saved[key] === 'number' ? saved[key] : empty[key];
  }
  totals.failures = Array.isArray(saved.failures) ? saved.failures.slice(-MAX_RECENT_FAILURES) : [];
  return totals;
}

/**
 * Return new totals with one Start's counts added. The totals given are not changed. The Start's failure details are
 * added to the end of the list, and only the most recent MAX_RECENT_FAILURES are kept.
 */
export function addSession(totals, session) {
  const numbers = {};
  for (const key of Object.keys(emptyTotals())) {
    if (key === 'failures') continue;
    numbers[key] = totals[key] + (session[key] ?? 0);
  }
  const failures = [...totals.failures, ...session.failures].slice(-MAX_RECENT_FAILURES);
  return { ...numbers, failures };
}
