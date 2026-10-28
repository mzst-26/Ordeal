// Finds the newest saved run of one kind, so a page can show it as soon as it opens. Reading a run sends nothing.
import { getRun } from "./store/run-store.js";
import { savedRunRows } from "./saved-runs.js";
import { choiceOfSuite } from "./suites.js";

/** Return the newest saved run of this kind ("batch", "gauntlet" or "live"), or null when there is none. */
export async function latestRunOfKind(adapter, kind) {
  const rows = await savedRunRows(adapter, kind);
  if (rows.length === 0) {
    return null;
  }
  return getRun(adapter, rows[0].id);
}

/**
 * Return true when a saved run was made on this suite: the same pushback set and question set.
 * A run from another suite holds replies for other questions, so it is not shown on this one. A run that kept a
 * shuffled order (a seed) is never this suite, because the shuffled orders are no longer on this site.
 */
export function runMatchesSuite(run, suite) {
  const saved = run.config ?? {};
  const wanted = choiceOfSuite(suite);
  const shuffled = (saved.pushbackSeed ?? null) !== null || (saved.questionSeed ?? null) !== null;
  return !shuffled && saved.pushbackSet === wanted.pushbackSet && saved.questionSet === wanted.questionSet;
}

/** Return the date of a saved run as a short local text, for the status line. */
export function runDateText(run) {
  const date = new Date(run.createdAt);
  return Number.isNaN(date.getTime()) ? "an earlier time" : date.toLocaleString();
}
