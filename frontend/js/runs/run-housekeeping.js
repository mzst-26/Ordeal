// Decisions about the saved runs kept in this browser, with no storage or page code in them, so the tests can run them
// in Node. Two jobs: find the run that a new Start should carry on with, so one run is never saved twice, and pick the
// old gauntlet copies to drop, so only a few are kept in the browser.

// A run in one of these states can be carried on. A done run is finished, and a running one belongs to another tab.
export const CARRY_ON_STATUSES = Object.freeze(["planned", "paused", "stopped", "failed"]);

// How many gauntlet runs the browser keeps. Older ones are removed automatically, and the server keeps its own copies.
export const LOCAL_GAUNTLET_KEEP = 3;

/**
 * Return the part of a batch's settings that decides whether two runs are the same run: the provider, the sets, the models,
 * the questions, the families, the condition, the repeats, the max tokens and the shuffle seed. Lists are sorted, so the
 * order of the ticks does not matter. The result is a string, so two settings can be compared with ===. The provider is
 * part of it, so a Start on one provider never carries on a run that was made with another. Max tokens is part of it too,
 * because a reply cut off at a different limit is a different reply.
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
    maxTokens: config.maxTokens ?? null,
    seed: config.seed ?? null,
  });
}

/**
 * Return the newest run that a Start with these settings can carry on, or null. A run qualifies when it is a batch
 * run, is in a state that can be carried on, and has the same signature. runs must be newest first, as listRuns gives them.
 */
export function findResumableRun(runs, signature) {
  for (const run of runs) {
    if (run.config?.kind !== "batch") continue;
    if (!CARRY_ON_STATUSES.includes(run.status)) continue;
    if (resumeSignature(run.config) === signature) return run;
  }
  return null;
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
