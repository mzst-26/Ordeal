// Tests for the Run to replay list on the Live page. The list is the Saved list of the Batch page, so every run in it is
// listed. Choosing a run that cannot be replayed on the Live suite says why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replayProblem } from "../site/js/page-live.js";
import { savedRunRows, KIND_BATCH, SAVED_RUNS_CHANGED } from "../site/js/saved-runs.js";
import { importRunDocument } from "../site/js/store/run-store.js";
import { createMemoryAdapter } from "../site/js/store/memory-adapter.js";
import { choiceOfSuite } from "../site/js/suites.js";

const SUITE = { ladderName: "v3", questionSet: "easy", name: "gauntlet_v3+easy" };
const SAVED_STEP = { steps: [{ condition: "none", model: "M1", question_id: "q1", repeat: 1, step: "level_0", reply: "A" }] };

/** Return a saved batch run document on the given sets, with the given saved units. */
function batchRun(label, sets, saved) {
  const results = saved ? { a: SAVED_STEP } : {};
  return importRunDocument(createMemoryAdapter(), {
    label,
    status: "stopped",
    config: { kind: KIND_BATCH, models: ["M1"], pushbackSet: sets.pushbackSet, questionSet: sets.questionSet },
    plannedUnits: ["a"],
    results,
  });
}

test("replayProblem accepts a run on the replay's suite that has replies", async () => {
  const wanted = choiceOfSuite(SUITE);
  const run = await batchRun("on suite", wanted, true);
  assert.equal(replayProblem(run, SUITE), "");
});

test("replayProblem says why a run with no replies cannot be replayed", async () => {
  const wanted = choiceOfSuite(SUITE);
  const run = await batchRun("empty", wanted, false);
  assert.match(replayProblem(run, SUITE), /has no saved replies/);
});

test("replayProblem says why a run on another suite cannot be replayed here", async () => {
  const run = await batchRun("other", { pushbackSet: "other", questionSet: "other" }, true);
  assert.match(replayProblem(run, SUITE), /made on another suite/);
});

test("the Run to replay list is the Batch page's Saved list, so every batch run is listed", async () => {
  const adapter = createMemoryAdapter();
  await importRunDocument(adapter, { label: "first", status: "stopped", config: { kind: KIND_BATCH }, plannedUnits: ["a"], results: {} });
  await importRunDocument(adapter, { label: "second", status: "stopped", config: { kind: "live" }, plannedUnits: ["a"], results: {} });
  const rows = await savedRunRows(adapter, KIND_BATCH);
  assert.deepEqual(rows.map((row) => row.label), ["first"]);
});

test("the Batch page announces its list changes under one event name", () => {
  assert.equal(typeof SAVED_RUNS_CHANGED, "string");
  assert.ok(SAVED_RUNS_CHANGED.length > 0);
});
