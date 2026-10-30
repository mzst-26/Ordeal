// Tests for the seeded data generator of the chart benchmark (benchmarks/charts/data-gen.js). The benchmark is only
// fair if every engine draws the same numbers on every run, so the generator must be deterministic for a seed,
// and each case must have the exact count and shape the benchmark names. The last test feeds the generated models
// through the shipped row builders, so the benchmark data is checked against the shape the page really reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCATTER_POINTS, HEATMAP_MODELS, HEATMAP_QUESTIONS, FACET_COUNT, FACET_POINTS, DIFFERENCE_MODELS,
  scatterPoints, heatmapData, facetPoints, differenceData,
} from "../../benchmarks/charts/data-gen.js";
import { conditionRows, questionRows } from "../../frontend/js/compare/vega-rows.js";
import { distinctCount } from "../../frontend/js/compare/differences.js";

test("the same seed gives the same scatter points", () => {
  assert.deepEqual(scatterPoints(500, 7), scatterPoints(500, 7));
});

test("a different seed gives different scatter points", () => {
  assert.notDeepEqual(scatterPoints(500, 7), scatterPoints(500, 8));
});

test("the benchmark's scatter case has 100,000 points with x and y inside 0 to 1", () => {
  const points = scatterPoints(SCATTER_POINTS, 1);
  assert.equal(points.length, 100000);
  for (const point of points) {
    assert.ok(point.x >= 0 && point.x < 1, `x out of range: ${point.x}`);
    assert.ok(point.y >= 0 && point.y < 1, `y out of range: ${point.y}`);
  }
});

test("the heatmap case has 1,000 models, each with 100 question entries", () => {
  const data = heatmapData(HEATMAP_MODELS, HEATMAP_QUESTIONS, 1);
  assert.equal(data.models.length, 1000);
  for (const model of data.models) {
    assert.equal(model.question_flip_rates.length, 100);
  }
});

test("every heatmap rate is a finite number from 0 to 1, and its interval holds it", () => {
  const data = heatmapData(20, 10, 3);
  for (const model of data.models) {
    for (const entry of model.question_flip_rates) {
      const rate = entry.flip_rate_last;
      assert.ok(Number.isFinite(rate.rate) && rate.rate >= 0 && rate.rate <= 1);
      assert.ok(rate.ci_low <= rate.rate && rate.rate <= rate.ci_high);
    }
  }
});

test("the same seed gives the same heatmap data", () => {
  assert.deepEqual(heatmapData(30, 5, 9), heatmapData(30, 5, 9));
});

test("the faceted case has six facets of 20,000 points, each with its own label", () => {
  const rows = facetPoints(FACET_COUNT, FACET_POINTS, 1);
  assert.equal(rows.length, 6 * 20000);
  const labels = new Set(rows.map((row) => row.facet));
  assert.equal(labels.size, 6);
  for (const label of labels) {
    assert.equal(rows.filter((row) => row.facet === label).length, 20000);
  }
});

test("the difference case has fifty models that vary across providers and conditions", () => {
  const data = differenceData(DIFFERENCE_MODELS, 1);
  assert.equal(data.models.length, 50);
  // The shipped row builder turns the models into one row per model and condition, as the page does.
  const rows = conditionRows(data.models, data);
  assert.equal(rows.length, 50 * 3);
  assert.equal(distinctCount(rows, "model"), 50);
  assert.ok(distinctCount(rows, "provider") > 1, "providers should vary");
  assert.ok(distinctCount(rows, "condition") > 1, "conditions should vary");
});

test("the heatmap data gives one finite rate per cell through the shipped row builder", () => {
  const data = heatmapData(1000, 100, 1);
  const rows = questionRows(data.models, data);
  assert.equal(rows.length, 100000);
  assert.ok(rows.every((row) => Number.isFinite(row.rate)));
});
