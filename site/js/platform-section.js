// The "Platform and model" section. The visitor picks a platform from the shared list, uses the existing key dialog
// for the key, and types a model name or a link. "Check model" asks the chosen platform for its model list and
// confirms the id exists there. Only the id and the platform are saved for this browser. The key stays in the
// token vault, which keeps it in memory unless the visitor asks to remember it.

import { loadJson } from "./data-cache.js";
import { askForToken } from "./token-dialog.js";
import { browserStorage, vault } from "./engine/token.js";
import { fetchModelIds } from "./engine/api.js";
import {
  currentPlatform,
  findModel,
  findPlatform,
  loadPlatforms,
  parseModelReference,
  readChoice,
  usablePlatforms,
  writeChoice,
} from "./platforms.js";
import { el } from "./ui.js";

const SELECT_ID = "platform-select";
const MODEL_ID = "platform-model-input";
const STATUS_ID = "platform-status";
const KEY_ID = "platform-key-status";
const NOTE_ID = "platform-note";
const HEADING_ID = "platform-heading";
const NO_PLATFORMS_MESSAGE = "The platform list could not be loaded, so no platform can be chosen.";
const NO_KEY_HINT = "Add your key first, then check the model.";
const NO_SUGGESTIONS_HINT = "No close names were found. Check the id on the platform's model page.";

/**
 * Draw the section into root. It loads the shared list first and shows a plain message if that fails.
 * The saved choice (if any) is selected, so the page starts with what the visitor picked last time.
 */
export async function mountPlatformSection(root) {
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
  const platforms = usablePlatforms(list);
  const start = currentPlatform(list, saved);
  const view = buildSection(platforms, start, saved);
  root.replaceChildren(view.section);
  wireSection(view, platforms, storage);
  renderPlatform(view, start);
  renderKeyStatus(view);
}

/** Build the section's elements. Nothing is connected yet, and no server text is ever put in as HTML. */
function buildSection(platforms, start, saved) {
  const view = {};
  view.select = el("select", { className: "select", id: SELECT_ID, "aria-describedby": NOTE_ID },
    platforms.map((platform) => el("option", { value: platform.id, text: platform.name, selected: platform.id === start.id })));
  view.keyStatus = el("p", { className: "field-hint", id: KEY_ID });
  view.keyButton = el("button", { type: "button", className: "btn", text: "Add or change key" });
  view.input = el("input", {
    className: "text-input",
    id: MODEL_ID,
    type: "text",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: "org/name, hf:org/name, or a link to the model page",
    value: saved ? saved.model : "",
  });
  view.checkButton = el("button", { type: "button", className: "btn btn-primary", text: "Check model" });
  view.status = el("p", { className: "field-hint platform-status", id: STATUS_ID, role: "status", "aria-live": "polite" });
  view.suggestions = el("ul", { className: "platform-suggestions", "aria-label": "Close model names", hidden: true });
  view.note = el("p", { className: "field-hint", id: NOTE_ID });
  view.section = el("section", { className: "panel platform-section", "aria-labelledby": HEADING_ID }, [
    el("h2", { className: "panel-title", id: HEADING_ID, text: "Platform and model" }),
    el("div", { className: "field" }, [
      el("label", { className: "field-label", for: SELECT_ID, text: "Platform" }),
      view.select,
    ]),
    el("div", { className: "field" }, [
      el("span", { className: "field-label", text: "API key" }),
      view.keyStatus,
      view.keyButton,
    ]),
    el("div", { className: "field" }, [
      el("label", { className: "field-label", for: MODEL_ID, text: "Model" }),
      view.input,
      el("p", { className: "field-hint", text: "Type a model id such as org/name, or paste its link." }),
      view.checkButton,
      view.status,
      view.suggestions,
    ]),
    view.note,
  ]);
  return view;
}

/** Connect the controls to their actions. The saved model changes only when a model has been checked. */
function wireSection(view, platforms, storage) {
  view.select.addEventListener("change", () => {
    const platform = selectedPlatform(view, platforms);
    writeChoice(storage, { platformId: platform.id, model: "" });
    renderPlatform(view, platform);
    clearSuggestions(view);
    setStatus(view, "");
  });
  view.keyButton.addEventListener("click", async () => {
    await askForToken({ vault });
    renderKeyStatus(view);
  });
  view.checkButton.addEventListener("click", () => checkModel(view, platforms, storage));
}

/** Return the platform the select box shows. */
function selectedPlatform(view, platforms) {
  return findPlatform(platforms, view.select.value) ?? platforms[0];
}

/** Show the chosen platform's name, its signup link, and the key note. Only an https link is made clickable. */
function renderPlatform(view, platform) {
  view.note.replaceChildren();
  view.note.append(`Get a key from ${platform.name}`);
  if (typeof platform.signup === "string" && platform.signup.startsWith("https://")) {
    view.note.append(": ", el("a", { href: platform.signup, target: "_blank", rel: "noopener noreferrer", text: platform.signup }));
  }
  view.note.append(". Your key is sent only to that platform's own address.");
}

/** Say whether a key is saved for this tab, showing only the masked form. */
function renderKeyStatus(view) {
  view.keyStatus.textContent = vault.has()
    ? `A key is saved for this tab: ${vault.masked()}`
    : "No key is saved yet.";
}

/** Put a plain status line in the section. An empty text clears the line. */
function setStatus(view, text) {
  view.status.textContent = text;
}

/** Remove the suggestion buttons from the list and hide it. */
function clearSuggestions(view) {
  view.suggestions.replaceChildren();
  view.suggestions.hidden = true;
}

/**
 * Show why the model was not found, then up to five close names as buttons. Clicking a name fills the field
 * and checks it again. With no close names, the status says where to look for the right id.
 */
function showMissing(view, found, platform, platforms, storage) {
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
      checkModel(view, platforms, storage);
    });
    view.suggestions.append(el("li", {}, [button]));
  }
  view.suggestions.hidden = false;
}

/** Turn the busy state of the check on or off, so the visitor cannot start two checks at once. */
function setBusy(view, busy) {
  view.checkButton.disabled = busy;
}

/**
 * Check the typed model on the chosen platform. The key is read from the vault and sent only to the platform's
 * /models address. A missing model gets close suggestions. A found model is saved as the choice for this browser.
 */
async function checkModel(view, platforms, storage) {
  const platform = selectedPlatform(view, platforms);
  clearSuggestions(view);
  const parsed = parseModelReference(platform, view.input.value);
  if (!parsed.ok) {
    setStatus(view, parsed.reason);
    return;
  }
  if (!vault.has()) {
    await askForToken({ vault });
    renderKeyStatus(view);
  }
  if (!vault.has()) {
    setStatus(view, NO_KEY_HINT);
    return;
  }
  setBusy(view, true);
  setStatus(view, `Checking ${parsed.model} on ${platform.name}...`);
  try {
    const ids = await fetchModelIds({ platform, token: vault.get() });
    const found = findModel(platform, parsed.model, ids);
    if (found.ok) {
      writeChoice(storage, { platformId: platform.id, model: found.model });
      setStatus(view, `Found ${found.model} on ${platform.name}. Saved as your choice.`);
    } else {
      showMissing(view, found, platform, platforms, storage);
    }
  } catch (error) {
    setStatus(view, error.message);
  } finally {
    setBusy(view, false);
  }
}
