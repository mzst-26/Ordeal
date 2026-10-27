// The Batch fingerprint figure: a view switch (Summary, Chart, Table) over one set of numbers. The numbers and
// the wording come from fingerprint-summary.js. This file only builds the elements for each view, and it builds
// them with createElement and textContent, so no markup is ever read from the data.
//
// Why three views: the chart is quick for someone who reads charts, the sentences are easier for someone who
// does not, and the table holds every number for anyone who needs to check one. Each view is built from the same
// cells, so they cannot disagree.

import { el } from "./ui.js";
import { buildTable, seriesSlot, isRepeatSeries } from "./chart-panel.js";
import { buildFingerprintView, NOT_RUN_TEXT, percentText } from "./fingerprint-summary.js";
import { rankModels } from "./fingerprint-overview.js";

// The three views, in the order the buttons show them. Summary is first and is the default, because a sentence
// needs no reading skill and is the most useful view for a reader who is new to charts.
export const FIGURE_VIEWS = [
  { key: "summary", label: "Summary", panel: "fingerprint-summary" },
  { key: "chart", label: "Chart", panel: "fingerprint-chart" },
  { key: "table", label: "Table", panel: "fingerprint-table" },
];
const DEFAULT_VIEW = "summary";

// Text for the table's header row. The "Questions" column is how many questions the rate is based on, so a
// reader can tell a rate from 5 questions from one from 56.
const TABLE_HEADERS = ["Probe", "Model", "Questions", "Flip rate", "Low", "High"];
const TABLE_CAPTION = "Fingerprint flip rates by probe and model";

/**
 * Return the colour for a model, from its place in the full model list. The first three models use the theme's
 * three categorical colours. A model with no place in the list gets a muted grey, so it still shows.
 */
function colourFor(index) {
  const slot = seriesSlot(index);
  return slot === null ? "var(--ink-mute)" : `var(--cat-${slot + 1})`;
}

/**
 * Give a swatch or a bar its model's colour. A fourth model and later reuse a colour, so they are also striped:
 * the stripes keep them apart from the first three, and the legend shows the same stripes.
 */
function applySeries(node, model) {
  node.style.setProperty("--series", colourFor(model.index));
  if (isRepeatSeries(model.index)) {
    node.classList.add("is-repeat");
  }
  return node;
}

// The Summary says how the overall rate is worked out. The overall rate is across all the probes a model was run
// on, so a reader needs to know that its range is an average of the probe ranges, not a range of its own.
const SUMMARY_NOTE = "Overall is across the probes each model was run on, weighted by questions. Its range averages the probe ranges.";

/**
 * The Summary view: one row per model, highest overall flip rate first, so 32 models take one line each and not a
 * block each. The list is built by rankModels, which also puts the models that were not run last.
 */
function buildSummary(view) {
  const rows = rankModels(view.models).map((item) => buildSummaryRow(item.model, item.overall, item.most));
  return [el("p", { className: "field-hint", text: SUMMARY_NOTE }), el("ol", { className: "fp-summary-list" }, rows)];
}

/**
 * One Summary row: the model's catalogue number and name, its overall rate with the range, and the probe where it
 * flips most. A model that was not run shows "Not run yet" in place of the rate, and has no probe line.
 */
function buildSummaryRow(model, overall, most) {
  const name = el("p", { className: "fp-row-name" }, [
    el("span", { className: "fp-row-number", text: model.numberText }),
    el("span", { text: model.name }),
  ]);
  const rate = el("p", { className: "fp-row-rate", text: overallText(overall) });
  const mostLine = most === null ? null : el("p", { className: "fp-row-most", text: `Most flips: ${most.phrase} (${most.text}).` });
  return el("li", { className: "fp-summary-row" }, [name, rate, mostLine]);
}

/** The overall rate as text, such as "Overall 25% (range 10% to 40%)". A missing bound leaves out the range. */
function overallText(overall) {
  if (overall.notRun) {
    return NOT_RUN_TEXT;
  }
  const rate = `Overall ${percentText(overall.estimate)}`;
  if (overall.low === null || overall.high === null) {
    return rate;
  }
  return `${rate} (range ${percentText(overall.low)} to ${percentText(overall.high)})`;
}

/**
 * The one legend for the chart: each model's colour and name, once. The chart rows below use the same colour, so
 * a reader matches a bar to a model by its colour, and the table and the summary give the name in full.
 */
function buildLegend(view) {
  const items = view.models.map((model) => {
    return el("li", { className: "fp-legend-item" }, [
      applySeries(el("span", { className: "fp-swatch", "aria-hidden": "true" }), model),
      el("span", { text: model.name }),
    ]);
  });
  return el("ul", { className: "fp-legend", "aria-label": "Models in the chart" }, items);
}

/**
 * The 0% to 100% scale across the top of the bars. It is hidden from screen readers, because each bar's text
 * already says its own rate. The labels sit on the scale row, so they never overlap the bars or each other.
 */
