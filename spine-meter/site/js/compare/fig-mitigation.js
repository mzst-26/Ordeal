// FIG 7, "Mitigation": flip rate at the last level for each condition (none, mitigation, control),
// with the change against "none". A bar is never drawn for a null value.
import { isNotRun, pct, rateText } from "./derive.js";

const MINUS = "−";
const CONDITIONS = [
  { id: "none", label: "None" },
  { id: "mitigation", label: "Mitigation prompt" },
  { id: "control", label: "Control prompt" },
];
const CONDITION_NAMES = { none: "none", mitigation: "mitigation", control: "control" };

/** The flip rate at the last level for one condition, or null when that condition was not run for the model. */
export function mitigationRate(model, condition) {
  const entry = model && model.mitigation ? model.mitigation[condition] : null;
  const rate = entry ? entry.flip_rate_last : null;
  return isNotRun(rate) ? null : rate;
}

/**
 * The change of one rate against a base rate, in percentage points, with its interval when both have one.
 * "−12 points (95% CI −20 to −4 points)", "+3 points", or "not run" when either side is null.
 * The interval is the difference of the two interval ends, an approximation.
 */
export function deltaLabel(rate, baseRate) {
  if (isNotRun(rate) || isNotRun(baseRate)) return "not run";
  const signed = (points) => {
    if (points === 0) return "0";
    return points > 0 ? `+${points}` : `${MINUS}${Math.abs(points)}`;
  };
  const points = Math.round((rate.rate - baseRate.rate) * 100) || 0;
  const unit = Math.abs(points) === 1 ? "point" : "points";
  const main = `${signed(points)} ${unit}`;
  const haveCi =
    [rate.ci_low, rate.ci_high, baseRate.ci_low, baseRate.ci_high].every((value) => typeof value === "number");
  if (!haveCi) return main;
  const low = Math.round((rate.ci_low - baseRate.ci_high) * 100) || 0;
  const high = Math.round((rate.ci_high - baseRate.ci_low) * 100) || 0;
  return `${main} (95% CI ${signed(low)} to ${signed(high)} points)`;
}

/** The caption for a condition. "none" adds no system prompt; the other two quote the prompt text from the results file. */
export function conditionCaption(condition, prompts = {}) {
  const label = CONDITION_NAMES[condition] || condition;
  if (condition === "none") return "No system prompt is added.";
  const text = prompts[condition];
  if (!text) return `The ${label} condition's system prompt text is missing from the results file.`;
  return `The ${label} condition adds this system prompt: "${text}"`;
}

function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key === "hidden") node.hidden = Boolean(value);
    else if (key === "checked") node.checked = Boolean(value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const kid of kids) {
    if (kid !== null && kid !== undefined && kid !== false) node.append(kid);
  }
  return node;
}

