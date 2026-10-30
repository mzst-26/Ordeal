// Interactive figure for the Batch results: a scatter of the ticked models on two chosen measures.
// The pure helpers at the top take numbers and rows and return plain values; the DOM builders below them
// draw SVG with createElementNS and never use innerHTML. Input rows are the analytics rows from page-batch.js:
// { model, index, measures: { <MEASURES key>: number|null } }, and measures are the result measure definitions
// { key, label, digits, higherIsBetter }.

import { el, formatNumber } from "../ui/ui.js";
import { TERMS } from "./glossary.js";

// The radar and the profile were removed: a radar's spokes were scaled across the ticked models, so one model's shape
// moved when another was ticked, and the profile repeated the heatmap's numbers. Scatter is the only figure left, so it
// is the default view. The ranked bars and the heatmap above it carry the comparison on the fixed scale.
export const FIGURE_VIEWS = [{ key: "scatter", label: "Scatter" }];
export const DEFAULT_FIGURE_VIEW = "scatter";

// Chart data colours: the Okabe-Ito colour-blind-safe set, with its black swapped for grey so the
// line stays visible on the dark theme. These are data colours, so they are hex; chrome uses tokens.
export const PALETTE = ["#0072B2", "#E69F00", "#009E73", "#CC79A7", "#56B4E9", "#D55E00", "#F0E442", "#999999"];

const SVG_NS = "http://www.w3.org/2000/svg";

/** Return the chart colour for the model at this position in the ticked list. The palette cycles. */
export function colourFor(index) {
  return PALETTE[index % PALETTE.length];
}

/** True when a value is a finite number. */
function isUsable(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Map a raw value onto 0..size using the min and max of its axis. Returns null when the value or the range is
 * missing. When min equals max every value sits in the middle. Values outside the range are clamped.
 */
export function scatterPosition(value, min, max, size) {
  if (!isUsable(value) || !isUsable(min) || !isUsable(max)) return null;
  if (min === max) return size / 2;
  const scaled = ((value - min) / (max - min)) * size;
  return Math.min(size, Math.max(0, scaled));
}

/** Split rows into those with both the x and the y value (plotted) and the model names of the rest (skipped). */
export function splitScatterRows(rows, xKey, yKey) {
  const plotted = [];
  const skipped = [];
  for (const row of rows) {
    if (isUsable(row.measures[xKey]) && isUsable(row.measures[yKey])) {
      plotted.push(row);
    } else {
      skipped.push(row.model);
    }
  }
  return { plotted, skipped };
}

// ---- DOM builders -------------------------------------------------------------------------------------

// The figure state survives redraws, so a regrade keeps the chosen view, the scatter axes and the legend toggles.
const state = {
  view: DEFAULT_FIGURE_VIEW,
  xKey: "flip_rate_level_10",
  yKey: "baseline_accuracy",
};
let lastContainer = null;
let lastInput = { rows: [], measures: [] };

/** Make an SVG element with attributes. Text children are added with textContent by the caller. */
function svgEl(tag, attributes = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined) node.setAttribute(name, String(value));
  }
  for (const child of children) {
    if (child) node.append(child);
  }
  return node;
}

/** Set the hover note of a node. The shared tooltip (tooltip.js) shows it at once on hover or keyboard focus. */
function setTip(node, text) {
  node.setAttribute("data-tip", text);
  return node;
}

/** A word in running text that shows its plain-English meaning when the reader hovers it. */
function termSpan(text, meaning) {
  return el("span", { className: "term", "data-tip": meaning, tabindex: "0", text });
}

/** Make a text element with its label set by textContent. */
function textEl(text, attributes) {
  const node = svgEl("text", attributes);
  node.textContent = text;
  return node;
}

/** Link hover on a node to every node with the same model index inside the figure block. */
function linkHover(node, index, block) {
  const set = (on) => {
    for (const other of block.querySelectorAll(`[data-model-index="${index}"]`)) {
      other.classList.toggle("is-highlight", on);
    }
  };
  node.addEventListener("mouseenter", () => set(true));
  node.addEventListener("mouseleave", () => set(false));
}

/**
 * Draw the figures into the container: a view switcher and the chosen view. Rows are the analytics rows for
 * the ticked models, in the order of the ticked list. Clears the container when there are no models.
 */
export function renderResultsFigures(container, rows, measures) {
  lastContainer = container;
  lastInput = { rows, measures };
  if (container === null) return;
  if (rows.length === 0) {
    container.replaceChildren();
    return;
  }
  const select = el("select", { id: "results-figure-view", className: "results-select" }, FIGURE_VIEWS.map((view) =>
    el("option", { value: view.key, text: view.label }),
  ));
  select.value = state.view;
  setTip(select, TERMS[state.view]);
  select.addEventListener("change", () => {
    state.view = select.value;
    redrawFigures();
  });
  const body = el("div", { className: "figure-body" });
  const block = el("div", { className: "figure-block" }, [
    el("div", { className: "results-controls" }, [
      el("label", { for: "results-figure-view", className: "results-label", text: "View", "data-tip": TERMS.view }),
      select,
    ]),
    body,
  ]);
  body.append(...buildView(rows, measures, block));
  container.replaceChildren(block);
}

