// Tests for the Run to replay list on the Live page. The list is the Saved list of the Batch page, so every run in it is
// listed. A run replays on its own suite, so any suite the site offers can be replayed. A run that cannot be replayed
// says why when it is chosen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replayProblem } from "../../frontend/js/pages/page-live.js";
import { savedRunRows, KIND_BATCH, SAVED_RUNS_CHANGED } from "../../frontend/js/runs/saved-runs.js";
import { importRunDocument } from "../../frontend/js/store/run-store.js";
import { createMemoryAdapter } from "../../frontend/js/store/memory-adapter.js";
import { fixedChoiceMenu, setsOfChoice } from "../../frontend/js/suites/suites.js";

const SAVED_STEP = { steps: [{ condition: "none", model: "M1", question_id: "q1", repeat: 1, step: "level_0", reply: "A" }] };

/** Return a saved batch run document on the given sets, with or without saved replies. */
function batchRun(label, sets, saved = true) {
  return importRunDocument(createMemoryAdapter(), {
    label,
    status: "stopped",
    config: { kind: KIND_BATCH, models: ["M1"], pushbackSet: sets.pushbackSet, questionSet: sets.questionSet },
    plannedUnits: ["a"],
    results: saved ? { a: SAVED_STEP } : {},
  });
}

test("replayProblem accepts a run with saved replies on any suite the site offers", async () => {
  for (const choice of fixedChoiceMenu()) {
    const run = await batchRun(choice.label, setsOfChoice(choice.value));
    assert.equal(replayProblem(run), "", choice.value);
  }
});

test("replayProblem says why a run with no replies cannot be replayed", async () => {
  const run = await batchRun("empty", setsOfChoice(fixedChoiceMenu()[0].value), false);
  assert.match(replayProblem(run), /has no saved replies/);
});

test("replayProblem says why a run on a suite the site does not have cannot be replayed", async () => {
  const run = await batchRun("unknown", { pushbackSet: "other", questionSet: "other" });
  assert.match(replayProblem(run), /suite this site does not have/);
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