export function mount(root, api) {
  const prompts = api.data.mitigation_prompts || {};
  const groupName = `${root.id}-condition`;
  const tableId = `${root.id}-table`;
  const state = {
    view: { models: [], condition: "none" },
    rowsSig: null,
    tableKey: null,
    rows: new Map(),
  };

  const radios = new Map();
  const switchOptions = CONDITIONS.map((condition) => {
    const input = h("input", {
      type: "radio",
      name: groupName,
      value: condition.id,
      class: "segmented-input",
      onchange: () => api.setCondition(condition.id),
    });
    radios.set(condition.id, input);
    return h("label", { class: "segmented-option" }, input, h("span", { class: "segmented-text", text: condition.label }));
  });

  const list = h("ul", { class: "mit-list" });
  const noteEl = h("p", { class: "field-hint" });
  const captionEl = h("p", { class: "field-hint fg-caption" });
  const chartBox = h("div", {
    class: "mit-chart",
    role: "region",
    "aria-label": "Mitigation: flip rate at the last level for the chosen condition, by model",
  }, list);
  const altBox = h("div", { class: "fg-alt", id: tableId, hidden: true });
  const toggle = h("button", {
    type: "button",
    class: "btn",
    "aria-expanded": "false",
    "aria-controls": tableId,
    text: "Show as table",
    onclick: () => {
      state.tableOpen = !state.tableOpen;
      applyVisibility();
    },
  });
  state.tableOpen = false;

  root.replaceChildren(
    h(
      "fieldset",
      { class: "segmented mit-switch" },
      h("legend", { class: "field-label", text: "Condition" }),
      ...switchOptions,
    ),
    h("div", { class: "figure-tools" }, toggle),
    chartBox,
    noteEl,
    captionEl,
    altBox,
  );

  function applyVisibility() {
    const empty = state.view.models.length === 0;
    if (empty) state.tableOpen = false;
    toggle.hidden = empty;
    toggle.textContent = state.tableOpen ? "Show as chart" : "Show as table";
    toggle.setAttribute("aria-expanded", String(state.tableOpen));
    chartBox.hidden = state.tableOpen;
    altBox.hidden = !state.tableOpen;
  }

  function buildRows(models) {
    list.replaceChildren();
    state.rows = new Map();
    for (const model of models) {
      const fill = h("div", { class: "mit-fill" });
      const track = h("div", { class: "mit-track", "aria-hidden": "true" }, fill);
      const value = h("span", { class: "mit-value" });
      const delta = h("span", { class: "mit-delta" });
      const row = h(
        "li",
        { class: "mit-row" },
        h("button", {
          type: "button",
          class: "mit-name",
          text: model.display_name || model.id,
          onclick: () => api.openModel(model.id),
        }),
        track,
        value,
        delta,
      );
      state.rows.set(model.id, { row, track, fill, value, delta, model });
      list.append(row);
    }
  }

  function buildTable(models, condition) {
    altBox.replaceChildren(
      h(
        "table",
        { class: "fg-table" },
        h("caption", {
          class: "fg-table-caption",
          text: `Mitigation: flip rate at the last level, ${CONDITION_NAMES[condition]} condition, with 95% intervals and units`,
        }),
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", { scope: "col", text: "Model" }),
            h("th", { scope: "col", text: "Flip rate at last level" }),
            h("th", { scope: "col", text: "Change against none" }),
          ),
        ),
        h(
          "tbody",
          {},
          ...models.map((model) => {
            const rate = mitigationRate(model, condition);
            const base = mitigationRate(model, "none");
            const change = condition === "none" ? (rate ? "baseline" : "not run") : deltaLabel(rate, base);
            return h(
              "tr",
              {},
              h("th", { scope: "row", text: model.display_name || model.id }),
              h("td", { text: rateText(rate) }),
              h("td", { text: change }),
            );
          }),
        ),
      ),
    );
  }

  function paint() {
    const models = state.view.models || [];
    const condition = state.view.condition || "none";
    for (const [id, input] of radios) input.checked = id === condition;

    let anyData = false;
    for (const model of models) {
      const entry = state.rows.get(model.id);
      if (!entry) continue;
      const rate = mitigationRate(model, condition);
      const base = mitigationRate(model, "none");
      if (rate) anyData = true;
      entry.track.classList.toggle("mit-track--none", !rate);
      // Bars are drawn only for real values; a null value leaves the fill at zero width.
      entry.fill.style.width = rate ? `${(rate.rate * 100).toFixed(2)}%` : "0%";
      entry.value.textContent = rate ? pct(rate.rate) : "not run";
      if (condition === "none") entry.delta.textContent = rate ? "baseline" : "not run";
      else entry.delta.textContent = deltaLabel(rate, base);
    }

    captionEl.textContent = conditionCaption(condition, prompts);
    noteEl.textContent =
      models.length > 0 && condition !== "none" && !anyData
        ? "No saved data for this condition, so every bar shows not run."
        : "";

    const key = `${condition}|${models.map((model) => model.id).join("\n")}`;
    if (key !== state.tableKey) {
      state.tableKey = key;
      buildTable(models, condition);
    }
  }

  return {
    update(view) {
      state.view = view;
      const models = view.models || [];
      applyVisibility();
      if (models.length === 0) {
        state.rows = new Map();
        state.rowsSig = null;
        state.tableKey = null;
        chartBox.replaceChildren(
          h(
            "div",
            { class: "fg-empty" },
            h("p", { text: "No models match these filters." }),
            h("button", { type: "button", class: "btn", text: "Reset filters", onclick: () => api.resetFilters() }),
          ),
        );
        altBox.replaceChildren();
        noteEl.textContent = "";
        captionEl.textContent = conditionCaption(view.condition || "none", prompts);
        return;
      }
      const sig = models.map((model) => model.id).join("\n");
      if (sig !== state.rowsSig) {
        state.rowsSig = sig;
        state.tableKey = null;
        buildRows(models);
      }
      chartBox.replaceChildren(list);
      paint();
      applyVisibility();
    },
  };
}
