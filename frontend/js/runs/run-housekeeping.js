// Decisions about the saved runs kept in this browser, with no storage or page code in them, so the tests can run them
// in Node. Two jobs: find the run that a new Start should carry on with, so one run is never saved twice, and pick the
// old gauntlet copies to drop, so only a few are kept in the browser.

// A run in one of these states can be carried on. A done run is finished.
export const CARRY_ON_STATUSES = Object.freeze(["planned", "paused", "stopped", "failed"]);
// A run marked running can be carried on only once it has not been saved for this long. A run saved more recently may be
// open in another tab, and two tabs must never write the same run. A reload leaves a run marked running, and once this time
// has passed nothing is writing it.
export const STALE_RUNNING_MS = 5 * 60 * 1000;

// How many gauntlet runs the browser keeps. Older ones are removed automatically, and the server keeps its own copies.
export const LOCAL_GAUNTLET_KEEP = 3;

/**
 * Return the part of a batch's settings that decides whether two runs are the same set: the provider, the sets, the models,
 * the questions, the families, the condition, the repeats and the shuffle seed. Lists are sorted, so the order of the ticks
 * does not matter. The result is a string, so two settings can be compared with ===. The provider is part of it, so a
 * Start on one provider never carries on a set made with another. The reply size is not part of it: a reply is an answer
 * to its question whatever the limit, and a cut-off reply is never saved, so the saved replies of a set stay usable.
 */
export function resumeSignature(config) {
  return JSON.stringify({
    platformId: config.platformId ?? null,
    experiment: config.experiment ?? null,
    pushbackSet: config.pushbackSet ?? null,
    questionSet: config.questionSet ?? null,
    models: [...config.models].sort(),
    questions: [...config.questions].sort(),
    families: [...config.families].sort(),
    condition: config.condition ?? null,
    repeats: config.repeats,
    seed: config.seed ?? null,
  });
}

/**
 * Return the newest run that a Start with these settings can carry on, or null. A run qualifies when it is a batch run, has
 * the same signature, and is either in a state that can be carried on or left running and quiet for STALE_RUNNING_MS. runs
 * must be newest first, as listRuns gives them. nowMs is the time now, given so the rule can be tested.
 */
export function findResumableRun(runs, signature, nowMs = Date.now()) {
  for (const run of runs) {
    if (run.config?.kind !== "batch") continue;
    if (!canCarryOn(run, nowMs)) continue;
    if (resumeSignature(run.config) === signature) return run;
  }
  return null;
}

/** Return true when a run may be carried on now: a stopped, paused, planned or failed run, or a running one left quiet. */
function canCarryOn(run, nowMs) {
  if (CARRY_ON_STATUSES.includes(run.status)) return true;
  if (run.status !== "running") return false;
  return nowMs - Date.parse(run.updatedAt) >= STALE_RUNNING_MS;
}

/**
 * Return the ids of this browser's runs that should be copied back from the server. Every batch run comes back. A
 * gauntlet run comes back only while there is room under the gauntlet cap, newest first, so a copy that was removed on
 * purpose does not return on the next page open. Runs held already, and other browsers' runs, are left out.
 */
export function planRestore(summaries, localRuns) {
  const held = new Set(localRuns.map((run) => run.id));
  const localGauntlets = localRuns.filter((run) => run.config?.kind === "gauntlet").length;
  const room = Math.max(0, LOCAL_GAUNTLET_KEEP - localGauntlets);
  const mine = summaries.filter((summary) => summary.mine === true && !held.has(summary.id));
  const batchIds = mine.filter((summary) => summary.kind === "batch").map((summary) => summary.id);
  const gauntlets = mine
    .filter((summary) => summary.kind === "gauntlet")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, room)
    .map((summary) => summary.id);
  return [...batchIds, ...gauntlets];
}

/**
 * Return the ids of the oldest runs of one kind that go over the number to keep. The run being worked on is never
 * included. runs can be in any order; the newest ones are kept.
 */
export function localRunsToRemove(runs, kind, keep, activeId = null) {
  return runs
    .filter((run) => run.config?.kind === kind && run.id !== activeId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(keep)
    .map((run) => run.id);
}
