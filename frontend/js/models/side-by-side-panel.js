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
import { addSideProvider, rowLabelsFor, runnableProviderIds, sideProviderStatuses } from "./side-by-side.js";
import { isRunLocked } from "../runs/run-lock.js";
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
  const state = { list, chosen: [], message: "" };
  const view = buildPanel(root, selectablePlatforms(list));
  root.replaceChildren(view.section);
  view.addButton.addEventListener("click", () => addFromPicker(view, state, root));
  window.addEventListener(KEY_EVENT, () => renderRows(view, state, root));
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
  const section = el("section", { className: "panel side-by-side", "aria-labelledby": `${root.id}-heading` }, [
    el("h2", { className: "panel-title", id: `${root.id}-heading`, text: PANEL_TITLE }),
    el("p", { className: "field-hint", text: PANEL_HINT }),
    el("div", { className: "inline-row" }, [select, addButton]),
    message,
    list,
  ]);
  return { section, select, addButton, message, list };
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
