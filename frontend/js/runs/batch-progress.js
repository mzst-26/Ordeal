// The numbers a batch page shows for progress, kept apart from the page so they can be tested. A Start that carries on a
// saved set starts with the units already saved, and its calls, reused replies and failures add to the totals of the
// earlier Starts. Showing zero at the start of a Start would make a saved set look lost.

/**
 * Return the units done to show: the distinct units that have a reply, across the conditions. A unit counts once, whether it
 * was saved before this Start or finished in it, and a saved unit the runner replays is not counted twice. Each argument maps
 * a condition to a set of unit keys.
 */
export function unitsDoneToShow(conditions, savedByCondition, finishedByCondition) {
  return conditions.reduce((sum, condition) => {
    const done = new Set(savedByCondition[condition] ?? []);
    for (const unit of finishedByCondition[condition] ?? []) done.add(unit);
    return sum + done.size;
  }, 0);
}

/** Return the calls, reused replies and failures to show: the totals of the earlier Starts plus this Start's own counts. */
export function countsToShow(earlier, thisStart) {
  return {
    calls: earlier.calls + thisStart.calls,
    reused: earlier.reused + thisStart.reused,
    failed: earlier.failed + thisStart.failed,
  };
}

/**
 * Return the counts to show while the page is idle. When the form still matches the saved set that was last shown, its
 * saved progress is kept; otherwise the counts are zero. The total always follows the form, so a changed set shows its own
 * size with nothing done yet.
 */
export function idleCountsFor(shown, matches, total) {
  if (shown === null || !matches) return { done: 0, total, calls: 0, reused: 0, failed: 0 };
  return { done: shown.done, total, calls: shown.calls, reused: shown.reused, failed: shown.failed };
}
