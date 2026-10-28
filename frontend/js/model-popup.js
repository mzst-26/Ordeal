// The top part of the "Choose models" popup: a note when the platform has no saved list, the field for adding a
// model name, the line that says what happened, and the names the visitor added with a remove control on each.
// The page does the work (checks, saving, ticking). This module only draws the part and reports what was typed or
// clicked. All text is put in as text, never as markup, so a name from the platform is never run as HTML.

import { el } from "./ui.js";

// The note shown when the chosen platform has no saved model list. It points to the field below it.
export const NO_LIST_NOTE = "No saved model list for this platform yet. Add a model name below, or check the platform's own model page.";
const ADD_PLACEHOLDER = "org/name, hf:org/name, or a link to the model page";
const NOT_CHECKED_TEXT = "not checked";

/**
 * Build the popup's add area. The page passes two functions: onAdd(text) and onRemove(id). Each returns a promise
 * or value {message, added, addedModels}: the line to show, whether a name was added (so the field is cleared), and
 * the visitor's added names now. The area redraws its list from addedModels. Nothing here calls the network.
 */
export function buildModelAddArea({ hasList, addedModels, onAdd, onRemove }) {
  const note = el("p", { className: "field-hint", text: hasList ? "" : NO_LIST_NOTE, hidden: hasList });
  const input = el("input", {
    className: "text-input",
    type: "text",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: ADD_PLACEHOLDER,
    "aria-label": "Model id or link",
  });
  const addButton = el("button", { type: "button", className: "btn", text: "Add model" });
  const message = el("p", { className: "field-hint", role: "status", "aria-live": "polite" });
  const list = el("ul", { className: "selected-list", "aria-label": "Models you added" });
  const area = el("div", { className: "model-add-area" }, [
    note,
    // A plain heading, so the visitor can tell adding a name (this part) from ticking the rows below it.
    el("h3", { className: "field-label model-add-heading", text: "Add a model that is not in the list" }),
    el("div", { className: "add-model-row" }, [input, addButton]),
    message,
    list,
  ]);

  /** Redraw the list of added names. Each one has a remove button, and "not checked" when the list did not confirm it. */
  function setAdded(names) {
    list.replaceChildren(...names.map((entry) => addedItem(entry, (id) => remove(id))));
  }

  /** Run one add. The button is off while it runs, so a second click cannot add the same name twice. */
  async function submit() {
    addButton.disabled = true;
    try {
      const result = await onAdd(input.value);
      message.textContent = result.message;
      if (result.added) input.value = "";
      setAdded(result.addedModels);
    } finally {
      addButton.disabled = false;
    }
  }

  /** Run one remove and redraw the list from what the page reports. */
  function remove(id) {
    const result = onRemove(id);
    message.textContent = result.message;
    setAdded(result.addedModels);
  }

  addButton.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });
  setAdded(addedModels);
  return { node: area, setAdded };
}

/** Build one line of the added list: the name, a "not checked" mark when it was not confirmed, and a remove button. */
function addedItem(entry, onRemove) {
  const removeButton = el("button", {
    type: "button",
    className: "btn btn-quiet",
    text: "Remove",
    "aria-label": `Remove ${entry.id}`,
  });
  removeButton.addEventListener("click", () => onRemove(entry.id));
  return el("li", { className: "selected-item" }, [
    el("span", { className: "selected-text", text: entry.id }),
    entry.checked ? null : el("span", { className: "field-hint", text: ` (${NOT_CHECKED_TEXT})` }),
    removeButton,
  ]);
}
