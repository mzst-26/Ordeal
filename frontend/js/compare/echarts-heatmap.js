// ECharts option builder for the comparison heatmap (model by question). Pure functions, no DOM, so the node tests
// can read the option object. The page draws it with heat-chart.js.
// Why ECharts here: the Vega-Lite heatmap took about 8 seconds to draw 1,000 models by 100 questions, and ECharts drew
// the same cells in about 0.5 seconds (benchmarks/charts/last-run.json, synthetic data on one machine). The small
// multiples and the dot plot stay on Vega, because they are small and the differences rule is written for them.
// The rows are the same ones the Vega views use (questionRows in vega-rows.js). A missing rate draws no cell, so it is
// never shown as zero. The colour ramp and the rate format are the same as the Vega heatmap.
import { uniqueValues, rampColours } from "./vega-specs.js";
import { pct } from "./derive.js";
import { finiteOrNull } from "./vega-rows.js";

// The label of the colour scale. It is the same title the Vega heatmap uses, so the two read the same.
const RATE_TITLE = "Flip rate at last level";
// The axis titles, as the Vega heatmap shows them.
const QUESTION_TITLE = "Question";
const MODEL_TITLE = "Model";
// The tooltip names the Vega heatmap uses for the counts.
const UNITS_TITLE = "Initially-right units";
const NOT_RUN = "not run";
// The number of colour steps in the ramp, the same nine steps the Vega heatmap uses.
const RAMP_STEPS = 9;
// Sizes of one cell in pixels, and the smallest plot. These match the Vega heatmap, so the two draw at the same size.
const CELL_WIDTH = 16;
const CELL_HEIGHT = 14;
const MIN_PLOT_WIDTH = 320;
const MIN_PLOT_HEIGHT = 160;
// Space around the plot, in pixels, for the model names (left), the colour scale and its title (right), the title
// (top) and the question axis title (bottom). A fixed margin keeps the labels from being cut off.
const MARGIN = Object.freeze({ left: 140, right: 110, top: 40, bottom: 60 });

/**
 * The cells to draw, as [questionIndex, modelIndex, rate, n]. The first two are the positions on the axes, the third
 * is the value the colour scale reads, and the fourth is the count the tooltip shows. A row with no rate is left out.
 */
function cellsFor(rows, questions, models) {
  const questionIndex = new Map(questions.map((question, index) => [question, index]));
  const modelIndex = new Map(models.map((model, index) => [model, index]));
  const cells = [];
  for (const row of rows) {
    const value = finiteOrNull(row.rate);
    if (value === null) {
      continue;
    }
    cells.push([questionIndex.get(row.questionId), modelIndex.get(row.model), value, row.n]);
  }
  return cells;
}

/** The text colour used for the axis labels, the scale labels and the title. Taken from the page's theme. */
function textStyle(colour, size) {
  return { color: colour, fontSize: size || 12 };
}

/**
 * The ECharts option for the heatmap: one cell per model and question, coloured by its flip rate on a fixed 0 to 1
 * scale. The axes list the questions and the models in the order the rows give them. Animation is off, so a redraw
 * of 100,000 cells appears at once.
 */
export function heatmapOption(rows, theme) {
  const questions = uniqueValues(rows, "questionId");
  const models = uniqueValues(rows, "model");
  return {
    animation: false,
    grid: { left: MARGIN.left, right: MARGIN.right, top: MARGIN.top, bottom: MARGIN.bottom },
    title: { text: RATE_TITLE, right: 0, top: 0, textStyle: textStyle(theme.ink) },
    xAxis: {
      type: "category",
      data: questions,
      name: QUESTION_TITLE,
      nameLocation: "middle",
      nameGap: 36,
      axisLabel: textStyle(theme.inkSoft, 10),
      axisLine: { lineStyle: { color: theme.rule } },
    },
    yAxis: {
      type: "category",
      data: models,
      name: MODEL_TITLE,
      nameLocation: "middle",
      nameGap: 110,
      axisLabel: textStyle(theme.inkSoft, 11),
      axisLine: { lineStyle: { color: theme.rule } },
    },
    // The visual map is the colour legend. dimension 2 is the rate in each cell, so the colour follows the rate.
    visualMap: {
      type: "continuous",
      min: 0,
      max: 1,
      dimension: 2,
      calculable: false,
      orient: "vertical",
      right: 0,
      top: "middle",
      text: ["100%", "0%"],
      textStyle: textStyle(theme.inkSoft),
      inRange: { color: rampColours(theme.surface, theme.accent, RAMP_STEPS) },
    },
    series: [{ type: "heatmap", data: cellsFor(rows, questions, models) }],
  };
}

/**
 * The size of the chart box in pixels: the plot (one cell per question and model, never smaller than the minimum)
 * plus the margins around it. The page sets the chart box to this size, as the Vega heatmap sets its own.
 */
export function heatmapSize(rows) {
  const questions = uniqueValues(rows, "questionId").length;
  const models = uniqueValues(rows, "model").length;
  const plotWidth = Math.max(MIN_PLOT_WIDTH, questions * CELL_WIDTH);
  const plotHeight = Math.max(MIN_PLOT_HEIGHT, models * CELL_HEIGHT);
  return {
    width: plotWidth + MARGIN.left + MARGIN.right,
    height: plotHeight + MARGIN.top + MARGIN.bottom,
  };
}

/**
 * The tooltip for one cell, as titles and values, with the same titles as the Vega heatmap tooltip. A missing rate or
 * count says "not run", so the tooltip never shows a zero that was not measured.
 */
export function heatmapTooltipLines(cell) {
  const rate = finiteOrNull(cell.rate);
  const count = finiteOrNull(cell.n);
  return {
    Model: cell.model,
    Question: cell.questionId,
    [RATE_TITLE]: rate === null ? NOT_RUN : pct(rate, 0),
    [UNITS_TITLE]: count === null ? NOT_RUN : String(count),
  };
}
