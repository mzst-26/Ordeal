// The "not in the list" check on the batch page, drawn in section 4 (Pick models). The visitor types a model name that
// the picker does not have, presses Check model, and the chosen platform's own list confirms the name. A name that is
// found is saved as the choice for this browser; a name that is missing gets up to five close names to try.
//
// This check used to sit in the platform panel. It moved here so that models are picked in one place. Its messages
// are the same as before. The saved name is shown back on this line, but the run itself uses the models that are
// ticked in the picker (page-batch.js). The request path reads only the platform (platform-choice.js).

import { loadJson } from "./data-cache.js";
import { askForToken } from "./token-dialog.js";
import { browserStorage, vault } from "./engine/token.js";
import { fetchModelIds } from "./engine/api.js";
import { currentPlatform, findModel, loadPlatforms, parseModelReference, readChoice } from "./platforms.js";
import { el } from "./ui.js";
import { isRunLocked } from "./run-lock.js";
import {
  CHOICE_EVENT,
  NO_SELECTABLE_MESSAGE,
  RUN_LOCKED_MESSAGE,
  keyChanged,
  saveChoice,
  textOf,
} from "./platform-section.js";

const NO_PLATFORMS_MESSAGE = "The platform list could not be loaded, so no platform can be chosen.";
const NO_KEY_HINT = "Add your key first, then check the model.";
const ADD_LABEL = "Add a model that is not in the list";
const MODEL_HINT = "Type a model id such as org/name, or paste its link.";
const MODEL_PLACEHOLDER = "org/name, hf:org/name, or a link to the model page";
const NO_SUGGESTIONS_HINT = "No close names were found. Check the id on the platform's model page.";

/**
 * Return the element ids for the check. They start with the root's id, so a second copy on the page would not repeat
 * them. This is the only place these id endings are written.
 */
function idsFor(rootId) {
  return { input: `${rootId}-input`, status: `${rootId}-status` };
}

/**
 * Draw the check into root. It loads the shared platform list first and shows a plain message if that fails. A
 * missing root is ignored, so a page without this check never throws. The saved choice decides the platform shown.
 */
export async function mountModelCheck(root) {
  if (!root) return;
  let list;
  try {
    list = await loadPlatforms(loadJson);
  } catch {
    root.textContent = NO_PLATFORMS_MESSAGE;
    return;
  }
  const storage = browserStorage();
  const saved = readChoice(storage);
  const view = buildCheck(root, list, saved);
  root.replaceChildren(...view.nodes);
  wireCheck(view, storage);
  showChoice(view, saved);
}

/**
 * Build the check's elements for one copy. Nothing is connected yet. The model box starts with the saved name, so a
 * reload shows the same name the visitor last checked.
 */
function buildCheck(root, list, saved) {
  const ids = idsFor(root.id);
  const view = { root, ids, list, platform: null, busy: false };
  view.input = el("input", {
    className: "text-input",
    id: ids.input,
    type: "text",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: MODEL_PLACEHOLDER,
    value: saved ? saved.model : "",
  });
  // The button takes the same width as the other section 4 actions (see .platform-action in page-batch.css).
  view.checkButton = el("button", { type: "button", className: "btn btn-primary platform-action", text: "Check model" });
  view.status = el("p", { className: "field-hint platform-status", id: ids.status, role: "status", "aria-live": "polite" });
  view.suggestions = el("ul", { className: "platform-suggestions", "aria-label": "Close model names", hidden: true });
  view.nodes = [
    el("label", { className: "field-label", for: ids.input, text: ADD_LABEL }),
    view.input,
    el("p", { className: "field-hint", text: MODEL_HINT }),
    view.checkButton,
    view.status,
    view.suggestions,
  ];
  return view;
}

/** Connect the button, and listen for a choice saved by either copy of the section so the platform shown stays right. */
function wireCheck(view, storage) {
  view.checkButton.addEventListener("click", () => checkModel(view, storage));
  window.addEventListener(CHOICE_EVENT, (event) => showChoice(view, event.detail));
}

/**
 * Show the platform for a choice: the status line with the saved name when there is one, and the button. A missing or
 * unusable choice shows the default platform. With no platform to check against, the button is off.
 */
function showChoice(view, choice) {
  view.platform = currentPlatform(view.list, choice);
  clearSuggestions(view);
  renderStatus(view, choice);
  renderControls(view);
}

/** Put the status line: a message when no platform can be chosen, the saved name when there is one, otherwise blank. */
function renderStatus(view, choice) {
  view.status.textContent = "";
  if (view.platform === null) {
    view.status.textContent = NO_SELECTABLE_MESSAGE;
    return;
  }
  if (choice && choice.model) {
    view.status.textContent = `Saved: ${choice.model} on ${textOf(view.platform.name)}.`;
  }
}

/** Turn Check model on or off. It is off when nothing can be checked or a check is already running. */
function renderControls(view) {
  view.checkButton.disabled = view.platform === null || view.busy;
}

/** Put a plain line in the status. An empty text clears it. */
function setStatus(view, text) {
  view.status.textContent = text;
}

/** Remove the close names from the list and hide it. */
function clearSuggestions(view) {
  view.suggestions.replaceChildren();
  view.suggestions.hidden = true;
}

/**
 * Show why the model was not found, then up to five close names as buttons. Clicking a name fills the field and
 * checks it again. With no close names, the status says where to look for the right id.
 */
function showMissing(view, found, storage) {
  clearSuggestions(view);
  if (found.suggestions.length === 0) {
    setStatus(view, found.reason + " " + NO_SUGGESTIONS_HINT);
    return;
  }
  setStatus(view, found.reason + " Did you mean one of these?");
  for (const name of found.suggestions) {
    const button = el("button", { type: "button", className: "btn btn-quiet", text: name });
    button.addEventListener("click", () => {
      view.input.value = name;
      checkModel(view, storage);
    });
    view.suggestions.append(el("li", {}, [button]));
  }
  view.suggestions.hidden = false;
}

/** Turn the busy state on or off, so the visitor cannot start two checks at once. */
function setBusy(view, busy) {
  view.busy = busy;
  renderControls(view);
}

/**
 * Check the typed model on the chosen platform. The key is read from the vault and sent only to the platform's
 * /models address. A missing model gets close suggestions. A found model is saved as the choice for this browser.
 */
async function checkModel(view, storage) {
  const platform = view.platform;
  if (platform === null) return;
  // A check that would save a new choice is refused during a run, the same as a platform change.
  if (isRunLocked()) {
    setStatus(view, RUN_LOCKED_MESSAGE);
    return;
  }
  clearSuggestions(view);
  const parsed = parseModelReference(platform, view.input.value);
  if (!parsed.ok) {
    setStatus(view, parsed.reason);
    return;
  }
  if (!vault.has()) {
    await askForToken({ vault });
    keyChanged();
  }
  if (!vault.has()) {
    setStatus(view, NO_KEY_HINT);
    return;
  }
  setBusy(view, true);
  setStatus(view, `Checking ${parsed.model} on ${textOf(platform.name)}...`);
  try {
    const ids = await fetchModelIds({ platform, token: vault.get() });
    const found = findModel(platform, parsed.model, ids);
    if (found.ok) {
      saveChoice(view.root.id, storage, { platformId: platform.id, model: found.model });
    } else {
      showMissing(view, found, storage);
    }
  } catch (error) {
    setStatus(view, error.message);
  } finally {
    setBusy(view, false);
  }
}
