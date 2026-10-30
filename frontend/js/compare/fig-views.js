// FIG 8 "Comparison views": small multiples, a dot plot and a heatmap, drawn with Vega-Lite. The spec builders are
// pure (vega-specs.js); this module reads the page's colour tokens, runs Vega, and handles the view switch.
// The Vega view uses vega-interpreter, not Vega's default expression compiler, because the site's Content-Security-
// Policy has no 'unsafe-eval'. The tooltip is the page's own (tooltip.js), so no style element is injected.
// mount(root, api) returns {update(view)}. Missing values are never drawn as zero: the spec builders drop them.
import * as vega from "vega";
import * as vegaLite from "vega-lite";
import { expressionInterpreter } from "vega-interpreter";
import { conditionRows, questionRows } from "./vega-rows.js";
import { smallMultiplesSpec, dotPlotSpec, heatmapSpec, MAX_SERIES } from "./vega-specs.js";
import { chooseDifferenceView } from "./differences.js";
import { showTooltip, hideTooltip } from "./tooltip.js";
import { pct, rateText } from "./derive.js";

// The three views, in the order of the switch. The small multiples are shown first.
const VIEWS = Object.freeze([
  { id: "small", label: "Small multiples" },
  { id: "dot", label: "Dot plot" },
  { id: "heat", label: "Heatmap" },
]);
const DEFAULT_VIEW = "small";
// The dimension the small multiples split on when differences only is off: one panel per condition.
const DEFAULT_FACET = "condition";
// Messages for a view with nothing to draw, and for a view that fails.
const NO_MODELS = "No models match these filters.";
const NO_QUESTIONS = "This results file has no per-question data, so the heatmap has nothing to draw. "
  + "Run scripts/build_compare.py to add it.";
const FAILED = "This view could not be drawn.";
const DIFFERENCES_NOTE = "Differences only applies to the small multiples.";
// Page colour tokens read for the charts, with the light-theme value used when a token is missing or not a hex colour.
const TOKENS = Object.freeze({
  surface: { name: "--paper", fallback: "#F5EFE3" },
  ink: { name: "--ink", fallback: "#26211C" },
  inkSoft: { name: "--ink-soft", fallback: "#5A5048" },
  rule: { name: "--rule", fallback: "#D9CDBB" },
  accent: { name: "--teal", fallback: "#2E5E5B" },
});
// The three categorical colours, in the order the page's families and conditions use them.
const CATEGORICAL_TOKENS = Object.freeze([
  { name: "--cat-1", fallback: "#892C1A" },
  { name: "--cat-2", fallback: "#A57C00" },
  { name: "--cat-3", fallback: "#9A6AAF" },
]);
// Human names for the dimensions, shown in the note under the controls.
const DIMENSION_NAMES = {
  model: "model", provider: "provider", condition: "condition", questionSet: "question set", pushback: "pushback set",
};
// A colour the charts can use: a six-digit hex value. Vega's colour maths only reads hex, so anything else is refused.
const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** A token's value from the page's CSS, as a hex colour. A missing or non-hex value gives the fallback. */
function readToken(style, token) {
  const value = style.getPropertyValue(token.name).trim();
  return HEX_PATTERN.test(value) ? value : token.fallback;
}

/** The chart colours, read from the page's tokens. Read again on each update, so a theme change is picked up. */
function readTheme() {
  const style = getComputedStyle(document.documentElement);
  const theme = {};
  for (const [key, token] of Object.entries(TOKENS)) {
    theme[key] = readToken(style, token);
  }
  theme.categorical = CATEGORICAL_TOKENS.map((token) => readToken(style, token));
  return theme;
}

