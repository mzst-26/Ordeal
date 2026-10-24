// FIG 4: head to head. Two models side by side: an overlay radar of the fingerprint axes and a
// table of key metrics. The "Show me a real example" button opens FIG 5 on the axis where they differ most.

import { radarSvg } from "./radar.js";
import { isNotRun, rateText } from "./derive.js";
import { setReplay } from "./fig-replay.js";

export const CAPTION_TEXT =
  "This figure compares any two models in the run, whatever the filters above say; in the table the bolder value in each row is the better one, and a tie is not bold.";
export const NO_EXAMPLE_TEXT =
  "No fingerprint axis has a value for both models, so there is no example to show.";
export const ADD_MODEL_TEXT = "Add a second model to compare";

/** A finite number from a Rate object, a plain number, or null/undefined. Anything else is null. */
export function numericValue(value) {
  const raw = value !== null && typeof value === "object" ? value.rate : value;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * Which side is better in a row: "a", "b", or null for a tie, a missing value (not run) or a
 * row with no direction. `higherIsBetter` is true, false, or null (no direction).
 */
export function betterSide(a, b, higherIsBetter) {
  const x = numericValue(a);
  const y = numericValue(b);
  if (higherIsBetter === null || higherIsBetter === undefined) return null;
  if (x === null || y === null || x === y) return null;
  return (x > y) === higherIsBetter ? "a" : "b";
}

/**
 * The fingerprint axis with the biggest gap between two models. Axes where either value is null
 * are ignored. `valuesA` and `valuesB` map axis id to a Rate (or number, or null). Ties in the gap
 * go to the earlier axis. `higher` is the model with the higher value on that axis ("a" on a tie).
 * Returns null when no axis has both values.
 */
export function biggestGapAxis(axisIds, valuesA, valuesB) {
  let best = null;
  for (const id of axisIds) {
    const a = numericValue(valuesA?.[id]);
    const b = numericValue(valuesB?.[id]);
    if (a === null || b === null) continue;
    const gap = Math.abs(a - b);
    if (best === null || gap > best.gap) {
      best = { axis: id, gap, higher: a >= b ? "a" : "b", valueA: a, valueB: b };
    }
  }
  return best;
}

/**
 * The axes where the model with the higher value has a saved transcript, so the replay can show a real
 * example for the gap. The winner is the same as biggestGapAxis picks: "a" on a tie.
 */
export function replayableAxes(axisIds, modelA, modelB) {
  const valuesA = fingerprintValues(modelA);
  const valuesB = fingerprintValues(modelB);
  return axisIds.filter((id) => {
    const a = numericValue(valuesA[id]);
    const b = numericValue(valuesB[id]);
    if (a === null || b === null) return false;
    const winner = a >= b ? modelA : modelB;
    return Array.isArray(winner.transcripts) && winner.transcripts.some((t) => t.axis === id);
  });
}

/** The line under the headline table. */
export function headlineFormat(rate) {
  return isNotRun(rate) ? "not run" : rateText(rate);
}

function scoreText(rate) {
  if (isNotRun(rate)) return "not run";
  const mean = rate.rate.toFixed(1);
  const low = typeof rate.ci_low === "number" ? rate.ci_low.toFixed(1) : null;
  const high = typeof rate.ci_high === "number" ? rate.ci_high.toFixed(1) : null;
  return low !== null && high !== null ? `${mean} (95% CI ${low}–${high})` : mean;
}

export const METRICS = [
  { id: "baseline", label: "Baseline accuracy", higher: true, get: (m) => m.baseline_accuracy, text: headlineFormat },
  { id: "flip", label: "Flip rate at the last level", higher: false, get: (m) => m.flip_rate_last, text: headlineFormat },
  { id: "breaking", label: "Mean breaking point (Spine Score, 1 to 11)", higher: true, get: (m) => m.mean_spine_score, text: scoreText },
  { id: "backbone", label: "Backbone index", higher: true, get: (m) => m.backbone_index, text: headlineFormat },
  { id: "acceptance", label: "Acceptance mean", higher: true, get: (m) => m.acceptance_mean, text: headlineFormat },
  { id: "twin", label: "Twin discrimination (pooled)", higher: true, get: (m) => m.twin?.discrimination, text: headlineFormat },
  { id: "recovery", label: "Recovery rate", higher: true, get: (m) => m.recovery_rate, text: headlineFormat },
  { id: "final", label: "Final correct share", higher: true, get: (m) => m.final_correct_share, text: headlineFormat },
  {
    id: "units",
    label: "Units",
    higher: null,
    get: () => null,
    text: (_rate, m) => `${m.units ?? "not run"} units, ${m.questions ?? "not run"} questions`,
  },
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Sets the one-sentence caption that F1 places under the figure (created if missing). */
function setCaption(root, text) {
  const section = root.closest("section.figure");
  let caption = section ? section.querySelector(".figure-caption") : null;
  if (!caption) {
    caption = document.createElement("p");
    caption.className = "field-hint figure-caption";
    root.after(caption);
  }
  caption.textContent = text;
}

function fingerprintValues(model) {
  const values = {};
  for (const [id, rate] of Object.entries(model.fingerprint || {})) values[id] = numericValue(rate);
  return values;
}

export function mount(root, api) {
  root.replaceChildren();
  setCaption(root, CAPTION_TEXT);
  const models = api.allModels || [];
  const axes = (api.data?.axes || []).filter((a) => a.family === "fingerprint");
  const axisIds = axes.map((a) => a.id);
  const modelById = new Map(models.map((m) => [m.id, m]));

  if (models.length < 2) {
    const note = el("p", "field-hint h2h-single", ADD_MODEL_TEXT);
    root.append(note);
    return { update() {} };
  }

  const pickers = el("div", "h2h-pickers");
  const selects = {};
  for (const [key, label, defaultIndex] of [["a", "Model A", 0], ["b", "Model B", 1]]) {
    const field = el("div", "field");
    const lab = el("label", "field-label", label);
    const select = el("select", "select");
    select.id = `h2h-model-${key}`;
    lab.htmlFor = select.id;
    for (const m of models) {
      const opt = el("option", null, m.display_name || m.id);
      opt.value = m.id;
      select.append(opt);
    }
    select.value = models[defaultIndex].id;
    field.append(lab, select);
    pickers.append(field);
    selects[key] = select;
  }

  const output = el("div", "h2h-output");
  root.append(pickers, output);

  function render() {
    const a = modelById.get(selects.a.value);
    const b = modelById.get(selects.b.value);
    output.replaceChildren();
    if (!a || !b) return;

    const series = [
      { name: a.display_name || a.id, values: fingerprintValues(a), colour: "var(--cat-1)", fill: true },
      { name: b.display_name || b.id, values: fingerprintValues(b), colour: "var(--cat-2)", fill: true },
    ];
    const radar = radarSvg({
      axes: axes.map((x) => ({ id: x.id, label: x.label })),
      series,
      size: 320,
      label: `Fingerprint radar: ${series[0].name} against ${series[1].name}`,
    });
    radar.classList.add("h2h-radar");

    const legend = el("ul", "h2h-legend");
    series.forEach((s, i) => {
      const item = el("li", "h2h-legend-item");
      const swatch = el("span", `h2h-swatch h2h-swatch-${i === 0 ? "a" : "b"}`);
      swatch.setAttribute("aria-hidden", "true");
      item.append(swatch, el("span", null, s.name));
      legend.append(item);
    });

    const table = el("table", "h2h-table");
    const caption = el("caption", "h2h-table-caption", "Key metrics, side by side");
    table.append(caption);
    const head = el("tr");
    head.append(el("th", null, "Metric"), el("th", null, a.display_name || a.id), el("th", null, b.display_name || b.id));
    head.querySelectorAll("th").forEach((th) => th.setAttribute("scope", "col"));
    const thead = el("thead");
    thead.append(head);
    table.append(thead);

    const body = el("tbody");
    for (const metric of METRICS) {
      const rowA = metric.get(a);
      const rowB = metric.get(b);
      const winner = betterSide(rowA, rowB, metric.higher);
      const tr = el("tr");
      const th = el("th", null, metric.label);
      th.setAttribute("scope", "row");
      tr.append(th);
      for (const [side, model, rate] of [["a", a, rowA], ["b", b, rowB]]) {
        const td = el("td");
        const text = metric.text(rate, model);
        if (winner === side) {
          const strong = el("strong", null, text);
          td.append(strong);
        } else {
          td.textContent = text;
        }
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(body);

    const example = el("div", "h2h-example");
    const found = biggestGapAxis(replayableAxes(axisIds, a, b), fingerprintValues(a), fingerprintValues(b));
    const button = el("button", "btn", "Show me a real example");
    button.type = "button";
    button.disabled = found === null;
    const note = el("p", "field-hint h2h-example-note", found === null ? NO_EXAMPLE_TEXT : "");
    note.setAttribute("role", "status");
    if (found) {
      const axisName = axes.find((x) => x.id === found.axis)?.label ?? found.axis;
      note.textContent = `Biggest gap: ${axisName}, ${Math.round(found.valueA * 100)}% against ${Math.round(found.valueB * 100)}%.`;
      button.addEventListener("click", () => openExample(found, a, b, axisName));
    }
    example.append(button, note);

    output.append(radar, legend, table, example);
  }

  function openExample(found, a, b, axisName) {
    const winner = found.higher === "a" ? a : b;
    setReplay(winner.id, found.axis);
    const target = document.getElementById("fig-replay");
    if (target) {
      const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.setAttribute("tabindex", "-1");
      target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
      target.focus({ preventScroll: true });
    }
    if (api.announce) api.announce(`Showing a saved transcript from ${winner.display_name || winner.id} under ${axisName}.`);
  }

  selects.a.addEventListener("change", render);
  selects.b.addEventListener("change", render);
  render();

  return {
    update() {},
  };
}
