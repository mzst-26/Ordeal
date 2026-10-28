// Tests for the rows of the Saved runs list: a run with every planned unit saved is marked complete, so its button says
// Open, and a run with units still to send is not complete, so its button says Resume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { savedRunRows } from "../../frontend/js/runs/saved-runs.js";
import { importRunDocument } from "../../frontend/js/store/run-store.js";
import { createMemoryAdapter } from "../../frontend/js/store/memory-adapter.js";

const SAVED_STEP = { steps: [{ condition: "none", model: "M1", question_id: "q1", repeat: 1, step: "level_0", reply: "A" }] };

/** Save a batch run with the given planned units and saved units, and the given status. */
function batchRun(adapter, label, planned, saved, status) {
  const results = Object.fromEntries(saved.map((key) => [key, SAVED_STEP]));
  return importRunDocument(adapter, { label, status, config: { kind: "batch" }, plannedUnits: planned, results });
}

test("a run with every planned unit saved is complete, and a run with units left is not", async () => {
  const adapter = createMemoryAdapter();
  await batchRun(adapter, "all saved", ["a", "b"], ["a", "b"], "stopped");
  await batchRun(adapter, "some left", ["a", "b"], ["a"], "stopped");
  const rows = await savedRunRows(adapter, "batch");
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
  assert.equal(byLabel["all saved"].complete, true);
  assert.equal(byLabel["all saved"].resumable, true);
  assert.equal(byLabel["some left"].complete, false);
  assert.equal(byLabel["some left"].resumable, true);
});

test("a complete run that is marked done is still complete, so it can be opened", async () => {
  const adapter = createMemoryAdapter();
  await batchRun(adapter, "done run", ["a"], ["a"], "done");
  const [row] = await savedRunRows(adapter, "batch");
  assert.equal(row.complete, true);
  assert.equal(row.resumable, false);
});
