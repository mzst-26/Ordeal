// Tests for the pure helpers behind "Skip to end" in the Live page replay (site/js/page-live.js).
// Importing the module does nothing on its own, so these tests only call the exported helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { remainingReplaySteps, canSkipReplay } from "../site/js/page-live.js";

const items = [
  { kind: "start", ref: { model: "m1", questionId: "q1", repeat: 1 } },
  { kind: "reply", ref: { model: "m1", questionId: "q1", repeat: 1 } },
  { kind: "end", ref: { model: "m1", questionId: "q1", repeat: 1 } },
  { kind: "start", ref: { model: "m2", questionId: "q1", repeat: 1 } },
];

test("remainingReplaySteps returns the steps from the cursor on", () => {
  assert.deepEqual(remainingReplaySteps(items, 0), items);
  assert.deepEqual(remainingReplaySteps(items, 2), items.slice(2));
  assert.equal(remainingReplaySteps(items, 3).length, 1);
});

test("remainingReplaySteps returns nothing when the cursor is at the end", () => {
  assert.deepEqual(remainingReplaySteps(items, items.length), []);
  assert.deepEqual(remainingReplaySteps(items, items.length + 5), []);
  assert.deepEqual(remainingReplaySteps([], 0), []);
});

test("canSkipReplay allows a skip only in replay mode, with no live run and steps left", () => {
  assert.equal(canSkipReplay({ mode: "replay", cursor: 1, length: 4, liveRunning: false }), true);
  assert.equal(canSkipReplay({ mode: "replay", cursor: 4, length: 4, liveRunning: false }), false);
  assert.equal(canSkipReplay({ mode: "live", cursor: 1, length: 4, liveRunning: false }), false);
  assert.equal(canSkipReplay({ mode: "replay", cursor: 1, length: 4, liveRunning: true }), false);
});
