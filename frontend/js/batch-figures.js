// Interactive figures for the Batch results: a radar, a scatter and a profile of the same ticked models.
// The pure helpers at the top take numbers and rows and return plain values; the DOM builders below them
// draw SVG with createElementNS and never use innerHTML. Input rows are the analytics rows from page-batch.js:
// { model, index, measures: { <MEASURES key>: number|null } }, and measures are the result measure definitions
// { key, label, digits, higherIsBetter }.

import { heatmapMatrix, shareOfMax } from "./analytics.js";
import { el, formatNumber } from "./ui.js";
import { TERMS } from "./glossary.js";

export const FIGURE_VIEWS = [
  { key: "radar", label: "Radar" },
  { key: "scatter", label: "Scatter" },
  { key: "profile", label: "Profile" },
];

// Chart data colours: the Okabe-Ito colour-blind-safe set, with its black swapped for grey so the
// line stays visible on the dark theme. These are data colours, so they are hex; chrome uses tokens.
export const PALETTE = ["#0072B2", "#E69F00", "#009E73", "#CC79A7", "#56B4E9", "#D55E00", "#F0E442", "#999999"];

// Dash patterns that change every eight models, so a model stays distinguishable once the palette repeats.
const DASH_PATTERNS = ["", "6 3", "2 2", "8 3 2 3"];

const SVG_NS = "http://www.w3.org/2000/svg";

/** Return the chart colour for the model at this position in the ticked list. The palette cycles. */
export function colourFor(index) {
  return PALETTE[index % PALETTE.length];
}

/** Return the stroke dash for this model. The first eight are solid; later groups of eight get a pattern. */
export function dashFor(index) {
  return DASH_PATTERNS[Math.floor(index / PALETTE.length) % DASH_PATTERNS.length];
}

/** Return the angle, in radians, of axis i out of count. Axis 0 points straight up. */
function axisAngle(i, count) {
  return -Math.PI / 2 + (2 * Math.PI * i) / count;
}

