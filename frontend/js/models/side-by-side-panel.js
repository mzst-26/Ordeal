// The "Compare providers" panel on the batch view. The visitor picks up to three providers. Each one shows whether it
// is ready, needs a key, or cannot be called from this browser. A provider that cannot be called shows the reason and
// the command to run it instead. Each provider has its own key, kept by provider-keys.js.
//
// The panel only chooses and checks. The batch still runs one provider at a time: "Use for the batch" makes a provider
// the platform, and the batch page then runs it. Its replies are saved with that provider's id.
// The rules (limits, reachability, missing keys, labels) are in side-by-side.js, so this file only draws them.

import { loadJson } from "../shared/data-cache.js";
import { askForToken } from "../ui/token-dialog.js";
import { browserStorage } from "../engine/token.js";
import { slotFor } from "../engine/provider-keys.js";
import { loadPlatforms, selectablePlatforms } from "./platforms.js";
import { KEY_EVENT, RUN_LOCKED_MESSAGE, keyChanged, saveChoice } from "./platform-section.js";
import {
  addSideProvider,
  columnsFor,
  resultsTableModel,
  rowLabelsFor,
  runnableProviderIds,
  sideProviderStatuses,
} from "./side-by-side.js";
import { isRunLocked } from "../runs/run-lock.js";
import { recordsFromRun, SAVED_RUNS_CHANGED } from "../runs/saved-runs.js";
import { listRuns, openRunStorage } from "../store/run-store.js";
import { el } from "../ui/ui.js";

const PANEL_TITLE = "Compare providers";
const PANEL_HINT =
  "Pick up to 3 providers. Each one has its own key and its own run, with the same questions, conditions and seed. " +
  "This browser may call only Nebius; for the others, use the command line shown beside them.";
const LOAD_FAILED_MESSAGE = "The platform list could not be loaded, so providers cannot be compared here.";
const EMPTY_MESSAGE = "No provider chosen yet. Pick one from the list above.";
const ADD_LABEL = "Add provider";
const REMOVE_LABEL = "Remove";
const USE_LABEL = "Use for the batch";
const ADD_KEY_LABEL = "Add or change key";
const PICKER_LABEL = "Provider to compare";
const RESULTS_TITLE = "Results side by side";
const RESULTS_EMPTY = "Choose providers above. Each one's newest saved batch run appears in its own column.";
const NO_RUN_MARK = "No run";
const NO_RUN_TEXT = "No saved batch run yet for:";

/**
 * Draw the panel into root. A missing root is ignored, so a page without the panel never throws. The list is loaded
 * first, and a plain message is shown when it cannot be read.
 */
export async function mountSideBySide(root) {
  if (!root) return;
  let list;
  try {
    list = await loadPlatforms(loadJson);
  } catch {
    root.textContent = LOAD_FAILED_MESSAGE;
    return;
  }
  // The storage is opened once per page, and the draw counter lets a slow read never overwrite a newer result.
  const state = { list, chosen: [], message: "", storage: null, drawCount: 0 };
  const view = buildPanel(root, selectablePlatforms(list));
  root.replaceChildren(view.section);
  view.addButton.addEventListener("click", () => addFromPicker(view, state, root));
  window.addEventListener(KEY_EVENT, () => renderRows(view, state, root));
  window.addEventListener(SAVED_RUNS_CHANGED, () => drawResults(view, state));
  renderRows(view, state, root);
}

/** Build the panel's elements: the heading, the picker with its add button, a message line, and the list of rows. */
function buildPanel(root, pickable) {
  const select = el("select", { id: `${root.id}-picker`, "aria-label": PICKER_LABEL }, [
    el("option", { value: "", text: "Choose a provider" }),
    ...pickable.map((platform) => el("option", { value: platform.id, text: platform.name })),
  ]);
  const addButton = el("button", { type: "button", className: "btn", text: ADD_LABEL });
  const message = el("p", { className: "field-hint", role: "status", "aria-live": "polite" });
  const list = el("ul", { className: "side-by-side-list" });
  const results = el("div", { className: "side-by-side-results", "aria-live": "polite" });
  const section = el("section", { className: "panel side-by-side", "aria-labelledby": `${root.id}-heading` }, [
    el("h2", { className: "panel-title", id: `${root.id}-heading`, text: PANEL_TITLE }),
    el("p", { className: "field-hint", text: PANEL_HINT }),
    el("div", { className: "inline-row" }, [select, addButton]),
    message,
    list,
    el("h3", { className: "field-label", text: RESULTS_TITLE }),
    results,
  ]);
  return { section, select, addButton, message, list, results };
}

/** Add the provider picked in the list. A fourth provider is refused with the message from side-by-side.js. */
function addFromPicker(view, state, root) {
  const id = view.select.value;
  if (id === "") return;
  try {
    state.chosen = addSideProvider(state.chosen, id);
    state.message = "";
    view.select.value = "";
  } catch (error) {
    state.message = error.message;
  }
  renderRows(view, state, root);
}

/** Redraw the message and the rows from the current state, so every button reflects the keys saved now. */
function renderRows(view, state, root) {
  const statuses = sideProviderStatuses(state.chosen, state.list, (id) => slotFor(id).has());
  view.list.replaceChildren(...statuses.map((status) => buildRow(status, view, state, root)));
  view.message.textContent = state.message || summaryText(statuses);
  drawResults(view, state);
}

