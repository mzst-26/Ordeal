// The enlarged chart. Each chart on the Live page can be opened in a large dialog that draws the same chart. In the dialog
// the visitor can filter models out, or keep only the best or worst five by performance. The dialog listens to its chart
// panel, so it is redrawn each time the page draws the chart, and a live run keeps it up to date. Text is set with
// textContent, and the chart is drawn by the chart module the panel was made with.

import { el } from "./ui.js";
import { filterChartOptions, modelNames, topModels, MEAN_NAME } from "./chart-models.js";

const TOP_COUNT = 5;

/** A button in the dialog. */
function button(text, onClick) {
  const node = el("button", { type: "button", className: "btn", text });
  node.addEventListener("click", onClick);
  return node;
}

/**
 * Open one chart in a large dialog. panel is the chart panel on the page: its chart maker is panel.create, and its
 * options are panel.options. The dialog starts with every model shown.
 */
export function openEnlargedChart(panel, title) {
  // Before the first draw there is nothing to enlarge, so the button does nothing yet.
  if (!panel.options) return;
  const hidden = new Set();
  let chart = null;

  const dialog = el("dialog", { className: "chart-dialog", "aria-label": title });
  const heading = el("h2", { className: "dialog-title", text: title });
  const checks = el("div", { className: "chart-model-checks" });
  const host = el("div", { className: "chart-dialog-host" });
  const closeButton = el("button", { type: "button", className: "btn btn-primary", text: "Close" });
  closeButton.addEventListener("click", () => dialog.close());

  /** Draw the model checkboxes, one for each model the chart has. A model that is filtered out is unticked. */
  function drawChecks(names) {
    const boxes = names.map((name) => {
      const box = el("input", { type: "checkbox", checked: !hidden.has(name) });
      box.addEventListener("change", () => {
        if (box.checked) hidden.delete(name);
        else hidden.add(name);
        showMode("custom");
        render();
      });
      return el("label", { className: "chart-model-check" }, [box, el("span", { text: name })]);
    });
    checks.replaceChildren(...boxes);
  }

  /** Draw the chart from the panel's current options, with the models that are not filtered out. */
  function render() {
    const full = panel.options;
    if (!full) return;
    const names = modelNames(full);
    // A chart with no models to filter, such as the donut, has no filter row to show.
    controls.hidden = names.length === 0;
    checks.hidden = names.length === 0;
    const kept = new Set(names.filter((name) => !hidden.has(name)));
    const shown = filterChartOptions(full, kept);
    if (chart === null) {
      chart = panel.create(host, shown);
    } else {
      chart.update(shown);
    }
    drawChecks(names);
  }

  /** Keep only the best or only the worst models, judged by the chart's own performance measure. */
  function keepOnly(which) {
    const full = panel.options;
    if (!full) return;
    const top = topModels(full, TOP_COUNT, which);
    hidden.clear();
    for (const name of modelNames(full)) {
      // The mean line is not a model, so Best and Worst leave it on the chart.
      if (!top.includes(name) && name !== MEAN_NAME) hidden.add(name);
    }
    showMode(which);
    render();
  }

  function keepAll() {
    hidden.clear();
    showMode("all");
    render();
  }

  const bestButton = button(`Best ${TOP_COUNT}`, () => keepOnly("best"));
  const worstButton = button(`Worst ${TOP_COUNT}`, () => keepOnly("worst"));
  const allButton = button("All models", keepAll);
  const controls = el("div", { className: "button-row chart-dialog-controls" }, [bestButton, worstButton, allButton]);

  // Which filter is on: "best", "worst", "all", or "custom" once a model is ticked or unticked by hand. The buttons show
  // the one that is on as pressed, so the visitor can see which filter is in use.
  function showMode(next) {
    bestButton.setAttribute("aria-pressed", String(next === "best"));
    worstButton.setAttribute("aria-pressed", String(next === "worst"));
    allButton.setAttribute("aria-pressed", String(next === "all"));
  }
  showMode("all");
  dialog.append(heading, controls, checks, host, el("div", { className: "dialog-actions" }, [closeButton]));

  // The page redraws the panel after each batch of replies, so the dialog redraws with it while it is open.
  const onPanelDraw = () => render();
  panel.listeners.push(onPanelDraw);
  dialog.addEventListener("close", () => {
    panel.listeners = panel.listeners.filter((listener) => listener !== onPanelDraw);
    if (chart !== null) chart.destroy();
    chart = null;
    dialog.remove();
  });

  document.body.append(dialog);
  // The dialog is shown before the chart is drawn, so the chart measures the dialog's width, not the page's.
  dialog.showModal();
  render();
}
