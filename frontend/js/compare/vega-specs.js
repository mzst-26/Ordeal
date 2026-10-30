// Vega-Lite spec builders for the comparison views. Pure functions, no DOM, so the node tests can compile and
// render every spec. Each builder takes flat rows (from vega-rows.js) and returns a plain JSON spec.
// Three views: small multiples (metric by model, one panel per condition or provider), a dot plot with error bars
// (model by condition), and a heatmap (model by question). The page draws only the first two with Vega. The heatmap
// moved to ECharts (echarts-heatmap.js). Its Vega builder stays here, because the chart benchmark still draws it to
// reproduce the Vega comparison, and the tests keep it working.
// Colours are passed in as hex values from the page's theme, because a canvas or SVG mark cannot read a CSS
// variable. The page reads the tokens and calls these builders again when the colour scheme changes.
import { distinctCount } from "./differences.js";

// The most series a colour field may have. The three categorical theme colours were validated as a set (dataviz
// check: the first three slots pass all pairs). A fourth colour would need a hue the page does not validate, so a
// field with more values gets no colour, and the model is named on the axis instead.
export const MAX_SERIES = 3;
// The number of steps in the sequential heatmap ramp, from the surface colour (near zero) to the accent (high).
const RAMP_STEPS = 9;
// Plot sizes in pixels. A panel is PANEL_WIDTH wide; the dot plot and heatmap grow with the number of rows.
const PANEL_WIDTH = 160;
// Each model adds this many pixels to a panel's width, so the model names on its axis stay readable.
const PANEL_STEP = 14;
const PANEL_HEIGHT = 200;
const DOT_STEP = 34;
const DOT_HEIGHT = 260;
const HEAT_CELL_WIDTH = 16;
const HEAT_CELL_HEIGHT = 14;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 160;
// Marker and error-bar sizes, in pixels. Thin marks and 2px lines follow the dataviz mark specs.
const POINT_SIZE = 60;
const BAR_WIDTH = 2;
// The label for each field, shown as the axis, legend or facet title.
const FIELD_TITLES = {
  model: "Model",
  modelId: "Model",
  provider: "Provider",
  condition: "Condition",
  questionSet: "Question set",
  pushback: "Pushback set",
};
// The names of the three conditions, as the legend and the panel titles show them.
const CONDITION_NAMES = { none: "No system prompt", mitigation: "Mitigation prompt", control: "Control prompt" };
// The rate axis and tooltip format: a percentage with no decimals.
const RATE_FORMAT = ".0%";
const RATE_TITLE = "Flip rate at last level";

/** The distinct values of one field, in the order they first appear in the rows. */
export function uniqueValues(rows, field) {
  const seen = [];
  for (const row of rows || []) {
    if (!seen.includes(row[field])) {
      seen.push(row[field]);
    }
  }
  return seen;
}

/**
 * The field to colour by, or null when it has more values than MAX_SERIES. A field with too many values is not
 * coloured, so the page never needs a hue beyond the validated set.
 */
export function colourFieldFor(rows, field) {
  return distinctCount(rows, field) <= MAX_SERIES ? field : null;
}

/** A hex colour (#rrggbb) as its three channel numbers. */
function channels(hex) {
  const digits = hex.replace("#", "");
  return [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16));
}

