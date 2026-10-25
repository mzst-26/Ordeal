// The "Platform and model" section. The visitor picks a platform from a popup of cards, uses the existing key dialog
// for the key, and types a model name or a link. "Check model" asks the chosen platform for its model list and
// confirms the id exists there. Only the id and the platform are saved for this browser. The key stays in the
// token vault, which keeps it in memory unless the visitor asks to remember it.
//
// The section is drawn once on the batch page and once on the gauntlet page. The two copies share one saved choice:
// each save is announced on the window, and every copy redraws itself from that announcement.

import { loadJson } from "./data-cache.js";
import { askForToken } from "./token-dialog.js";
import { browserStorage, vault } from "./engine/token.js";
import { fetchModelIds } from "./engine/api.js";
import { openPicker } from "./picker-dialog.js";
import { MODELS_PATH, platformModelIds } from "./model-list.js";
import {
  currentPlatform,
  findModel,
  loadPlatforms,
  parseModelReference,
  readChoice,
  selectablePlatforms,
  signupLink,
  writeChoice,
} from "./platforms.js";
import { el } from "./ui.js";
import { isRunLocked } from "./run-lock.js";

// The name of the window event sent after a choice is saved. Its detail holds the platform id, the model, and the
// id of the copy of the section that saved it, so that copy can skip setting its own model field again.
export const CHOICE_EVENT = "ordeal:platform-choice";

const NO_PLATFORMS_MESSAGE = "The platform list could not be loaded, so no platform can be chosen.";
const NO_SELECTABLE_MESSAGE = "No platform is available in this page right now.";
const PICKER_TITLE = "Choose a platform";
const PICKER_SEARCH = "Search platforms";
const PICKER_FAILED_MESSAGE = "The platform list could not be opened. Try again after the page reloads.";
const NO_KEY_HINT = "Add your key first, then check the model.";
const MODEL_BROWSER_TITLE = "Choose a model";
const NO_SAVED_LIST_MESSAGE = "This platform has no saved model list yet. Type a model name instead.";
const MODEL_LIST_FAILED_MESSAGE = "The model list could not be loaded. Type a model name instead.";
const RUN_LOCKED_MESSAGE = "A batch is running or waiting to start. Stop it or wait for it to finish before you change the platform or model.";
const NO_SUGGESTIONS_HINT = "No close names were found. Check the id on the platform's model page.";
const MODEL_HINT = "Type a model id such as org/name, or paste its link.";
const MODEL_PLACEHOLDER = "org/name, hf:org/name, or a link to the model page";

// True while a platform popup is open. It stops a second popup from opening on top of the first, for either copy.
let chooserOpen = false;
// True while the model list is open, so a second click does not open a second copy.
let browserOpen = false;

/**
 * Return the element ids for one copy of the section. Each id starts with the copy's root id, so the batch copy and
 * the gauntlet copy never repeat an id on the same page. This is the only place the id endings are written.
 */
function idsFor(rootId) {
  return {
    heading: `${rootId}-heading`,
    label: `${rootId}-platform-label`,
    button: `${rootId}-button`,
    keyStatus: `${rootId}-key-status`,
    input: `${rootId}-model-input`,
    status: `${rootId}-status`,
    note: `${rootId}-note`,
  };
}

/**
 * Draw the section into root. It loads the shared list first and shows a plain message if that fails. A missing
 * root is ignored, so a page without this section never throws. The saved choice (if any) decides what is shown.
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
  const view = buildSection(root, list, saved);
  root.replaceChildren(view.section);
  wireSection(view, storage);
  showChoice(view, saved);
  renderKeyStatus(view);
}

/**
 * Build the section's elements for one copy. Nothing is connected yet, and no server text is ever put in as HTML.
 * The platform list is kept on the view, so every redraw can read the same list again.
 */
