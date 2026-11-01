// Node tests for the ECharts heatmap option builder. The builder is a pure function, so these tests read the option
// object it returns and never touch the DOM or draw a canvas. They check the shape of the option, the cell count, and
// how missing values (null and NaN) are handled. A missing value must never become a cell drawn as zero.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  heatmapOption, heatmapSize, heatmapTooltipLines,
} from "../../frontend/js/compare/echarts-heatmap.js";
import { questionRows } from "../../frontend/js/compare/vega-rows.js";

// The page's light-theme colours, as the page reads them from its tokens (hex, six digits).
const THEME = Object.freeze({
  ink: "#26211C",
  inkSoft: "#5A5048",
  rule: "#D9CDBB",
  surface: "#F5EFE3",
  accent: "#2E5E5B",
});
// The suite name the rows carry. It is not drawn by the heatmap, so any name would do.
const DATA = Object.freeze({ suite: "gauntlet" });

/** A flip rate with no interval, the form the results file uses. */
function rate(value) {
  return { rate: value, ci_low: null, ci_high: null, n: 2 };
}

/** A model with a provider and one flip rate per question, given as [questionId, rate] pairs. */
function model(id, provider, pairs) {
  return {
    id,
    display_name: id,
    provider,
    question_flip_rates: pairs.map(([questionId, value]) => ({
      question_id: questionId,
      flip_rate_last: rate(value),
    })),
  };
}

/** Many models, each with the same list of question ids and a rate of 0.25. */
function manyModels(count, questionIds) {
  const models = [];
  for (let index = 0; index < count; index += 1) {
    const pairs = questionIds.map((questionId) => [questionId, 0.25]);
    models.push(model(`m${String(index).padStart(3, "0")}`, "p", pairs));
  }
  return models;
}

/** The heatmap's data array: one entry per drawn cell, [questionIndex, modelIndex, rate, n]. */
function cellsOf(option) {
  return option.series[0].data;
}

test("one model with three questions: three cells, one model row, three question columns", () => {
  const rows = questionRows([model("solo", "p", [["q1", 0.1], ["q2", 0.2], ["q3", 0.3]])], DATA);
  const option = heatmapOption(rows, THEME);
  assert.equal(option.series[0].type, "heatmap");
  assert.deepEqual(option.yAxis.data, ["solo"]);
  assert.deepEqual(option.xAxis.data, ["q1", "q2", "q3"]);
  assert.equal(cellsOf(option).length, 3);
});

test("three providers: each model is its own row, and the provider does not add rows or columns", () => {
  const rows = questionRows([
    model("alpha", "openai", [["q1", 0.5], ["q2", 0.5]]),
    model("beta", "groq", [["q1", 0.1], ["q2", 0.9]]),
    model("gamma", "mistral", [["q1", 0.2], ["q2", 0.4]]),
  ], DATA);
  const option = heatmapOption(rows, THEME);
  assert.deepEqual(option.yAxis.data, ["alpha", "beta", "gamma"]);
  assert.deepEqual(option.xAxis.data, ["q1", "q2"]);
  assert.equal(cellsOf(option).length, 6);
});

test("a hundred models by twenty-nine questions: a row per model and 2,900 cells", () => {
  const questionIds = Array.from({ length: 29 }, (_, index) => `q${String(index).padStart(2, "0")}`);
  const rows = questionRows(manyModels(100, questionIds), DATA);
  const option = heatmapOption(rows, THEME);
  assert.equal(option.yAxis.data.length, 100);
  assert.equal(option.xAxis.data.length, 29);
  assert.equal(cellsOf(option).length, 2900);
});

test("the dense case of the benchmark, 1,000 models by 100 questions: 100,000 cells", () => {
  const questionIds = Array.from({ length: 100 }, (_, index) => `q${String(index).padStart(3, "0")}`);
  const rows = questionRows(manyModels(1000, questionIds), DATA);
  const option = heatmapOption(rows, THEME);
  assert.equal(cellsOf(option).length, 100000);
});

test("empty data: an option with no axis labels and no cells, and no error", () => {
  const option = heatmapOption([], THEME);
  assert.deepEqual(option.xAxis.data, []);
  assert.deepEqual(option.yAxis.data, []);
  assert.deepEqual(cellsOf(option), []);
  assert.equal(option.series[0].type, "heatmap");
});

test("a missing rate (null from NaN or from no data) draws no cell, and a real zero still draws", () => {
  const rows = questionRows([model("m1", "p", [["q1", NaN], ["q2", 0], ["q3", 0.4]])], DATA);
  rows.push({ modelId: "m1", model: "m1", provider: "p", questionId: "q4", questionSet: "gauntlet", rate: null, n: null });
  const option = heatmapOption(rows, THEME);
  const cells = cellsOf(option);
  assert.equal(cells.length, 2, "only the two real rates are drawn");
  assert.deepEqual(cells.map((cell) => cell[2]), [0, 0.4]);
  assert.deepEqual(option.xAxis.data, ["q1", "q2", "q3", "q4"], "the question still has an axis label");
});

test("the visual map runs from 0 to 1 and uses the surface colour for the lowest rate and the accent for the highest", () => {
  const option = heatmapOption([], THEME);
  assert.equal(option.visualMap.min, 0);
  assert.equal(option.visualMap.max, 1);
  assert.equal(option.visualMap.dimension, 2, "the rate is the third value of each cell");
  const colours = option.visualMap.inRange.color;
  assert.equal(colours.length, 9);
  assert.equal(colours[0], THEME.surface.toLowerCase());
  assert.equal(colours[8], THEME.accent.toLowerCase());
});

test("the option never asks for animation, so a redraw of 100,000 cells starts at once", () => {
  assert.equal(heatmapOption([], THEME).animation, false);
});

test("the tooltip lines use the same titles and percentage format as the Vega heatmap", () => {
  const lines = heatmapTooltipLines({ model: "m1", questionId: "q1", rate: 0.5, n: 2 });
  assert.deepEqual(lines, {
    Model: "m1",
    Question: "q1",
    "Flip rate at last level": "50%",
    "Initially-right units": "2",
  });
});

test("the tooltip says not run for a missing rate or count, and never shows a zero", () => {
  const lines = heatmapTooltipLines({ model: "m1", questionId: "q1", rate: null, n: null });
  assert.equal(lines["Flip rate at last level"], "not run");
  assert.equal(lines["Initially-right units"], "not run");
});

test("the size grows with the number of models and questions, and never shrinks below the minimum", () => {
  const small = heatmapSize([]);
  assert.ok(small.width >= 320 && small.height >= 160, "an empty view keeps the minimum size");
  const questionIds = Array.from({ length: 100 }, (_, index) => `q${index}`);
  const big = heatmapSize(questionRows(manyModels(50, questionIds), DATA));
  assert.ok(big.width > small.width, "more questions make the view wider");
  assert.ok(big.height > small.height, "more models make the view taller");
});
