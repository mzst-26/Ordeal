// The "Platform and key" panel. It holds the platform and the API key only: the visitor picks a platform from a popup
// of cards, and uses the existing key dialog for the key. Models are picked in section 4 of the batch page instead
// (see model-check.js and page-batch.js), so there is one place to pick them. Only the platform id is saved for this
// browser. The key stays in the token vault, which keeps it in memory unless the visitor asks to remember it.
//
// The panel is drawn once on the batch page and once on the gauntlet page. The two copies share one saved choice:
// each save is announced on the window, and every copy redraws itself from that announcement.

import { loadJson } from "./data-cache.js";
import { askForToken } from "./token-dialog.js";
import { browserStorage, vault } from "./engine/token.js";
import { openPicker } from "./picker-dialog.js";
import {
  currentPlatform,
  loadPlatforms,
  readChoice,
  selectablePlatforms,
  signupLink,
  writeChoice,
} from "./platforms.js";
import { el } from "./ui.js";
import { isRunLocked } from "./run-lock.js";

// The name of the window event sent after a choice is saved. Its detail holds the platform id, the model, and the
// id of the copy that saved it. Every copy of the panel, and the model check, listen for it and redraw.
export const CHOICE_EVENT = "ordeal:platform-choice";
// The name of the window event sent after the key is added or changed. Each copy of the panel redraws its key line,
// so a key added from the model check is shown in the panel too.
export const KEY_EVENT = "ordeal:key-changed";

// Plain messages shared with the model check, so both places say the same thing.
export const NO_SELECTABLE_MESSAGE = "No platform is available in this page right now.";
export const RUN_LOCKED_MESSAGE = "A batch is running or waiting to start. Stop it or wait for it to finish before you change the platform, the key or the models.";

const NO_PLATFORMS_MESSAGE = "The platform list could not be loaded, so no platform can be chosen.";
const PICKER_TITLE = "Choose a platform";
const PICKER_SEARCH = "Search platforms";
const PICKER_FAILED_MESSAGE = "The platform list could not be opened. Try again after the page reloads.";

// True while a platform popup is open. It stops a second popup from opening on top of the first, for either copy.
let chooserOpen = false;

/**
 * Return the element ids for one copy of the panel. Each id starts with the copy's root id, so the batch copy and
 * the gauntlet copy never repeat an id on the same page. This is the only place the id endings are written.
 */
function idsFor(rootId) {
  return {
    heading: `${rootId}-heading`,
    label: `${rootId}-platform-label`,
    button: `${rootId}-button`,
    keyStatus: `${rootId}-key-status`,
    status: `${rootId}-status`,
    note: `${rootId}-note`,
  };
}

/**
 * Draw the panel into root. It loads the shared list first and shows a plain message if that fails. A missing root is
 * ignored, so a page without this panel never throws. The saved choice (if any) decides which platform is shown.
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
  const view = buildSection(root, list);
  root.replaceChildren(view.section);
  wireSection(view, storage);
  showChoice(view, saved);
  renderKeyStatus(view);
}

/**
 * Build the panel's elements for one copy. Nothing is connected yet, and no server text is ever put in as HTML.
 * The platform list is kept on the view, so every redraw can read the same list again.
 */
function buildSection(root, list) {
  const ids = idsFor(root.id);
  const view = { root, ids, list, platforms: selectablePlatforms(list), platform: null };
  view.button = el("button", { type: "button", className: "platform-button", id: ids.button, "aria-haspopup": "dialog" }, [
    el("span", { className: "platform-button-name" }),
    el("span", { className: "platform-button-summary" }),
  ]);
  view.keyStatus = el("p", { className: "field-hint", id: ids.keyStatus });
  view.keyButton = el("button", { type: "button", className: "btn", text: "Add or change key" });
  view.status = el("p", { className: "field-hint platform-status", id: ids.status, role: "status", "aria-live": "polite" });
  view.note = el("p", { className: "field-hint", id: ids.note });
  view.section = el("section", { className: "panel platform-section", "aria-labelledby": ids.heading }, [
    el("h2", { className: "panel-title", id: ids.heading, text: "Platform and key" }),
    el("div", { className: "platform-grid" }, [
      // Left: the platform. Right: the key. The note runs under both columns.
      el("div", { className: "platform-column" }, [
        el("span", { className: "field-label", id: ids.label, text: "Platform" }),
        view.button,
        view.status,
      ]),
      el("div", { className: "platform-column" }, [
        el("span", { className: "field-label", text: "API key" }),
        el("div", { className: "inline-row" }, [view.keyStatus, view.keyButton]),
      ]),
      el("div", { className: "platform-footer" }, [view.note]),
    ]),
  ]);
  return view;
}

/** Connect the controls to their actions, and listen for choices and key changes made in either copy. */
function wireSection(view, storage) {
  view.button.addEventListener("click", () => openChooser(view, storage));
  view.keyButton.addEventListener("click", async () => {
    await askForToken({ vault });
    keyChanged();
  });
  window.addEventListener(CHOICE_EVENT, (event) => showChoice(view, event.detail));
  window.addEventListener(KEY_EVENT, () => renderKeyStatus(view));
}

/**
 * Save the choice for this browser, then tell every copy of the panel and the model check. A storage error is already
 * handled by writeChoice, so the announcement still goes out and the choice lasts for this page visit.
 * The source is the id of the copy that saved it.
 */
export function saveChoice(sourceId, storage, choice) {
  writeChoice(storage, choice);
  window.dispatchEvent(new CustomEvent(CHOICE_EVENT, { detail: { ...choice, source: sourceId } }));
}

/** Tell every copy that the key changed, so each one shows the key that is saved now. */
export function keyChanged() {
  window.dispatchEvent(new Event(KEY_EVENT));
}

/**
 * Show the platform for a choice: the button and the note with the sign-up link. A missing or unusable choice shows
 * the default platform. When no platform can be chosen, the button is off and the status says so.
 */
function showChoice(view, choice) {
  view.platform = currentPlatform(view.list, choice);
  renderButton(view);
  renderNote(view);
  renderStatus(view);
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

/** Clear the status line. It only shows a message when no platform can be chosen, so the visitor knows why. */
function renderStatus(view) {
  view.status.textContent = view.platform === null ? NO_SELECTABLE_MESSAGE : "";
}

/** Turn the platform button on or off. It is off when nothing can be chosen. */
function renderControls(view) {
  view.button.disabled = view.platform === null;
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
        saveChoice(view.root.id, storage, { platformId: platform.id, model: "" });
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
