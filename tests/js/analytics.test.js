// Tests for frontend/js/analytics.js. The module is pure: it takes plain per-model measure objects,
// shaped like { model, measures: { <key>: number|null } }, and never touches the DOM or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MEASURES, normalise, rankModels, heatmapMatrix, summaryStats, shareOfMax, theoreticalMax } from "../../frontend/js/analytics.js";

test("MEASURES lists the eight batch table measures with their labels and directions", () => {
  assert.deepEqual(MEASURES.map((m) => m.label), [
    "Units (questions right at the start)",
    "Baseline accuracy",
    "Flip at level 10",
    "Mean Breaking Point",
    "Final correct share",
    "Capitulated share",
    "Converted share",
    "Acceptance mean",
  ]);
  const higher = Object.fromEntries(MEASURES.map((m) => [m.key, m.higherIsBetter]));
  assert.deepEqual(higher, {
    units: true,
    baseline_accuracy: true,
    flip_rate_level_10: false,
    mean_spine_score: true,
    final_correct_share: true,
    capitulated_share: false,
    converted_share: false,
    acceptance_mean: true,
  });
});

test("normalise returns an empty array for an empty input", () => {
  assert.deepEqual(normalise([], true), []);
});

test("normalise keeps null and NaN as null and does not count them", () => {
  assert.deepEqual(normalise([null, 2, NaN, 4], true), [null, 0, null, 1]);
});

test("normalise returns all nulls when no value is usable", () => {
  assert.deepEqual(normalise([null, NaN, null], true), [null, null, null]);
});

test("normalise gives a single value the middle score", () => {
  assert.deepEqual(normalise([7], true), [0.5]);
  assert.deepEqual(normalise([7], false), [0.5]);
});

test("normalise gives 0.5 to every non-null value when all values are equal", () => {
  assert.deepEqual(normalise([3, 3, null, 3], true), [0.5, 0.5, null, 0.5]);
  assert.deepEqual(normalise([3, 3], false), [0.5, 0.5]);
});

test("normalise scales a higher-is-better list so the largest value is 1", () => {
  assert.deepEqual(normalise([10, 20, 30], true), [0, 0.5, 1]);
});

test("normalise inverts a lower-is-better list so the smallest value is 1", () => {
  assert.deepEqual(normalise([10, 20, 30], false), [1, 0.5, 0]);
});

test("rankModels sorts best first and puts nulls last", () => {
  const rows = [
    { model: "a", measures: { baseline_accuracy: 0.4 } },
    { model: "b", measures: { baseline_accuracy: null } },
    { model: "c", measures: { baseline_accuracy: 0.9 } },
    { model: "d", measures: { baseline_accuracy: 0.6 } },
  ];
  assert.deepEqual(rankModels(rows, "baseline_accuracy").map((r) => r.model), ["c", "d", "a", "b"]);
});

test("rankModels puts the lowest value first for a lower-is-better measure", () => {
  const rows = [
    { model: "a", measures: { capitulated_share: 0.3 } },
    { model: "b", measures: { capitulated_share: 0.1 } },
    { model: "c", measures: { capitulated_share: null } },
  ];
  assert.deepEqual(rankModels(rows, "capitulated_share").map((r) => r.model), ["b", "a", "c"]);
});

test("rankModels is stable on ties and keeps the input order", () => {
  const rows = [
    { model: "x", measures: { flip_rate_level_10: 0.2 } },
    { model: "y", measures: { flip_rate_level_10: 0.2 } },
    { model: "z", measures: { flip_rate_level_10: 0.1 } },
    { model: "w", measures: { flip_rate_level_10: 0.2 } },
  ];
  assert.deepEqual(rankModels(rows, "flip_rate_level_10").map((r) => r.model), ["z", "x", "y", "w"]);
});

test("rankModels does not change the input array", () => {
  const rows = [
    { model: "a", measures: { units: 1 } },
    { model: "b", measures: { units: 5 } },
  ];
  rankModels(rows, "units");
  assert.deepEqual(rows.map((r) => r.model), ["a", "b"]);
});

test("heatmapMatrix normalises each measure column and keeps nulls as null", () => {
  const rows = [
    { model: "alpha", measures: { baseline_accuracy: 0.2, capitulated_share: 0.5, units: null } },
    { model: "beta", measures: { baseline_accuracy: 0.6, capitulated_share: 0.1, units: 40 } },
  ];
  const matrix = heatmapMatrix(rows, ["baseline_accuracy", "capitulated_share", "units"]);
  assert.deepEqual(matrix, {
    models: ["alpha", "beta"],
    measures: ["baseline_accuracy", "capitulated_share", "units"],
    cells: [
      [0, 0, null],
      [1, 1, 0.5],
    ],
  });
});

test("heatmapMatrix returns empty lists for no models", () => {
  assert.deepEqual(heatmapMatrix([], ["units"]), { models: [], measures: ["units"], cells: [] });
});

test("summaryStats ignores null, NaN and non-number values", () => {
  assert.deepEqual(summaryStats([1, null, NaN, 3, "4", undefined, 5]), { min: 1, max: 5, mean: 3, count: 3 });
});

test("summaryStats returns null statistics and count 0 when nothing is usable", () => {
  assert.deepEqual(summaryStats([]), { min: null, max: null, mean: null, count: 0 });
  assert.deepEqual(summaryStats([null, NaN]), { min: null, max: null, mean: null, count: 0 });
});

test("summaryStats gives the same min and max for one value", () => {
  assert.deepEqual(summaryStats([0.25]), { min: 0.25, max: 0.25, mean: 0.25, count: 1 });
});

// The top of the scale for Mean Breaking Point is one above the last push, so 13 for a 12-level ladder.
test("Mean Breaking Point tops out one above the last push", () => {
  assert.equal(theoreticalMax("mean_spine_score", { levelCount: 12, unitCount: 40 }), 13);
});

// Units tops out at every question and repeat in the batch.
test("units top out at the number of units in the batch", () => {
  assert.equal(theoreticalMax("units", { levelCount: 12, unitCount: 40 }), 40);
});

// Shares such as flip rate top out at 1, whatever the other models score.
test("shares top out at 1", () => {
  assert.equal(theoreticalMax("flip_rate_level_10", { levelCount: 12, unitCount: 40 }), 1);
});

// The bar is the value over the top, so 7.7 out of 13 is about 59 percent, not the full bar of the best model.
test("a value is drawn as its share of the top, not of the best model", () => {
  assert.ok(Math.abs(shareOfMax(7.7, 13) - 7.7 / 13) < 1e-9);
});

// A missing value has no bar, and a top of 0 has nothing to divide by.
test("shareOfMax gives null for a missing value or a top of 0", () => {
  assert.equal(shareOfMax(null, 13), null);
  assert.equal(shareOfMax(3, 0), null);
});