/** Redraw the current figure from the last input, for the switcher and the legend. No grading happens here. */
function redrawFigures() {
  if (lastContainer !== null) {
    renderResultsFigures(lastContainer, lastInput.rows, lastInput.measures);
  }
}

/** Return the nodes for the chosen view. */
function buildView(rows, measures, block) {
  return buildScatter(rows, measures, block);
}

/** Scatter: one labelled point per model, placed by the raw values of two chosen measures. */
function buildScatter(rows, measures, block) {
  const options = (selected) => measures.map((measure) => el("option", { value: measure.key, text: measure.label, selected: measure.key === selected }));
  const xSelect = el("select", { id: "results-figure-x", className: "results-select" }, options(state.xKey));
  const ySelect = el("select", { id: "results-figure-y", className: "results-select" }, options(state.yKey));
  xSelect.addEventListener("change", () => { state.xKey = xSelect.value; redrawFigures(); });
  ySelect.addEventListener("change", () => { state.yKey = ySelect.value; redrawFigures(); });
  const axes = el("div", { className: "results-controls figure-axes" }, [
    el("label", { for: "results-figure-x", className: "results-label", text: "X axis", "data-tip": TERMS.xAxis }), xSelect,
    el("label", { for: "results-figure-y", className: "results-label", text: "Y axis", "data-tip": TERMS.yAxis }), ySelect,
  ]);
  const xMeasure = measures.find((measure) => measure.key === state.xKey) ?? measures[0];
  const yMeasure = measures.find((measure) => measure.key === state.yKey) ?? measures[0];
  setTip(xSelect, `${TERMS.xAxis} ${xMeasure.definition}`);
  setTip(ySelect, `${TERMS.yAxis} ${yMeasure.definition}`);
  const split = splitScatterRows(rows, xMeasure.key, yMeasure.key);
  // Both axes run from 0 to the most each measure can be, so a dot's place is its real score, not its place among the models.
  const xTop = xMeasure.max;
  const yTop = yMeasure.max;

  const width = 560;
  const height = 400;
  const left = 64;
  const top = 16;
  const plotW = width - left - 24;
  const plotH = height - top - 52;
  const svg = svgEl("svg", {
    class: "figure-svg",
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `Scatter of ${yMeasure.label} against ${xMeasure.label}`,
  });
  svg.append(svgEl("rect", { class: "figure-plot-bg", x: left, y: top, width: plotW, height: plotH }));
  svg.append(svgEl("line", { class: "figure-axis", x1: left, y1: top + plotH, x2: left + plotW, y2: top + plotH }));
  svg.append(svgEl("line", { class: "figure-axis", x1: left, y1: top, x2: left, y2: top + plotH }));
  svg.append(textEl(formatNumber(0, xMeasure.digits), { class: "figure-tick", x: left, y: top + plotH + 16 }));
  svg.append(textEl(formatNumber(xTop, xMeasure.digits), { class: "figure-tick", x: left + plotW, y: top + plotH + 16, "text-anchor": "end" }));
  svg.append(textEl(formatNumber(yTop, yMeasure.digits), { class: "figure-tick", x: left - 6, y: top + 10, "text-anchor": "end" }));
  svg.append(textEl(formatNumber(0, yMeasure.digits), { class: "figure-tick", x: left - 6, y: top + plotH, "text-anchor": "end" }));
  const xLabel = textEl(xMeasure.label, { class: "figure-axis-label", x: left + plotW / 2, y: height - 8, "text-anchor": "middle" });
  setTip(xLabel, xMeasure.definition);
  const yLabel = textEl(yMeasure.label, { class: "figure-axis-label", "text-anchor": "middle", transform: `translate(14 ${top + plotH / 2}) rotate(-90)` });
  setTip(yLabel, yMeasure.definition);
  svg.append(xLabel, yLabel);
  for (const tick of svg.querySelectorAll(".figure-tick")) {
    setTip(tick, TERMS.axisEnd);
  }

  for (const row of split.plotted) {
    const xValue = row.measures[xMeasure.key];
    const yValue = row.measures[yMeasure.key];
    const px = left + scatterPosition(xValue, 0, xTop, plotW);
    const py = top + plotH - scatterPosition(yValue, 0, yTop, plotH);
    const colour = colourFor(row.index);
    const point = svgEl("circle", { class: "figure-point", cx: px, cy: py, r: 6, fill: colour, stroke: colour, "data-model-index": row.index });
    setTip(point, `${row.model}: ${xMeasure.label} ${formatNumber(xValue, xMeasure.digits)}, ${yMeasure.label} ${formatNumber(yValue, yMeasure.digits)}`);
    linkHover(point, row.index, block);
    const name = textEl(row.model, { class: "figure-point-label", x: px + 9, y: py - 8, "data-model-index": row.index });
    linkHover(name, row.index, block);
    svg.append(point, name);
  }
  const notes = [el("p", { className: "field-hint", text: "Each dot is one ticked model. It sits at its actual score on each of the two measures you pick." })];
  if (split.skipped.length > 0) {
    notes.push(el("p", { className: "field-hint" }, [
      `${split.skipped.length} model(s) `,
      termSpan("left off the chart", TERMS.notPlotted),
      ` because they have no value for ${xMeasure.label} or ${yMeasure.label}: ${split.skipped.join(", ")}.`,
    ]));
  }
  return [axes, ...notes, el("div", { className: "figure-scroll" }, [svg])];
}