/** True when a value is a finite number. */
function isUsable(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Return "x,y" strings for the radar vertices that have a value, in axis order. Each normalised value (0..1,
 * with 1 at the rim) sets the distance from the centre along its axis. Null values have no vertex.
 */
export function radarPoints(normalisedValues, axisCount, radius, centre) {
  const points = [];
  for (let i = 0; i < axisCount; i += 1) {
    const value = normalisedValues[i];
    if (!isUsable(value)) continue;
    const distance = radius * Math.min(1, Math.max(0, value));
    const angle = axisAngle(i, axisCount);
    const x = centre[0] + distance * Math.cos(angle);
    const y = centre[1] + distance * Math.sin(angle);
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return points;
}

/** Return the end point of axis i at the given radius, as a point string, for the axis lines and labels. */
export function axisEnd(i, axisCount, radius, centre) {
  const angle = axisAngle(i, axisCount);
  return {
    x: centre[0] + radius * Math.cos(angle),
    y: centre[1] + radius * Math.sin(angle),
  };
}

/** Join point strings into the points attribute of an SVG polygon. */
export function polygonPoints(points) {
  return points.join(" ");
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

/** Break a label into lines of at most maxChars at word boundaries. A word longer than the limit keeps its own line. */
export function wrapLabel(text, maxChars) {
  const lines = [];
  let current = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = current === "" ? word : `${current} ${word}`;
    if (next.length <= maxChars || current === "") {
      current = next;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** Describe one model's values for a hover title, as "Label value; Label value", with "no data" for nulls. */
export function describeValues(values, measures) {
  return measures
    .map((measure) => {
      const value = values[measure.key];
      return `${measure.label} ${isUsable(value) ? formatNumber(value, measure.digits) : "no data"}`;
    })
    .join("; ");
}

// ---- DOM builders -------------------------------------------------------------------------------------

// The figure state survives redraws, so a regrade keeps the chosen view, the scatter axes and the legend toggles.
const state = {
  view: "radar",
  xKey: "flip_rate_level_10",
  yKey: "baseline_accuracy",
  hidden: new Set(),
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
  if (state.view === "scatter") return buildScatter(rows, measures, block);
  if (state.view === "profile") return buildProfile(rows, measures, block);
  return buildRadar(rows, measures, block);
}

/** Radar: one polygon per visible model over the measures it has a value for. Legend entries toggle a model. */
function buildRadar(rows, measures, block) {
  const keys = measures.map((measure) => measure.key);
  const cells = heatmapMatrix(rows, keys).cells;
  const count = keys.length;
  const size = 560;
  // Side allowance so the longest axis label (up to 20 characters, anchored at the rim) is not clipped.
  const labelAllowance = 130;
  const width = size + labelAllowance * 2;
  const centre = [width / 2, size / 2];
  const radius = 170;
  // The radar keeps its full width so its labels stay at the page's text size; the figure box scrolls sideways instead.
  const svg = svgEl("svg", {
    class: "figure-svg figure-svg-wide",
    viewBox: `0 0 ${width} ${size}`,
    role: "img",
    "aria-label": "Radar of the ticked models over the batch measures",
  });
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    svg.append(svgEl("circle", { class: "figure-grid", cx: centre[0], cy: centre[1], r: radius * fraction }));
  }
  measures.forEach((measure, i) => {
    const end = axisEnd(i, count, radius, centre);
    svg.append(svgEl("line", { class: "figure-grid", x1: centre[0], y1: centre[1], x2: end.x, y2: end.y }));
    const labelPoint = axisEnd(i, count, radius + 26, centre);
    const anchor = Math.abs(labelPoint.x - centre[0]) < 20 ? "middle" : labelPoint.x > centre[0] ? "start" : "end";
    const lines = wrapLabel(measure.label, 20);
    const label = svgEl("text", { class: "figure-axis-label", "text-anchor": anchor, x: labelPoint.x, y: labelPoint.y });
    setTip(label, measure.definition ?? measure.label);
    lines.forEach((line, lineIndex) => {
      const tspan = svgEl("tspan", { x: labelPoint.x, dy: lineIndex === 0 ? 0 : 13 });
      tspan.textContent = line;
      label.append(tspan);
    });
    svg.append(label);
  });
  const legend = el("ol", { className: "figure-legend", "aria-label": "Models in the radar" });
  for (const row of rows) {
    const colour = colourFor(row.index);
    const hidden = state.hidden.has(row.model);
    const points = radarPoints(cells[row.index], count, radius, centre);
    if (!hidden && points.length > 0) {
      const polygon = svgEl("polygon", {
        class: "figure-poly",
        points: polygonPoints(points),
        fill: colour,
        "fill-opacity": 0.12,
        stroke: colour,
        "stroke-width": 2,
        "stroke-dasharray": dashFor(row.index) || null,
        "data-model-index": row.index,
      });
      setTip(polygon, `${row.model}: ${describeValues(row.measures, measures)}`);
      linkHover(polygon, row.index, block);
      svg.append(polygon);
    }
    const note = points.length === 0 ? " (no values)" : "";
    const button = el("button", {
      type: "button",
      className: "figure-legend-item",
      "data-tip": TERMS.legend,
      "aria-pressed": hidden ? "false" : "true",
      "data-model-index": row.index,
    }, [
      el("span", { className: "figure-swatch", "aria-hidden": "true" }),
      el("span", { className: "figure-legend-name", text: `${row.model}${note}` }),
    ]);
    button.querySelector(".figure-swatch").style.background = colour;
    button.addEventListener("click", () => {
      if (state.hidden.has(row.model)) state.hidden.delete(row.model);
      else state.hidden.add(row.model);
      redrawFigures();
    });
    linkHover(button, row.index, block);
    legend.append(el("li", {}, [button]));
  }
  return [
    el("p", { className: "field-hint" }, [
      termSpan("Each spoke is scaled", TERMS.scaled),
      " across the ticked models. The outer edge is the best model on each measure and the centre is the worst. Click a model to hide or show it.",
    ]),
    el("div", { className: "figure-scroll" }, [svg]),
    legend,
  ];
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

/** Profile: one row per ticked model, eight bars in measure order, each a share of the most that measure can be. */
function buildProfile(rows, measures, block) {
  const cell = 40;
  const barHeight = 80;
  const width = cell * measures.length;
  const profileRows = rows.map((row) => {
    const colour = colourFor(row.index);
    const svg = svgEl("svg", {
      class: "figure-profile-svg",
      viewBox: `0 0 ${width} ${barHeight + 16}`,
      role: "img",
      "aria-label": `Profile of ${row.model}`,
    });
    measures.forEach((measure, i) => {
      const value = row.measures[measure.key];
      const scaled = shareOfMax(value, measure.max);
      const x = i * cell + 6;
      if (!isUsable(scaled)) {
        svg.append(svgEl("rect", { class: "figure-missing", x, y: barHeight - 2, width: cell - 12, height: 2, "data-tip": `${measure.label}: no data` }));
        return;
      }
      const h = Math.max(2, Math.round(scaled * barHeight));
      const bar = svgEl("rect", {
        x, y: barHeight - h, width: cell - 12, height: h, fill: colour,
        "data-tip": `${measure.label}: ${formatNumber(value, measure.digits)}`,
      });
      svg.append(bar);
      svg.append(textEl(String(i + 1), { class: "figure-tick", x: x + (cell - 12) / 2, y: barHeight + 13, "text-anchor": "middle" }));
    });
    const line = el("div", { className: "figure-profile-row", "data-model-index": row.index }, [
      el("span", { className: "figure-profile-name", text: row.model, "data-tip": row.model }),
      el("div", { className: "figure-profile-track" }, [svg]),
    ]);
    linkHover(line, row.index, block);
    return line;
  });
  const key = el("ol", { className: "figure-key", "aria-label": "Bar order", "data-tip": TERMS.barOrder },
    measures.map((measure) => el("li", { text: measure.label, "data-tip": measure.definition })));
  return [
    el("p", { className: "field-hint" }, [
      "Each row is one model. The eight bars run ",
      termSpan("in the order below", TERMS.barOrder),
      ", and each is ",
      termSpan("a share of its top", TERMS.shareOfMax),
      ". Taller is more of the measure, which is better except where lower is better.",
    ]),
    key,
    el("div", { className: "figure-scroll" }, profileRows),
  ];
}