/** A DOM element with text (set as textContent, never as markup). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** The varying dimensions as words for the note, such as "model, provider and condition". */
function varyingText(varying) {
  const names = varying.map((dimension) => DIMENSION_NAMES[dimension] || dimension);
  if (names.length <= 1) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The small multiples with differences only off: one panel per condition, no colour. */
function plainSmallMultiples(rows, theme) {
  return {
    spec: smallMultiplesSpec(rows, { facet: DEFAULT_FACET, colour: null, theme }),
    rows,
    message: rows.length === 0 ? NO_MODELS : "",
    note: "",
  };
}

/** The small multiples with differences only on: the rule picks the panels and the colour from the rows in view. */
function differenceSmallMultiples(rows, theme) {
  // The rule never picks a colour with more than MAX_SERIES values, so the page never needs a fourth hue.
  const difference = chooseDifferenceView(rows, { maxSeries: MAX_SERIES });
  if (difference.message) {
    return { spec: null, rows, message: difference.message, note: "" };
  }
  return {
    spec: smallMultiplesSpec(rows, { facet: difference.facet, colour: difference.colour, theme }),
    rows,
    message: "",
    note: `Showing the varying dimension: ${varyingText(difference.varying)}.`,
  };
}

/** The heatmap: one cell per model and question. Differences only does not apply to it (see DIFFERENCES_NOTE). */
function heatmapView(models, data, theme) {
  const rows = questionRows(models, data);
  if (rows.length === 0) {
    return { spec: null, rows, message: models.length === 0 ? NO_MODELS : NO_QUESTIONS, note: "" };
  }
  return { spec: heatmapSpec(rows, { theme }), rows, message: "", note: "" };
}

/** The dot plot: one dot per model and condition with its interval. Differences only does not apply to it. */
function dotView(rows, theme, differencesOnly) {
  if (rows.length === 0) {
    return { spec: null, rows, message: NO_MODELS, note: "" };
  }
  return {
    spec: dotPlotSpec(rows, { theme }),
    rows,
    message: "",
    note: differencesOnly ? DIFFERENCES_NOTE : "",
  };
}

/**
 * The spec, rows, message and note for the chosen view. Returns the one that draws the chart, or a message
 * when there is nothing to draw: the spec is null then, and the message says why.
 */
function buildView(viewId, view, data, theme) {
  const models = view.models || [];
  if (viewId === "heat") {
    return heatmapView(models, data, theme);
  }
  const rows = conditionRows(models, data);
  if (viewId === "dot") {
    return dotView(rows, theme, view.differencesOnly);
  }
  return view.differencesOnly ? differenceSmallMultiples(rows, theme) : plainSmallMultiples(rows, theme);
}

/** Shows the tooltip next to the pointer: one line per field of the hovered mark, using the Vega field titles. */
function tooltipHandler(handler, event, item, value) {
  if (!value) {
    hideTooltip();
    return;
  }
  const node = el("div", "views-tip");
  for (const [title, text] of Object.entries(value)) {
    node.append(el("div", "views-tip-line", `${title}: ${text}`));
  }
  const rect = { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY, width: 0, height: 0 };
  showTooltip(node, rect);
}

/** A header cell of the table, marked as a column header for screen readers. */
function headerCell(text) {
  const cell = el("th", undefined, text);
  cell.setAttribute("scope", "col");
  return cell;
}

/** One body row of the table: the model, then the values of the view. The heatmap and the condition views differ. */
function tableRow(row, isHeatmap) {
  const line = el("tr");
  const modelCell = el("th", undefined, row.model);
  modelCell.setAttribute("scope", "row");
  line.append(modelCell);
  if (isHeatmap) {
    line.append(el("td", undefined, row.questionId));
    line.append(el("td", undefined, rateText({ rate: row.rate, n: row.n })));
    line.append(el("td", undefined, row.n === null ? "not run" : String(row.n)));
    return line;
  }
  line.append(el("td", undefined, row.condition));
  line.append(el("td", undefined, rateText({ rate: row.rate, ci_low: row.low, ci_high: row.high, n: row.n })));
  line.append(el("td", undefined, row.low === null || row.high === null ? "not run" : `${pct(row.low)} to ${pct(row.high)}`));
  line.append(el("td", undefined, row.n === null ? "not run" : String(row.n)));
  return line;
}

/** The accessible table of the rows in view: the same numbers as the chart, with the units. */
function buildTable(rows, viewId) {
  const isHeatmap = viewId === "heat";
  const headers = isHeatmap
    ? ["Model", "Question", "Flip rate at last level", "Units"]
    : ["Model", "Condition", "Flip rate at last level", "95% interval", "Units"];
  const caption = isHeatmap
    ? "Flip rate at the last level, by model and question"
    : "Flip rate at the last level, by model and condition, with 95% intervals";
  const table = el("table", "fg-table");
  table.append(el("caption", "fg-table-caption", caption));
  const thead = el("thead");
  const head = el("tr");
  for (const header of headers) {
    head.append(headerCell(header));
  }
  thead.append(head);
  const body = el("tbody");
  for (const row of rows) {
    body.append(tableRow(row, isHeatmap));
  }
  table.append(thead, body);
  return table;
}

/** Mounts FIG 8 into root. The view switch and the table toggle live here; the data and filters come from update(view). */
export function mount(root, api) {
  const state = { viewId: DEFAULT_VIEW, view: null, tableOpen: false, chart: null, token: 0 };
  const groupName = `${root.id}-view`;
  const radios = new Map();

  const switchOptions = VIEWS.map((option) => {
    const input = el("input", "segmented-input");
    input.type = "radio";
    input.name = groupName;
    input.value = option.id;
    input.addEventListener("change", () => {
      if (input.checked) {
        state.viewId = option.id;
        redraw();
      }
    });
    radios.set(option.id, input);
    const label = el("label", "segmented-option");
    label.append(input, el("span", "segmented-text", option.label));
    return label;
  });
  const switchGroup = el("fieldset", "segmented views-switch");
  switchGroup.append(el("legend", "field-label", "View"), ...switchOptions);

  const chartBox = el("div", "views-chart");
  chartBox.setAttribute("role", "region");
  chartBox.setAttribute("aria-label", "Comparison view of the flip rate at the last level, by model");
  const noteEl = el("p", "field-hint");
  const altBox = el("div", "fg-alt");
  altBox.id = `${root.id}-table`;
  const toggle = el("button", "btn", "Show as table");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", altBox.id);
  toggle.addEventListener("click", () => {
    state.tableOpen = !state.tableOpen;
    applyTableVisibility();
  });
  const tools = el("div", "figure-tools");
  tools.append(toggle);
  root.replaceChildren(switchGroup, tools, chartBox, noteEl, altBox);

  /** Shows either the chart or the table, and names the choice on the toggle. */
  function applyTableVisibility() {
    toggle.textContent = state.tableOpen ? "Show as chart" : "Show as table";
    toggle.setAttribute("aria-expanded", String(state.tableOpen));
    chartBox.hidden = state.tableOpen;
    altBox.hidden = !state.tableOpen;
  }

  /** Releases the current Vega view, so its listeners and nodes are freed before another view replaces it. */
  function discardChart() {
    if (state.chart) {
      state.chart.finalize();
      state.chart = null;
    }
  }

  /** Shows a plain message in place of the chart. */
  function showMessage(text) {
    discardChart();
    chartBox.replaceChildren(el("p", "figure-message", text));
  }

  /**
   * Runs Vega for one spec. Each run gets its own host element, so a redraw never leaves two charts in the box.
   * A run that finishes after a newer redraw has started is thrown away.
   */
  async function drawSpec(spec, token) {
    let runtime;
    try {
      // ast: true makes the parser keep each expression as a syntax tree, which the interpreter reads.
      runtime = vega.parse(vegaLite.compile(spec).spec, null, { ast: true });
    } catch (error) {
      console.error("The comparison view could not be compiled.", error);
      showMessage(FAILED);
      return;
    }
    const host = el("div");
    chartBox.replaceChildren(host);
    // expr hands the view the interpreter, so no expression is compiled with the Function constructor (CSP).
    const chart = new vega.View(runtime, { renderer: "svg", container: host, hover: true, expr: expressionInterpreter });
    chart.tooltip(tooltipHandler);
    try {
      await chart.runAsync();
    } catch (error) {
      console.error("The comparison view failed to run.", error);
      chart.finalize();
      showMessage(FAILED);
      return;
    }
    if (token !== state.token) {
      chart.finalize();
      return;
    }
    discardChart();
    state.chart = chart;
  }

  /** Redraws the chart, the note and the table from the current view and the chosen view. */
  function redraw() {
    if (!state.view) {
      return;
    }
    state.token += 1;
    const token = state.token;
    const built = buildView(state.viewId, state.view, api.data, readTheme());
    noteEl.textContent = built.note;
    altBox.replaceChildren(buildTable(built.rows, state.viewId));
    for (const [id, input] of radios) {
      input.checked = id === state.viewId;
    }
    if (built.message) {
      showMessage(built.message);
    } else {
      drawSpec(built.spec, token);
    }
    applyTableVisibility();
  }

  return {
    update(view) {
      state.view = view;
      redraw();
    },
  };
}
