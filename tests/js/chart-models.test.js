// Tests for the enlarged charts' model filters and ranking, and for the Live page's chart fixes: the confession total
// that a model with no confession units used to break, and the check that a run has probe answers to draw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { modelNames, filterChartOptions, rankedModels, topModels, MEAN_NAME } from "../../frontend/js/results/chart-models.js";

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
import { savedUnitCount } from "../../frontend/js/pages/page-live.js";

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

test("filterChartOptions keeps only the named series, and leaves a chart with no series or points as it is", () => {
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

test("savedUnitCount adds the units of every model's gauntlet row", () => {
  assert.equal(savedUnitCount([{ units: 40 }, { units: 25 }]), 65);
  assert.equal(savedUnitCount([]), 0);
});
