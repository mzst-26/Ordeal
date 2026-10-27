// Tests for the enlarged charts' model filters and ranking, and for the Live page's chart fixes: the confession total
// that a model with no confession units used to break, and the check that a run has probe answers to draw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { modelNames, filterChartOptions, rankedModels, topModels, MEAN_NAME } from "../site/js/chart-models.js";

test("the mean line is a filter entry, but it is never ranked as a model", () => {
  const options = { lowerIsBetter: true, series: [
    { name: MEAN_NAME, values: [0.1] },
    { name: "A", values: [0.4] },
    { name: "B", values: [0.2] },
  ] };
  assert.deepEqual(modelNames(options), [MEAN_NAME, "A", "B"]);
  assert.deepEqual(rankedModels(options), ["B", "A"]);
  assert.deepEqual(topModels(options, 5, "best"), ["B", "A"]);
});
import { confessionSum, probeDataPresent } from "../site/js/page-live.js";

const LINE = {
  lowerIsBetter: true,
  series: [
    { name: "A", values: [0.2, 0.4] },
    { name: "B", values: [0.9, 0.7] },
    { name: "C", values: [Number.NaN, Number.NaN] },
  ],
};

test("modelNames lists a line chart's series and a scatter chart's labels", () => {
  assert.deepEqual(modelNames(LINE), ["A", "B", "C"]);
  assert.deepEqual(modelNames({ points: [{ label: "X" }, { label: "Y" }] }), ["X", "Y"]);
  assert.deepEqual(modelNames({ segments: [] }), []);
});

test("filterChartOptions keeps only the named series, and leaves a donut as it is", () => {
  const kept = filterChartOptions(LINE, new Set(["A", "C"]));
  assert.deepEqual(kept.series.map((item) => item.name), ["A", "C"]);
  const points = filterChartOptions({ points: [{ label: "X" }, { label: "Y" }] }, new Set(["Y"]));
  assert.deepEqual(points.points.map((point) => point.label), ["Y"]);
  const donut = { segments: [{ label: "S" }] };
  assert.equal(filterChartOptions(donut, new Set()), donut);
});

test("rankedModels ranks a flip-rate chart lowest first, with a model that has no value last", () => {
  assert.deepEqual(rankedModels(LINE), ["A", "B", "C"]);
  const highIsBetter = { series: [{ name: "A", values: [0.2] }, { name: "B", values: [0.9] }] };
  assert.deepEqual(rankedModels(highIsBetter), ["B", "A"]);
});

test("rankedModels ranks a twin-probe chart by hit rate minus false alarm rate, highest first", () => {
  const twins = { points: [
    { label: "P", x: 0.5, y: 0.6 },
    { label: "Q", x: 0.1, y: 0.9 },
    { label: "R", x: Number.NaN, y: 0.9 },
  ] };
  assert.deepEqual(rankedModels(twins), ["Q", "P", "R"]);
});

test("topModels keeps the best or the worst models in ranked order", () => {
  assert.deepEqual(topModels(LINE, 2, "best"), ["A", "B"]);
  assert.deepEqual(topModels(LINE, 2, "worst"), ["B", "C"]);
});

test("confessionSum adds the models that have confession units, and ignores a model with none", () => {
  const rows = [
    { confession_units: 10, capitulated_share: 0, converted_share: 1 },
    { confession_units: 0, capitulated_share: Number.NaN, converted_share: Number.NaN },
    { confession_units: 12, capitulated_share: 0.5, converted_share: 0.5 },
  ];
  assert.equal(confessionSum(rows, "capitulated_share"), 6);
  assert.equal(confessionSum(rows, "converted_share"), 16);
});

test("confessionSum is NaN only when no model has any confession units, or no rows exist", () => {
  assert.ok(Number.isNaN(confessionSum([], "capitulated_share")));
  assert.ok(Number.isNaN(confessionSum([{ confession_units: 0, capitulated_share: Number.NaN }], "capitulated_share")));
});

test("probeDataPresent is false when no probe estimate is a number", () => {
  assert.equal(probeDataPresent([{ estimate: Number.NaN }]), false);
  assert.equal(probeDataPresent([{ estimate: Number.NaN }, { estimate: 0.2 }]), true);
});
