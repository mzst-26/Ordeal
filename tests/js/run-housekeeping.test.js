// Tests for frontend/js/run-housekeeping.js. These rules decide three things: which saved run a new Start carries on
// with (so a run is never saved twice), which gauntlet copies to keep in the browser, and which runs come back from
// the server. They are pure functions on plain objects, so no storage or network is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_GAUNTLET_KEEP,
  resumeSignature,
  findResumableRun,
  localRunsToRemove,
  planRestore,
} from "../../frontend/js/run-housekeeping.js";

const CONFIG = {
  kind: "batch",
  pushbackSet: "a",
  questionSet: "b",
  models: ["m2", "m1"],
  questions: ["q2", "q1"],
  families: ["gauntlet", "twins"],
  condition: "none",
  repeats: 1,
};

// The order of the ticks does not change the signature, so the same choice always matches.
test("the signature is the same when only the order of the ticks changes", () => {
  const reordered = { ...CONFIG, models: ["m1", "m2"], questions: ["q1", "q2"], families: ["twins", "gauntlet"] };
  assert.equal(resumeSignature(CONFIG), resumeSignature(reordered));
});

// A different model, repeat or condition is a different run, so it gets its own saved run.
test("the signature changes when the models, repeats or condition change", () => {
  assert.notEqual(resumeSignature(CONFIG), resumeSignature({ ...CONFIG, models: ["m1"] }));
  assert.notEqual(resumeSignature(CONFIG), resumeSignature({ ...CONFIG, repeats: 2 }));
  assert.notEqual(resumeSignature(CONFIG), resumeSignature({ ...CONFIG, condition: "control" }));
});

// A stopped run with the same settings is carried on, so the same settings never make a second saved run.
test("a Start with the same settings carries on the stopped run", () => {
  const stopped = { id: "run-1", status: "stopped", config: CONFIG };
  assert.equal(findResumableRun([stopped], resumeSignature(CONFIG)), stopped);
});

// A done run is finished, so a new Start with the same settings makes a new run.
test("a finished run is not carried on", () => {
  const done = { id: "run-1", status: "done", config: CONFIG };
  assert.equal(findResumableRun([done], resumeSignature(CONFIG)), null);
});

// A run of the other kind, or with other settings, is never picked.
test("a gauntlet run or a run with other settings is not carried on", () => {
  const gauntlet = { id: "g", status: "stopped", config: { ...CONFIG, kind: "gauntlet" } };
  const other = { id: "o", status: "stopped", config: { ...CONFIG, models: ["m9"] } };
  assert.equal(findResumableRun([gauntlet, other], resumeSignature(CONFIG)), null);
});

// When more than one run fits, the newest is picked. runs are given newest first, as listRuns gives them.
test("the newest matching run is the one carried on", () => {
  const newer = { id: "new", status: "paused", config: CONFIG };
  const older = { id: "old", status: "stopped", config: CONFIG };
  assert.equal(findResumableRun([newer, older], resumeSignature(CONFIG)).id, "new");
});

// Only the newest gauntlet copies are kept in the browser. The oldest go, and the run being worked on stays.
test("the oldest gauntlet copies go, beyond the keep count, and the active run stays", () => {
  const runs = [1, 2, 3, 4, 5].map((n) => ({ id: `g${n}`, createdAt: n, config: { kind: "gauntlet" } }));
  assert.equal(LOCAL_GAUNTLET_KEEP, 3);
  assert.deepEqual(localRunsToRemove(runs, "gauntlet", 3), ["g2", "g1"]);
  assert.deepEqual(localRunsToRemove(runs, "gauntlet", 3, "g1"), ["g2"]);
});

// Batch runs are not capped, so they are never picked for removal here.
test("batch runs are never removed by the gauntlet cap", () => {
  const runs = [{ id: "b", createdAt: 1, config: { kind: "batch" } }];
  assert.deepEqual(localRunsToRemove(runs, "gauntlet", 0), []);
});

// Every batch run of this browser comes back, but only as many gauntlet copies as the cap leaves room for.
test("a restore brings back every batch run and only the gauntlet copies that fit under the cap", () => {
  const summaries = [
    { id: "b1", kind: "batch", createdAt: 1, mine: true },
    { id: "g1", kind: "gauntlet", createdAt: 2, mine: true },
    { id: "g2", kind: "gauntlet", createdAt: 3, mine: true },
    { id: "g3", kind: "gauntlet", createdAt: 4, mine: true },
    { id: "theirs", kind: "batch", createdAt: 5, mine: false },
  ];
  const localRuns = [{ id: "held", config: { kind: "gauntlet" } }];
  assert.deepEqual(planRestore(summaries, localRuns), ["b1", "g3", "g2"]);
});

// A copy that was removed on purpose does not come back while the browser is at its gauntlet cap.
test("a restore brings back no gauntlet copy when the browser is already at the cap", () => {
  const summaries = [{ id: "g9", kind: "gauntlet", createdAt: 9, mine: true }];
  const localRuns = [1, 2, 3].map((n) => ({ id: `h${n}`, config: { kind: "gauntlet" } }));
  assert.deepEqual(planRestore(summaries, localRuns), []);
});