function buildSection(root, list, saved) {
  const ids = idsFor(root.id);
  const view = { root, ids, list, platforms: selectablePlatforms(list), platform: null, busy: false };
  view.button = el("button", { type: "button", className: "platform-button", id: ids.button, "aria-haspopup": "dialog" }, [
    el("span", { className: "platform-button-name" }),
    el("span", { className: "platform-button-summary" }),
  ]);
  view.keyStatus = el("p", { className: "field-hint", id: ids.keyStatus });
  view.keyButton = el("button", { type: "button", className: "btn", text: "Add or change key" });
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
  view.browseButton = el("button", { type: "button", className: "btn", text: "Browse models" });
  view.checkButton = el("button", { type: "button", className: "btn btn-primary", text: "Check model" });
  view.status = el("p", { className: "field-hint platform-status", id: ids.status, role: "status", "aria-live": "polite" });
  view.suggestions = el("ul", { className: "platform-suggestions", "aria-label": "Close model names", hidden: true });
  view.note = el("p", { className: "field-hint", id: ids.note });
  view.section = el("section", { className: "panel platform-section", "aria-labelledby": ids.heading }, [
    el("h2", { className: "panel-title", id: ids.heading, text: "Platform and model" }),
    el("div", { className: "platform-grid" }, [
      // Left: the platform and the key. Right: the model and its check. The note runs under both columns.
      el("div", { className: "platform-column" }, [
        el("span", { className: "field-label", id: ids.label, text: "Platform" }),
        view.button,
        el("span", { className: "field-label", text: "API key" }),
        el("div", { className: "inline-row" }, [view.keyStatus, view.keyButton]),
      ]),
      el("div", { className: "platform-column" }, [
        el("label", { className: "field-label", for: ids.input, text: "Model" }),
        el("div", { className: "inline-row" }, [view.input, view.browseButton, view.checkButton]),
        el("p", { className: "field-hint", text: MODEL_HINT }),
        view.status,
        view.suggestions,
      ]),
      el("div", { className: "platform-footer" }, [view.note]),
    ]),
  ]);
  return view;
}

/** Connect the controls to their actions, and listen for choices saved by either copy of the section. */
function wireSection(view, storage) {
  view.button.addEventListener("click", () => openChooser(view, storage));
  view.keyButton.addEventListener("click", async () => {
    await askForToken({ vault });
    renderKeyStatus(view);
  });
  view.checkButton.addEventListener("click", () => checkModel(view, storage));
  view.browseButton.addEventListener("click", () => openModelBrowser(view));
  window.addEventListener(CHOICE_EVENT, (event) => onChoiceSaved(view, event.detail));
}

/** Redraw the copy when a choice is saved. The model field is set only for the other copy, which did not type it. */
function onChoiceSaved(view, detail) {
  if (!detail) return;
  if (detail.source !== view.root.id && typeof detail.model === "string" && detail.model !== "") {
    view.input.value = detail.model;
  }
  showChoice(view, { platformId: detail.platformId, model: detail.model });
}

/**
 * Save the choice for this browser, then tell both copies of the section. A storage error is already handled by
 * writeChoice, so the announcement still goes out and the choice lasts for this page visit.
 */
function saveChoice(view, storage, choice) {
  writeChoice(storage, choice);
  window.dispatchEvent(new CustomEvent(CHOICE_EVENT, { detail: { ...choice, source: view.root.id } }));
}

/**
 * Show the platform for a choice: the button, the note with the sign-up link, and the status line. A missing or
 * unusable choice shows the default platform. When no platform can be chosen, the button and Check model are off.
 */
function showChoice(view, choice) {
  view.platform = currentPlatform(view.list, choice);
  view.suggestions.replaceChildren();
  view.suggestions.hidden = true;
  renderButton(view);
  renderNote(view);
  renderStatus(view, choice);
  renderControls(view);
}

/** Show the chosen platform's name and summary on the button. An empty summary leaves its line out. */
function renderButton(view) {
  const platform = view.platform;
  const name = view.button.querySelector(".platform-button-name");
  const summary = view.button.querySelector(".platform-button-summary");
  name.textContent = platform ? textOf(platform.name) : NO_SELECTABLE_MESSAGE;
  summary.textContent = platform ? textOf(platform.summary) : "";
  summary.hidden = summary.textContent === "";
}

/**
 * Show a line about the choice: the sign-up link when the platform has a safe one, and the key note.
 * Only an https link is made clickable, so a bad address in the list is shown as plain text at most.
 */
function renderNote(view) {
  view.note.replaceChildren();
  if (!view.platform) return;
  const platform = view.platform;
  view.note.append(`Get a key from ${textOf(platform.name)}`);
  const link = signupLink(platform);
  if (link !== null) {
    view.note.append(": ", el("a", { href: link, target: "_blank", rel: "noopener noreferrer", text: link }));
  }
  view.note.append(". Your key is sent only to that platform's own address.");
}

/** Put the status line for the choice: the saved model when there is one, otherwise a hint to check a model. */
function renderStatus(view, choice) {
  view.status.textContent = "";
  if (!view.platform) {
    view.status.textContent = NO_SELECTABLE_MESSAGE;
    return;
  }
  if (choice && choice.model) {
    view.status.textContent = `Saved: ${choice.model} on ${textOf(view.platform.name)}.`;
  }
}

