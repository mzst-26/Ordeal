// The key dialog. It asks for the Nebius key and keeps it in memory only (see site/design/API_DECISION.md).

import { el } from "./ui.js";
import { isPlausibleToken, KEY_CHARACTERS_PATTERN, MIN_KEY_LENGTH, MAX_KEY_LENGTH } from "./engine/token.js";

const TITLE_ID = "token-dialog-title";
const FIELD_ID = "token-dialog-field";
const STATUS_ID = "token-dialog-status";

const PRIVACY_TEXT =
  "Your key is kept in this browser tab's memory only. It is sent only to the Nebius Token Factory " +
  "when you run an experiment. It is not saved, and closing the tab removes it.";
const SITE_TEXT =
  "We never see your key, because your browser calls the service directly. " +
  "The project's own .env key is never used on this site.";

/** Say in plain words what is wrong with the text, or return "" when it looks fine. Never repeats the text. */
function explainProblem(text) {
  if (text.length === 0) {
    return "";
  }
  if (/\s/.test(text)) {
    return "Keys have no spaces. Check that you pasted only the key.";
  }
  if (text.length < MIN_KEY_LENGTH) {
    return "This is shorter than a full key. Keep going, or paste it again.";
  }
  if (text.length > MAX_KEY_LENGTH) {
    return "This is longer than a full key. Check that you pasted only the key.";
  }
  if (!KEY_CHARACTERS_PATTERN.test(text)) {
    return "This has characters a key does not use. Check that you pasted only the key.";
  }
  return "";
}

/**
 * Open the key dialog. Resolves true when a plausible key was saved, and false when the user
 * cancels or forgets the key. Focus goes back to the element that was focused before.
 * The vault is the object from token.js and needs has(), set(text) and clear().
 */
export function askForToken({ vault }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const parts = buildDialog(vault);
    let outcome = false;

    parts.input.addEventListener("input", () => updateValidity(parts));
    parts.showButton.addEventListener("click", () => toggleVisibility(parts));
    parts.cancelButton.addEventListener("click", () => parts.dialog.close());
    parts.forgetButton.addEventListener("click", () => {
      vault.clear();
      parts.dialog.close();
    });
    parts.form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = parts.input.value.trim();
      if (isPlausibleToken(text) && saveToken(vault, text, parts)) {
        outcome = true;
        parts.dialog.close();
      }
    });
    parts.dialog.addEventListener("close", () => {
      parts.input.value = "";
      parts.dialog.remove();
      if (opener && opener.isConnected) {
        opener.focus();
      }
      resolve(outcome);
    });

    document.body.append(parts.dialog);
    parts.dialog.showModal();
    parts.input.focus();
  });
}

/** Build the dialog and its controls. Nothing is shown until the caller opens it. */
function buildDialog(vault) {
  const parts = {};
  parts.input = el("input", {
    className: "text-input",
    id: FIELD_ID,
    type: "password",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    "aria-describedby": STATUS_ID,
  });
  parts.showButton = el("button", {
    type: "button",
    className: "btn btn-quiet",
    text: "Show key",
    "aria-pressed": "false",
    "aria-controls": FIELD_ID,
  });
  parts.status = el("p", { className: "token-status", id: STATUS_ID, role: "status", "aria-live": "polite" });
  parts.saveButton = el("button", { type: "submit", className: "btn btn-primary", text: "Save key", disabled: true });
  parts.cancelButton = el("button", { type: "button", className: "btn", text: "Cancel" });
  parts.forgetButton = el("button", {
    type: "button",
    className: "btn btn-danger",
    text: "Forget key",
    hidden: !vault.has(),
  });

  const keyRow = el("div", { className: "key-row" }, [parts.input, parts.showButton]);
  const field = el("div", { className: "field" }, [
    el("label", { className: "field-label", for: FIELD_ID, text: "API key" }),
    keyRow,
    parts.status,
  ]);
  const actions = el("div", { className: "dialog-actions" }, [
    parts.forgetButton,
    parts.cancelButton,
    parts.saveButton,
  ]);
  parts.form = el("form", { className: "token-form" }, [field, actions]);
  parts.dialog = el("dialog", { className: "token-dialog", "aria-labelledby": TITLE_ID }, [
    el("h2", { className: "dialog-title", id: TITLE_ID, text: "Your key stays in this tab" }),
    el("p", { text: PRIVACY_TEXT }),
    el("p", { text: SITE_TEXT }),
    parts.form,
  ]);
  return parts;
}

/** Store the key in the vault. Returns false and shows the vault's message when the vault refuses it. */
function saveToken(vault, text, parts) {
  try {
    vault.set(text);
    return true;
  } catch (error) {
    parts.status.textContent = error.message;
    return false;
  }
}

/** Enable Save only for a plausible key, and put a plain-words hint in the status line. */
function updateValidity(parts) {
  const text = parts.input.value.trim();
  parts.saveButton.disabled = !isPlausibleToken(text);
  parts.status.textContent = explainProblem(text);
}

/** Switch the key field between hidden and visible text, and report the state on the button. */
function toggleVisibility(parts) {
  const willShow = parts.input.type === "password";
  parts.input.type = willShow ? "text" : "password";
  parts.showButton.setAttribute("aria-pressed", String(willShow));
  parts.showButton.textContent = willShow ? "Hide key" : "Show key";
}
