// Tests for the batch progress numbers (frontend/js/runs/batch-progress.js). A Start that carries on a saved set must show
// the work already saved, not zero, and its calls, reused replies and failures must add up across every Start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idleCountsFor, unitsDoneToShow, countsToShow } from "../../frontend/js/runs/batch-progress.js";

test("units done shows the saved units when a Start has not reached them yet", () => {
  // 88 units were saved for the first condition; its runner has replayed none yet, so the bar keeps 88.
  assert.equal(unitsDoneToShow(["none"], { none: 88 }, {}), 88);
});

test("units done counts the runner's progress once it passes the saved units, without adding them twice", () => {
  // The runner replays the 88 saved units, then finishes two new ones: 90, not 178.
  assert.equal(unitsDoneToShow(["none"], { none: 88 }, { none: 90 }), 90);
});

test("units done adds the conditions of one batch, each with its own saved and finished units", () => {
  assert.equal(unitsDoneToShow(["none", "control"], { none: 10, control: 0 }, { control: 4 }), 14);
});

test("calls, reused and failed show the earlier Starts' totals plus this Start", () => {
  const shown = countsToShow({ calls: 88, reused: 3, failed: 2 }, { calls: 5, reused: 1, failed: 0 });
  assert.deepEqual(shown, { calls: 93, reused: 4, failed: 2 });
});

// While the page is idle, a saved set on the form keeps its saved progress. Changing the form to another set shows zero.
test("while idle, the saved progress of the set on the form is kept; another set shows zero", () => {
  const shown = { signature: "set-a", done: 88, calls: 88, reused: 3, failed: 2 };
  assert.deepEqual(idleCountsFor(shown, true, 135), { done: 88, total: 135, calls: 88, reused: 3, failed: 2 });
  assert.deepEqual(idleCountsFor(shown, false, 135), { done: 0, total: 135, calls: 0, reused: 0, failed: 0 });
  assert.deepEqual(idleCountsFor(null, true, 135), { done: 0, total: 135, calls: 0, reused: 0, failed: 0 });
});
