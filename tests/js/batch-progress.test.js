// Tests for the batch progress numbers (frontend/js/runs/batch-progress.js). A Start that carries on a saved set must show
// the work already saved, not zero, and its calls, reused replies and failures must add up across every Start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idleCountsFor, unitsDoneToShow, countsToShow } from "../../frontend/js/runs/batch-progress.js";

/** Return n distinct unit keys, numbered from start, in the form the page uses for a unit. */
function unitKeys(n, start = 0) {
  return Array.from({ length: n }, (_, index) => JSON.stringify(["m", `q${start + index}`, 1]));
}

test("units done is the saved units alone when no new unit has finished", () => {
  // 88 units were saved for the first condition, and none has finished in this Start.
  assert.equal(unitsDoneToShow(["none"], { none: new Set(unitKeys(88)) }, { none: new Set() }), 88);
});

test("units done adds the new units that finish, and counts a replayed unit only once", () => {
  // 88 saved; this Start finishes 10 new units and replays 5 of the saved ones: 98 distinct units, not 103.
  const saved = new Set(unitKeys(88));
  const finished = new Set([...unitKeys(5), ...unitKeys(10, 88)]);
  assert.equal(unitsDoneToShow(["none"], { none: saved }, { none: finished }), 98);
});

test("units done counts the saved units of each condition separately, with the new ones of each", () => {
  const none = new Set(unitKeys(10));
  const control = new Set();
  assert.equal(unitsDoneToShow(["none", "control"], { none, control }, { control: new Set(unitKeys(4)) }), 14);
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