function buildScale() {
  return el("div", { className: "fp-scale", "aria-hidden": "true" }, [
    el("span", { className: "fp-scale-spacer" }),
    el("div", { className: "fp-scale-track" }, [
      el("span", { className: "fp-tick is-start", text: "0%" }),
      el("span", { className: "fp-tick is-middle", text: "50%" }),
      el("span", { className: "fp-tick is-end", text: "100%" }),
    ]),
  ]);
}

/**
 * The bar for one model and one probe. A bar is the flip rate. A thin range line on it shows the 95% range, so a
 * wide range reads as a less certain rate. A pair with no replies shows "Not run yet" as text inside its row,
 * instead of an axis label, so it cannot overlap a neighbouring label.
 */
function buildBarRow(model, cell) {
  const track = el("div", { className: "fp-track", title: `${model.name}: ${cell.sentence}` });
  if (cell.notRun) {
    track.append(el("span", { className: "fp-not-run", text: NOT_RUN_TEXT }));
  } else {
    track.append(barFill(model, cell));
    const range = rangeLine(cell);
    if (range !== null) {
      track.append(range);
    }
  }
  // The sentence is also read by screen readers, so the chart gives the same words as the summary.
  track.append(el("span", { className: "visually-hidden", text: `${model.name}: ${cell.sentence}` }));
  return el("div", { className: "fp-bar-row" }, [
    applySeries(el("span", { className: "fp-swatch", "aria-hidden": "true" }), model),
    track,
  ]);
}

/** The filled part of a bar, from zero to the flip rate, as a share of the track. */
function barFill(model, cell) {
  const fill = applySeries(el("span", { className: "fp-fill" }), model);
  fill.style.width = `${cell.estimate * 100}%`;
  return fill;
}

/**
 * The 95% range as a line from the low bound to the high bound. Returns null when a bound is missing, so the bar
 * is drawn on its own rather than with a range that is not really there.
 */
function rangeLine(cell) {
  if (cell.lowValue === null || cell.highValue === null) {
    return null;
  }
  const range = el("span", { className: "fp-range" });
  range.style.left = `${cell.lowValue * 100}%`;
  range.style.width = `${(cell.highValue - cell.lowValue) * 100}%`;
  return range;
}

/** One probe in the chart: its plain phrase, then one bar per model in the same order as the legend. */
function buildProbeBlock(view, probeIndex) {
  const probe = view.probes[probeIndex];
  const rows = view.models.map((model) => buildBarRow(model, model.cells[probeIndex]));
  return el("div", { className: "fp-probe" }, [el("p", { className: "fp-probe-name", text: probe.phrase }), ...rows]);
}

/** The chart view: the legend, the scale, then one block per probe. */
function buildChart(view) {
  const probeBlocks = view.probes.map((_, probeIndex) => buildProbeBlock(view, probeIndex));
  return [buildLegend(view), buildScale(), ...probeBlocks];
}

/**
 * The table view: one row per probe and model, with every number. The probe phrase and model name are plain text,
 * and the numbers are right-aligned by buildTable (firstNumber marks where the numbers start).
 */
function buildTableView(view) {
  const rows = [];
  view.probes.forEach((probe, probeIndex) => {
    for (const model of view.models) {
      const cell = model.cells[probeIndex];
      rows.push([probe.phrase, model.name, String(cell.units), cell.text, cell.low, cell.high]);
    }
  });
  return buildTable({ caption: TABLE_CAPTION, headers: TABLE_HEADERS, rows, firstNumber: 2 });
}

/**
 * Wire the figure inside root and show the default view. Returns { render, clear }. render takes the models in
 * the order to show them, and the fingerprint rows for those models. The view the visitor picked is kept when
 * the figure is drawn again, so a new run does not switch the view back.
 */
export function mountFingerprintFigure(root) {
  const panels = Object.fromEntries(FIGURE_VIEWS.map((view) => [view.key, root.querySelector(`#${view.panel}`)]));
  const buttons = [...root.querySelectorAll("[data-fp-view]")];
  let lastView = null;

  /** Show one view and mark its button as pressed. The other views are hidden, and the buttons say which is on. */
  function showView(key) {
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(button.dataset.fpView === key));
    }
    for (const [name, panel] of Object.entries(panels)) {
      panel.hidden = name !== key;
    }
  }

  /** Build all three views from the last cells. Building all three keeps the views in step with each other. */
  function paint() {
    if (lastView === null) {
      return;
    }
    panels.summary.replaceChildren(...buildSummary(lastView));
    panels.chart.replaceChildren(...buildChart(lastView));
    panels.table.replaceChildren(buildTableView(lastView));
  }

  for (const button of buttons) {
    button.addEventListener("click", () => showView(button.dataset.fpView));
  }
  showView(DEFAULT_VIEW);

  return {
    /** Draw the figure for these models and their fingerprint rows. */
    render(models, rows) {
      lastView = buildFingerprintView(rows, models);
      paint();
    },
    /** Empty all three views. The message that says why there is no figure is shown by the page. */
    clear() {
      lastView = null;
      for (const panel of Object.values(panels)) {
        panel.replaceChildren();
      }
    },
  };
}
