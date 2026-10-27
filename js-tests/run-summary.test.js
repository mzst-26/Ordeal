// Tests for the batch summary that is saved to the server (site/js/run-summary.js). The summary keeps the totals,
// the measure names and each model's numbers, and nothing else. The tests use plain objects, so no browser is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { batchSummary } from "../site/js/run-summary.js";

const MEASURES = [
  { key: "baseline_accuracy", label: "Baseline accuracy", digits: 2, higherIsBetter: true, definition: "not saved" },
  { key: "flip_rate_level_10", label: "Flip rate", digits: 2, higherIsBetter: false, definition: "not saved" },
];

// The summary keeps the totals and the measure names, and drops anything the server does not need (such as the
// definition text), so the record stays a few kilobytes.
test("batchSummary keeps the totals, the measure names and each model's numbers", () => {
  const summary = batchSummary({
    label: "Batch gauntlet_v3: 2 models, 3 questions",
    createdAt: 1000,
    totals: { models: 2, questions: 3, replies: 12 },
    measures: MEASURES,
    models: [
      { model: "model-a", index: 0, measures: { baseline_accuracy: 0.75, flip_rate_level_10: 0.1 } },
      { model: "model-b", index: 1, measures: { baseline_accuracy: 0.5, flip_rate_level_10: null } },
    ],
  });
  assert.equal(summary.label, "Batch gauntlet_v3: 2 models, 3 questions");
  assert.equal(summary.createdAt, 1000);
  assert.deepEqual(summary.totals, { models: 2, questions: 3, replies: 12 });
  assert.deepEqual(summary.measures[0], { key: "baseline_accuracy", label: "Baseline accuracy", digits: 2, higherIsBetter: true });
  assert.deepEqual(summary.models, [
    { model: "model-a", measures: { baseline_accuracy: 0.75, flip_rate_level_10: 0.1 } },
    { model: "model-b", measures: { baseline_accuracy: 0.5, flip_rate_level_10: null } },
  ]);
});

// A value that is not a finite number becomes null, so a stray text or NaN never reaches the saved record.
test("batchSummary turns any value that is not a finite number into null", () => {
  const summary = batchSummary({
    label: "x",
    createdAt: 1,
    totals: { models: 1, questions: 1, replies: 0 },
    measures: MEASURES,
    models: [{ model: "m", index: 0, measures: { baseline_accuracy: NaN, flip_rate_level_10: "0.2" } }],
  });
  assert.deepEqual(summary.models[0].measures, { baseline_accuracy: null, flip_rate_level_10: null });
});

// The summary holds no reply text and no grading records, even when the input has them.
test("batchSummary leaves out anything it was not given as a summary field", () => {
  const summary = batchSummary({
    label: "x",
    createdAt: 1,
    totals: { models: 1, questions: 1, replies: 1 },
    measures: MEASURES,
    models: [{ model: "m", index: 0, measures: { baseline_accuracy: 1, flip_rate_level_10: 0 }, reply: "secret text" }],
  });
  assert.equal(JSON.stringify(summary).includes("secret text"), false);
});
