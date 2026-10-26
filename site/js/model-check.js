// The "not in the list" field in section 4 (Pick models) of the batch page. The visitor types a model name that the
// picker does not have and presses Check model. This module only draws the field and asks the page to add the name.
//
// Why there is one add path: the page's own "Add another model name" field and this one must do the same thing. A name
// is checked against the chosen platform's list, then ticked and added to the picker (page-batch.js, addTypedModel).
// Saving a separate choice here would be a second add path, and nothing reads that choice, so a found name would
// never reach the run. This module therefore keeps no state of its own and does not save anything.

import { askForToken } from "./token-dialog.js";
import { vault } from "./engine/token.js";
import { el } from "./ui.js";
import { isRunLocked } from "./run-lock.js";
import { RUN_LOCKED_MESSAGE, keyChanged } from "./platform-section.js";

const NO_KEY_HINT = "Add your key first, then check the model.";
const ADD_LABEL = "Add a model that is not in the list";
const CHECKING_TEXT = "Checking the name on the platform...";
const MODEL_HINT = "Type a model id such as org/name, or paste its link.";
const MODEL_PLACEHOLDER = "org/name, hf:org/name, or a link to the model page";

/**
 * Draw the field into root, and connect Check model to onCheck. onCheck(text) is the page's add function: it returns
 * {message, added, addedModels}, the same result "Add another model name" gets, and the line shows its message.
 * A missing root is ignored, so a page without this field never throws.
 */
export function mountModelCheck(root, onCheck) {
  if (!root) return;
  const view = buildCheck(root, onCheck);
  root.replaceChildren(...view.nodes);
  view.checkButton.addEventListener("click", () => runCheck(view));
}

/** Build the field's elements. Nothing is connected yet, and nothing the visitor types is put in as markup. */
function buildCheck(root, onCheck) {
  const inputId = `${root.id}-input`;
  const view = { onCheck };
  view.input = el("input", {
    className: "text-input",
    id: inputId,
    type: "text",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: MODEL_PLACEHOLDER,
  });
  // The button takes the same width as the other section 4 actions (see .platform-action in page-batch.css).
  view.checkButton = el("button", { type: "button", className: "btn btn-primary platform-action", text: "Check model" });
  view.status = el("p", { className: "field-hint platform-status", id: `${root.id}-status`, role: "status", "aria-live": "polite" });
  view.nodes = [
    el("label", { className: "field-label", for: inputId, text: ADD_LABEL }),
    view.input,
    el("p", { className: "field-hint", text: MODEL_HINT }),
    view.checkButton,
    view.status,
  ];
  return view;
}

/**
 * Check the typed name through the page's add path. The key is asked for first, as before, because the platform's own
 * list is needed to confirm the name. A busy flag stops a second check from starting while one runs.
 */
async function runCheck(view) {
  if (isRunLocked()) {
    view.status.textContent = RUN_LOCKED_MESSAGE;
    return;
  }
  if (!vault.has()) {
    await askForToken({ vault });
    keyChanged();
  }
  if (!vault.has()) {
    view.status.textContent = NO_KEY_HINT;
    return;
  }
  view.checkButton.disabled = true;
  view.status.textContent = CHECKING_TEXT;
  try {
    const result = await view.onCheck(view.input.value);
    view.status.textContent = result.message;
    if (result.added) view.input.value = "";
  } catch (error) {
    view.status.textContent = error.message;
  } finally {
    view.checkButton.disabled = false;
  }
}