/** Blends two hex colours: t = 0 gives the first, t = 1 gives the second. Used for the sequential ramp. */
export function mixHex(from, to, t) {
  const start = channels(from);
  const end = channels(to);
  const mixed = start.map((value, index) => Math.round(value + (end[index] - value) * t));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** The sequential colour steps from the surface (for the lowest rate) to the accent (for the highest). */
export function rampColours(surface, accent, steps = RAMP_STEPS) {
  const colours = [];
  for (let index = 0; index < steps; index += 1) {
    colours.push(mixHex(surface, accent, steps === 1 ? 1 : index / (steps - 1)));
  }
  return colours;
}

/** The Vega-Lite config that sets the page's colours for axes, legends and facet headers. No background, so the page shows through. */
function themeConfig(theme) {
  return {
    background: null,
    view: { stroke: null },
    axis: {
      labelColor: theme.inkSoft,
      titleColor: theme.ink,
      gridColor: theme.rule,
      domainColor: theme.rule,
      tickColor: theme.rule,
    },
    legend: { labelColor: theme.inkSoft, titleColor: theme.ink },
    header: { labelColor: theme.ink, titleColor: theme.ink },
  };
}

/**
 * A legend label expression for the condition field, so the legend says "Mitigation prompt" and not "mitigation".
 * Other fields have no expression, and their values are shown as they are.
 */
function labelExpressionFor(field) {
  if (field !== "condition") {
    return null;
  }
  return `datum.label == 'none' ? '${CONDITION_NAMES.none}' : datum.label == 'mitigation' `
    + `? '${CONDITION_NAMES.mitigation}' : '${CONDITION_NAMES.control}'`;
}

/** The colour encoding for a field, with one theme colour per value in the order the values appear. */
function colourEncoding(field, rows, theme) {
  const values = uniqueValues(rows, field);
  const legend = { title: FIELD_TITLES[field] || field };
  const labelExpr = labelExpressionFor(field);
  if (labelExpr) {
    legend.labelExpr = labelExpr;
  }
  return {
    field,
    type: "nominal",
    scale: { domain: values, range: theme.categorical.slice(0, values.length) },
    legend,
  };
}

/** The model axis, ordered by the models' first appearance, so the order follows the page's filtered list. */
function modelAxis(rows) {
  return {
    field: "model",
    type: "nominal",
    sort: uniqueValues(rows, "model"),
    axis: { title: FIELD_TITLES.model, labelAngle: -45 },
  };
}

/** The rate axis: a fixed 0 to 1 scale, so panels and dots are comparable and a missing value is never 0. */
function rateAxis() {
  return {
    field: "rate",
    type: "quantitative",
    scale: { domain: [0, 1] },
    axis: { format: RATE_FORMAT, title: RATE_TITLE },
  };
}

/** The interval's lower bound on the same 0 to 1 scale. The error bar runs from low to high. */
function lowAxis() {
  return { field: "low", type: "quantitative", scale: { domain: [0, 1] } };
}

/** The tooltip fields for a row of the condition views. */
function conditionTooltip() {
  return [
    { field: "model", title: "Model" },
    { field: "condition", title: "Condition" },
    { field: "rate", title: RATE_TITLE, format: RATE_FORMAT },
    { field: "low", title: "95% CI low", format: RATE_FORMAT },
    { field: "high", title: "95% CI high", format: RATE_FORMAT },
    { field: "n", title: "Units" },
  ];
}

/** The error-bar layer and the dot layer, shared by the small multiples and the dot plot. */
function errorBarAndDotLayers(markColour) {
  const hasInterval = { filter: "isValid(datum.low) && isValid(datum.high)" };
  return [
    {
      transform: [hasInterval],
      mark: { type: "rule", strokeWidth: BAR_WIDTH, color: markColour },
      encoding: { y: lowAxis(), y2: { field: "high" } },
    },
    { mark: { type: "point", filled: true, size: POINT_SIZE, color: markColour } },
  ];
}

/**
 * Small multiples: the flip rate by model, with a 95% interval, in one panel per facet value (a condition or a
 * provider). The scales are shared by default, so the panels compare directly. A missing rate is filtered out.
 * With no facet the view is one panel. The colour is the field given, when it has three or fewer values.
 */
export function smallMultiplesSpec(rows, options) {
  const { facet, colour, theme } = options;
  const markColour = theme.categorical[0];
  const encoding = {
    x: modelAxis(rows),
    y: rateAxis(),
    tooltip: conditionTooltip(),
  };
  if (colour) {
    encoding.color = colourEncoding(colour, rows, theme);
  }
  const panel = { encoding, layer: errorBarAndDotLayers(colour ? undefined : markColour) };
  const base = {
    data: { values: rows },
    transform: [{ filter: "isValid(datum.rate)" }],
    config: themeConfig(theme),
    width: Math.max(PANEL_WIDTH, uniqueValues(rows, "model").length * PANEL_STEP),
    height: PANEL_HEIGHT,
  };
  if (!facet) {
    return { ...base, ...panel };
  }
  return {
    ...base,
    facet: { column: { field: facet, type: "nominal", title: FIELD_TITLES[facet] || facet } },
    spec: panel,
    resolve: { scale: { x: "shared", y: "shared" } },
  };
}

/**
 * Dot plot: one dot per model and condition, with its 95% interval as an error bar. The conditions sit side by
 * side under each model, coloured by condition. A missing rate draws no dot, and a missing interval draws no bar.
 */
export function dotPlotSpec(rows, options) {
  const { theme } = options;
  const order = uniqueValues(rows, "model");
  const width = Math.max(MIN_WIDTH, order.length * DOT_STEP);
  const encoding = {
    x: modelAxis(rows),
    xOffset: { field: "condition", type: "nominal" },
    y: rateAxis(),
    color: colourEncoding("condition", rows, theme),
    tooltip: conditionTooltip(),
  };
  return {
    data: { values: rows },
    transform: [{ filter: "isValid(datum.rate)" }],
    config: themeConfig(theme),
    width,
    height: DOT_HEIGHT,
    encoding,
    layer: errorBarAndDotLayers(undefined),
  };
}

/**
 * Heatmap: one cell per model and question, coloured by the flip rate at the last level, from the surface colour
 * (near zero) to the accent (high). A missing rate leaves the cell empty, so it is never drawn as zero.
 */
export function heatmapSpec(rows, options) {
  const { theme } = options;
  const questions = uniqueValues(rows, "questionId");
  const models = uniqueValues(rows, "model");
  return {
    data: { values: rows },
    transform: [{ filter: "isValid(datum.rate)" }],
    config: themeConfig(theme),
    width: Math.max(MIN_WIDTH, questions.length * HEAT_CELL_WIDTH),
    height: Math.max(MIN_HEIGHT, models.length * HEAT_CELL_HEIGHT),
    mark: { type: "rect" },
    encoding: {
      x: { field: "questionId", type: "nominal", sort: questions, axis: { title: "Question" } },
      y: { field: "model", type: "nominal", sort: models, axis: { title: FIELD_TITLES.model } },
      color: {
        field: "rate",
        type: "quantitative",
        scale: { domain: [0, 1], range: rampColours(theme.surface, theme.accent) },
        legend: { title: RATE_TITLE, format: RATE_FORMAT },
      },
      tooltip: [
        { field: "model", title: "Model" },
        { field: "questionId", title: "Question" },
        { field: "rate", title: RATE_TITLE, format: RATE_FORMAT },
        { field: "n", title: "Initially-right units" },
      ],
    },
  };
}
