// Tests for frontend/js/suites/condition-choice.js. The Batch page ticks several system prompt conditions and runs one saved run
// for each, so these helpers must keep the order, add the plans up, and union the lists without repeats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergePlans, unionInOrder } from "../../frontend/js/suites/condition-choice.js";

// Each condition makes its own plan. The plan line for a model is the sum over every condition.
test("plans for two conditions add up per model and in total", () => {
  const first = {
    models: [{ model: "a", saved: 1, atMostNew: 4 }, { model: "b", saved: 0, atMostNew: 5 }],
    totals: { saved: 1, atMostNew: 9 },
  };
  const second = {
    models: [{ model: "a", saved: 2, atMostNew: 3 }],
    totals: { saved: 2, atMostNew: 3 },
  };
  assert.deepEqual(mergePlans([first, second]), {
    models: [
      { model: "a", saved: 3, atMostNew: 7 },
      { model: "b", saved: 0, atMostNew: 5 },
    ],
    totals: { saved: 3, atMostNew: 12 },
  });
});

// With no plans there is nothing to show, so the sums are all zero.
test("merging no plans gives empty totals", () => {
  assert.deepEqual(mergePlans([]), { models: [], totals: { saved: 0, atMostNew: 0 } });
});

// Loading several runs shows every model and question any of them used, each one time.
test("union keeps first-seen order and drops repeats", () => {
  assert.deepEqual(unionInOrder([["m1", "m2"], ["m2", "m3"]]), ["m1", "m2", "m3"]);
});