/** Turn Check model and the platform button on or off. Both are off when nothing can be chosen or a check is running. */
function renderControls(view) {
  const nothingToChoose = view.platform === null;
  view.checkButton.disabled = nothingToChoose || view.busy;
  view.button.disabled = nothingToChoose;
}

/** Return the text of a value from the list, or an empty text when the value is not a string. Never "undefined". */
function textOf(value) {
  return typeof value === "string" ? value : "";
}

/** Say whether a key is saved for this tab, showing only the masked form. */
function renderKeyStatus(view) {
  view.keyStatus.textContent = vault.has()
    ? `A key is saved for this tab: ${vault.masked()}`
    : "No key is saved yet.";
}

/**
 * Open the platform popup with one card per selectable platform. Choosing a card saves it and closes the popup.
 * A second open is ignored while one is open. The key dialog is never opened from here.
 */
function openChooser(view, storage) {
  if (isRunLocked()) {
    view.status.textContent = RUN_LOCKED_MESSAGE;
    return;
  }
  if (chooserOpen || view.platforms.length === 0) return;
  chooserOpen = true;
  try {
    const dialog = openPicker({
      title: PICKER_TITLE,
      items: view.platforms,
      isSelected: (platform) => view.platform !== null && platform.id === view.platform.id,
      onToggle: (platform) => {
        saveChoice(view, storage, { platformId: platform.id, model: "" });
        dialog.close();
      },
      renderCard: (platform) => buildCard(platform),
      bulk: false,
      searchPlaceholder: PICKER_SEARCH,
    });
    dialog.addEventListener("close", () => {
      chooserOpen = false;
    }, { once: true });
  } catch {
    // The popup could not be drawn here, so the flag is cleared and the visitor is told in the status line.
    chooserOpen = false;
    view.status.textContent = PICKER_FAILED_MESSAGE;
  }
}

/**
 * Open a searchable list of the chosen platform's saved model names. Picking a name fills the Model box, and the
 * visitor presses Check model to confirm it. It is the same saved list that the batch popup shows.
 */
async function openModelBrowser(view) {
  if (isRunLocked()) {
    setStatus(view, RUN_LOCKED_MESSAGE);
    return;
  }
  if (browserOpen || view.platform === null) return;
  browserOpen = true;
  try {
    const modelsFile = await loadJson(MODELS_PATH);
    const ids = platformModelIds(modelsFile, view.platform.id);
    if (ids.length === 0) {
      browserOpen = false;
      setStatus(view, NO_SAVED_LIST_MESSAGE);
      return;
    }
    const dialog = openPicker({
      title: MODEL_BROWSER_TITLE,
      items: ids,
      isSelected: (id) => id === view.input.value.trim(),
      onToggle: (id) => {
        view.input.value = id;
        setStatus(view, `Selected ${id}. Press Check model to confirm it.`);
        dialog.close();
      },
      renderCard: (id) => el("span", { className: "platform-card-name", text: id }),
      bulk: false,
      searchPlaceholder: "Search models",
    });
    dialog.addEventListener("close", () => {
      browserOpen = false;
    }, { once: true });
  } catch {
    browserOpen = false;
    setStatus(view, MODEL_LIST_FAILED_MESSAGE);
  }
}

/**
 * Build the text of one platform card: its name, its summary (when it has one), and a sign-up link.
 * The link stops the click here, so opening the key page does not also choose the platform.
 */
function buildCard(platform) {
  const summary = textOf(platform.summary);
  return el("span", { className: "platform-card" }, [
    el("span", { className: "platform-card-name", text: textOf(platform.name) }),
    summary === "" ? null : el("span", { className: "platform-card-summary", text: summary }),
    buildSignupLink(platform),
  ]);
}

/** Build the "Get a key" link for a card, or return null when the platform has no safe sign-up address. */
function buildSignupLink(platform) {
  const link = signupLink(platform);
  if (link === null) return null;
  const anchor = el("a", {
    className: "platform-card-link",
    href: link,
    target: "_blank",
    rel: "noopener noreferrer",
    text: "Get a key",
  });
  anchor.addEventListener("click", (event) => event.stopPropagation());
  return anchor;
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

/** Turn the busy state of the check on or off, so the visitor cannot start two checks at once. */
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
    renderKeyStatus(view);
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
      saveChoice(view, storage, { platformId: platform.id, model: found.model });
    } else {
      showMissing(view, found, storage);
    }
  } catch (error) {
    setStatus(view, error.message);
  } finally {
    setBusy(view, false);
  }
}
