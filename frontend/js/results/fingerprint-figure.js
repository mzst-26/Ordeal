// The Batch fingerprint figure: a view switch (Summary, Chart, Table) over one set of numbers. The numbers and
// the wording come from fingerprint-summary.js, and the order and the picks come from fingerprint-overview.js.
// This file only builds the elements for each view, and it builds them with createElement and textContent, so no
// markup is ever read from the data.
//
// Why three views: the Summary gives one line per model, the chart shows one probe at a time so a reader can
// compare models on it, and the table holds the same numbers for anyone who needs to check one. Each view is built
// from the same cells, so they cannot disagree. The chart and the table share one probe picker, because a picker
// for each would make the two views easy to read out of step.

import { el } from "../ui/ui.js";
import { buildTable } from "./chart-panel.js";
import { buildFingerprintView, NOT_RUN_TEXT, percentText } from "./fingerprint-summary.js";
import { rankModels, rowsForProbe, chooseProbe } from "./fingerprint-overview.js";

// The three views, in the order the buttons show them. Summary is first and is the default, because one line per
// model needs no reading skill and is the most useful view for a reader who is new to charts.
export const FIGURE_VIEWS = [
  { key: "summary", label: "Summary", panel: "fingerprint-summary" },
  { key: "chart", label: "Chart", panel: "fingerprint-chart" },
  { key: "table", label: "Table", panel: "fingerprint-table" },
];
const DEFAULT_VIEW = "summary";

// The table has four columns, whatever the number of models: the model, its rate and the range. Probes are not
// columns or rows here, because the picker chooses one probe, so the table stays short and easy to read.
const TABLE_HEADERS = ["Model", "Flip rate", "Low", "High"];

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
 * The 0% to 100% scale across the top of the bars. It has the same three columns as each bar row (the label, the
 * bar and the value), so the 0% and 100% labels line up with the bars. There is no 50% label: at a phone width the
 * middle label ran into the 100% label, and the bars already show the middle of the scale with a gridline. The scale
 * is hidden from screen readers, because each bar's text already says its own rate.
 */
function buildScale() {
  return el("div", { className: "fp-scale", "aria-hidden": "true" }, [
    el("span", { className: "fp-scale-spacer" }),
    el("div", { className: "fp-scale-track" }, [
      el("span", { className: "fp-tick is-start", text: "0%" }),
      el("span", { className: "fp-tick is-end", text: "100%" }),
    ]),
    el("span", { className: "fp-scale-spacer" }),
  ]);
}

/**
 * One bar for one model and the chosen probe. The row has three parts: the model's number and name, the bar, and
 * the rate as a number. The bar is the flip rate, and a thin range line on it shows the 95% range, so a wide range
 * reads as a less certain rate. A model with no replies for this probe shows "Not run yet" as text in the bar's
 * place, instead of a bar. The name and the rate are hidden from screen readers, because the sentence in the track
 * already says both.
 */
function buildBarRow(model, cell) {
  const label = el("span", { className: "fp-row-label", text: `${model.numberText} ${model.name}`, "aria-hidden": "true" });
  const track = el("div", { className: "fp-track", title: `${model.name}: ${cell.sentence}` });
  if (cell.notRun) {
    track.append(el("span", { className: "fp-not-run", text: NOT_RUN_TEXT }));
  } else {
    track.append(barFill(cell));
    const range = rangeLine(cell);
    if (range !== null) {
      track.append(range);
    }
  }
  // The sentence is also read by screen readers, so the chart gives the same words as the summary.
  track.append(el("span", { className: "visually-hidden", text: `${model.name}: ${cell.sentence}` }));
  const value = el("span", { className: "fp-value", text: cell.notRun ? "" : cell.text, "aria-hidden": "true" });
  return el("div", { className: "fp-bar-row" }, [label, track, value]);
}

/** The filled part of a bar, from zero to the flip rate, as a share of the track. */
function barFill(cell) {
  const fill = el("span", { className: "fp-fill" });
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

/**
 * The chart view for one probe: the scale, then one bar per model, highest rate first. There is one series, so
 * every bar has the same colour and no colour legend is needed. The probe's plain phrase is shown by the picker
 * above the chart, which is what names the chart.
 */
function buildChart(view, probeId) {
  const rows = rowsForProbe(view.models, probeId).map((item) => buildBarRow(item.model, item.cell));
  return [buildScale(), ...rows];
}

/** Fill the probe picker with one option per probe, named by its plain phrase, and select the chosen probe. */
function fillPicker(picker, probes, chosen) {
  picker.replaceChildren(...probes.map((item) => el("option", { value: item.probe, text: item.phrase })));
  picker.value = chosen ?? "";
}

/**
 * The table view for one probe: one row per model, in the same order as the chart bars, with its rate and range.
 * The caption names the probe, so the table still says what it counts when it is read on its own. The numbers are
 * right-aligned by buildTable, from the column given by firstNumber (1 is the "Flip rate" column).
 */
function buildTableView(view, probeId) {
  const probe = view.probes.find((item) => item.probe === probeId);
  const rows = rowsForProbe(view.models, probeId).map((item) => [
    `${item.model.numberText} ${item.model.name}`,
    item.cell.text,
    item.cell.low,
    item.cell.high,
  ]);
  return buildTable({
    caption: `Flip rates for ${probe.phrase}, by model`,
    headers: TABLE_HEADERS,
    rows,
    firstNumber: 1,
  });
}

/**
 * Wire the figure inside root and show the default view. Returns { render, clear }. render takes the models in
 * the order to show them, and the fingerprint rows for those models. The view the visitor picked, and the probe
 * they picked, are kept when the figure is drawn again, so a new run does not switch them back.
 */
export function mountFingerprintFigure(root) {
  const panels = Object.fromEntries(FIGURE_VIEWS.map((view) => [view.key, root.querySelector(`#${view.panel}`)]));
  const buttons = [...root.querySelectorAll("[data-fp-view]")];
  const picker = root.querySelector("#fingerprint-probe");
  const pickerField = root.querySelector("#fingerprint-probe-field");
  let lastView = null;
  let chosenProbe = null;

  /** Show one view and mark its button as pressed. The other views are hidden, and the buttons say which is on. */
  function showView(key) {
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(button.dataset.fpView === key));
    }
    for (const [name, panel] of Object.entries(panels)) {
      panel.hidden = name !== key;
    }
    // The probe picker only changes the Chart and the Table, so it is hidden while the Summary is showing.
    pickerField.hidden = key === "summary";
  }

  /** Draw the Chart and the Table for the chosen probe. Both come from the same cells, so they show the same order. */
  function paintProbeViews() {
    panels.chart.replaceChildren(...buildChart(lastView, chosenProbe));
    panels.table.replaceChildren(buildTableView(lastView, chosenProbe));
  }

  /** Build all three views from the last cells. Building all three keeps the views in step with each other. */
  function paint() {
    if (lastView === null) {
      return;
    }
    chosenProbe = chooseProbe(lastView.probes, chosenProbe);
    fillPicker(picker, lastView.probes, chosenProbe);
    panels.summary.replaceChildren(...buildSummary(lastView));
    paintProbeViews();
  }

  for (const button of buttons) {
    button.addEventListener("click", () => showView(button.dataset.fpView));
  }
  picker.addEventListener("change", () => {
    chosenProbe = picker.value;
    paintProbeViews();
  });
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
      picker.replaceChildren();
    },
  };
}