/**
 * Read the saved batch runs and draw one column per chosen provider. Only the newest draw is kept, so a slow read
 * never overwrites a newer result. When the saved runs cannot be read, the table is empty rather than wrong.
 */
async function drawResults(view, state) {
  state.drawCount += 1;
  const draw = state.drawCount;
  const runs = await readSavedRuns(state);
  if (draw !== state.drawCount) return;
  if (state.chosen.length === 0) {
    view.results.textContent = RESULTS_EMPTY;
    return;
  }
  const names = namesById(state.list);
  const model = resultsTableModel(columnsFor(state.chosen, runs, recordsFromRun), names);
  view.results.replaceChildren(...buildResultsNodes(model, names));
}

/** Return the saved batch runs, newest first. The storage is opened on first use. An empty list is returned when it cannot be read. */
async function readSavedRuns(state) {
  try {
    if (state.storage === null) {
      const opened = await openRunStorage();
      state.storage = opened.adapter;
    }
    return await listRuns(state.storage);
  } catch {
    return [];
  }
}

/** Return a map from provider id to its display name, for the column headers and the missing-run note. */
function namesById(list) {
  return Object.fromEntries(list.map((platform) => [platform.id, platform.name]));
}

/**
 * Build the results table and its notes from the table model. Every cell is set as plain text, so a saved reply can never
 * run as markup. A warning comes first when the runs are not comparable; a missing run is named under the table.
 */
function buildResultsNodes(model, names) {
  const nodes = [];
  if (model.warning !== null) {
    nodes.push(el("p", { className: "field-hint side-by-side-warning", role: "status", text: model.warning }));
  }
  if (model.rows.length > 0) {
    nodes.push(buildResultsTable(model));
  }
  if (model.missing.length > 0) {
    const missingNames = model.missing.map((id) => names[id] ?? id).join(", ");
    nodes.push(el("p", { className: "field-hint", text: `${NO_RUN_TEXT} ${missingNames}.` }));
  }
  return nodes;
}

/** Build the table: a Question column, then one column per chosen provider, each cell a short reply as plain text. */
function buildResultsTable(model) {
  const head = el("tr", {}, [
    el("th", { scope: "col", text: "Question" }),
    ...model.headers.map((header) => el("th", { scope: "col", text: header })),
  ]);
  const body = model.rows.map((row) =>
    el("tr", {}, [
      el("th", { scope: "row", text: row.question }),
      ...row.cells.map((cell) => el("td", { text: cell === null ? NO_RUN_MARK : cell })),
    ]),
  );
  return el("div", { className: "side-by-side-scroll" }, [
    el("table", { className: "side-by-side-table" }, [el("thead", {}, [head]), el("tbody", {}, body)]),
  ]);
}

/** Say how many of the chosen providers can run now. A message about a refused choice always comes first. */
function summaryText(statuses) {
  if (statuses.length === 0) return EMPTY_MESSAGE;
  return `${runnableProviderIds(statuses).length} of ${statuses.length} chosen provider(s) can run now.`;
}

/**
 * Build one row: the name, the state label, the reason when there is one, and the buttons the state allows.
 * No key text is put in the row. Only the state, the reason and the button names are shown.
 */
function buildRow(status, view, state, root) {
  const labels = rowLabelsFor(status);
  const buttons = [
    labels.canAddKey ? actionButton(ADD_KEY_LABEL, () => addKey(status.id, view, state, root)) : null,
    labels.canUse ? actionButton(USE_LABEL, () => useProvider(status.id, view, state, root)) : null,
    actionButton(REMOVE_LABEL, () => removeProvider(status.id, view, state, root)),
  ];
  return el("li", { className: "side-by-side-row" }, [
    el("strong", { text: status.name }),
    el("span", { className: "field-hint", text: ` ${labels.badge}` }),
    status.reason === "" ? null : el("p", { className: "field-hint", text: status.reason }),
    el("div", { className: "inline-row" }, buttons),
  ]);
}

/** Build one button with its label and its action. */
function actionButton(label, onClick) {
  const button = el("button", { type: "button", className: "btn", text: label });
  button.addEventListener("click", onClick);
  return button;
}

/** Remove a provider from the chosen list. Its key is kept, so adding it back needs no new key. */
function removeProvider(id, view, state, root) {
  state.chosen = state.chosen.filter((chosenId) => chosenId !== id);
  state.message = "";
  renderRows(view, state, root);
}

/** Ask for this provider's key with the same dialog the batch uses. The key is kept for this provider only. */
async function addKey(id, view, state, root) {
  await askForToken({ vault: slotFor(id), platformId: id });
  keyChanged();
  renderRows(view, state, root);
}

/**
 * Make this provider the batch's platform, so the batch page runs it. It is refused while a run is in progress, as the
 * platform panel refuses a change at that time. The platform panel then shows the new choice.
 */
function useProvider(id, view, state, root) {
  if (isRunLocked()) {
    state.message = RUN_LOCKED_MESSAGE;
    renderRows(view, state, root);
    return;
  }
  saveChoice(root.id, browserStorage(), { platformId: id, model: "" });
  state.message = `${id} is now the batch's provider. Press Start on the batch to run it.`;
  renderRows(view, state, root);
}
