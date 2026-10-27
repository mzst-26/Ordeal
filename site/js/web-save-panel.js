// The "Save this run to the web store" panel. The Gauntlet and Batch pages both show it once a run has finished. It has
// one button, a password box that appears only when no password is kept, and one status line. The web store keeps a
// run only when the write password is sent, so the box asks for it. The password is held in a variable of this module,
// which lasts only as long as the tab: a reload clears it, and it is never written to storage, the address or the log.

import { el } from "./ui.js";
import { saveRunToWeb, SAVE_ERROR_TEXT } from "./runs-api.js";

const BUTTON_TEXT = "Save this run to the web store";
const HINT_TEXT = "Saving keeps the run on the server for 7 days. Saving needs the write password.";
const PASSWORD_LABEL = "Write password";
const NEED_PASSWORD_TEXT = "Type the write password first.";
const SAVING_TEXT = "Saving the run to the web store.";
const ALREADY_SAVED_TEXT = "This run is already saved to the web store.";
// The status the server sends when the password is wrong. The panel forgets the kept password on this answer only.
const WRONG_PASSWORD_STATUS = 401;

// The write password for this tab, or null. It is set once the server keeps a run, and cleared when the server
// refuses it. Gauntlet and Batch share this one variable, so the visitor types the password once for the whole tab.
let rememberedPassword = null;

/**
 * Build the panel for one page. kind is "batch" or "gauntlet". loadRun(runId) returns the stored run, or null.
 * The panel starts hidden. show(runId) reveals it for a finished run, and hide() removes it again. The page owns
 * the panel's place on the screen: it adds root to its own section.
 */
export function buildSavePanel({ idPrefix, kind, loadRun }) {
  // The run this panel would save, and the run it has already saved. A second press for the same run does nothing.
  let currentRunId = null;
  let savedRunId = null;
  // True while a save is in flight, so a double press cannot send the run twice.
  let busy = false;

  const passwordId = `${idPrefix}-save-password`;
  const passwordInput = el("input", {
    id: passwordId,
    type: "password",
    className: "text-input",
    autocomplete: "off",
  });
  const passwordRow = el("div", { className: "field" }, [
    el("label", { className: "field-label", for: passwordId, text: PASSWORD_LABEL }),
    passwordInput,
  ]);
  const button = el("button", { type: "button", className: "btn btn-primary", text: BUTTON_TEXT });
  const status = el("p", { className: "field-hint", role: "status", "aria-live": "polite" });
  const root = el("section", { className: "save-web" }, [
    el("p", { className: "field-hint", text: HINT_TEXT }),
    passwordRow,
    el("div", { className: "button-row" }, [button]),
    status,
  ]);
  root.hidden = true;

  /** Show the password box only when no password is kept for this tab. */
  function refreshPasswordRow() {
    passwordRow.hidden = rememberedPassword !== null;
  }

  /** Set the status line. Plain text only, so nothing is read as markup. */
  function setStatus(text) {
    status.textContent = text;
  }

  /** Keep or forget the password by the server's answer, then show the message for that answer. */
  function showAnswer(result, password) {
    if (result.saved) {
      rememberedPassword = password;
      savedRunId = currentRunId;
      passwordInput.value = "";
    } else if (result.status === WRONG_PASSWORD_STATUS) {
      rememberedPassword = null;
    }
    refreshPasswordRow();
    setStatus(result.message);
  }

  /** Send the finished run to the web store. The kept password is used when there is one, else the typed one. */
  async function save() {
    if (busy || currentRunId === null) return;
    if (currentRunId === savedRunId) {
      setStatus(ALREADY_SAVED_TEXT);
      return;
    }
    const password = rememberedPassword ?? passwordInput.value;
    if (password === "") {
      setStatus(NEED_PASSWORD_TEXT);
      passwordInput.focus();
      return;
    }
    busy = true;
    button.disabled = true;
    setStatus(SAVING_TEXT);
    try {
      const run = await loadRun(currentRunId);
      if (run === null) {
        setStatus(SAVE_ERROR_TEXT);
        return;
      }
      showAnswer(await saveRunToWeb(kind, run, password), password);
    } catch {
      // A network failure lands here. The run stays on this page, so the visitor can press the button again.
      setStatus(SAVE_ERROR_TEXT);
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  button.addEventListener("click", save);

  return {
    root,
    /** Reveal the panel for a finished run. A new run clears the old status line. */
    show(runId) {
      if (runId !== currentRunId) setStatus("");
      currentRunId = runId;
      refreshPasswordRow();
      root.hidden = false;
    },
    /** Hide the panel, for when no finished run is on screen. */
    hide() {
      currentRunId = null;
      setStatus("");
      root.hidden = true;
    },
  };
}
