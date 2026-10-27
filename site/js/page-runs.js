// The runs page. It lists the web runs kept on the server, shows the 7-day and size note, and gives each run a delete
// button. The list is read when the page opens and again on Refresh. Gauntlet runs also get a copy kept in this
// browser; batch runs are not copied. Text is always set with textContent, and the rules live in runs-api.js.

import { el } from "./ui.js";
import { openPageStorage } from "./persistence-ui.js";
import { fetchRunList, deleteRun, keepBrowserCopies, rowText, RUNS_NOTE_TEXT } from "./runs-api.js";

const LOADING_TEXT = "Loading runs.";
const EMPTY_TEXT = "No runs are stored yet.";
const COPY_ERROR_TEXT = "The runs are listed, but the browser copies could not be saved.";
const CONFIRM_TEXT = "Delete this run? It cannot be undone.";
const DELETED_TEXT = "The run was deleted.";

/** Set the status line under the controls. Plain text only. */
function setStatus(text) {
  document.getElementById("runs-status").textContent = text;
}

/** Build the row for one run: its title, its detail line and a Delete button. */
function buildRow(summary, passwordInput, onDeleted) {
  const text = rowText(summary, Date.now());
  const remove = el("button", {
    type: "button",
    className: "btn btn-danger",
    text: "Delete",
    "aria-label": `Delete ${text.title}, saved ${summary.id.slice(0, 8)}`,
  });
  remove.addEventListener("click", () => removeRun(summary.id, passwordInput, onDeleted));
  return el("li", { className: "run-item" }, [
    el("div", { className: "run-main" }, [
      el("p", { className: "run-label", text: text.title }),
      el("p", { className: "run-meta", text: text.meta }),
    ]),
    remove,
  ]);
}

/** Ask for confirmation, delete the run with the typed password, then redraw the list. */
async function removeRun(id, passwordInput, onDeleted) {
  if (!window.confirm(CONFIRM_TEXT)) return;
  try {
    await deleteRun(id, passwordInput.value);
    setStatus(DELETED_TEXT);
    await onDeleted();
  } catch (error) {
    setStatus(error.message);
  }
}

/** Draw the list, or the line for an empty store. */
function drawList(runs, passwordInput, onDeleted) {
  const items = runs.map((summary) => buildRow(summary, passwordInput, onDeleted));
  const list = el("ol", { className: "run-list" }, items);
  document.getElementById("runs-list").replaceChildren(list);
  setStatus(runs.length === 0 ? EMPTY_TEXT : "");
}

/** Save browser copies of the gauntlet runs. A failure here does not hide the list, so it only sets a note. */
async function keepCopies(runs) {
  try {
    const storage = await openPageStorage();
    await keepBrowserCopies(storage.adapter, runs);
    return "";
  } catch {
    return COPY_ERROR_TEXT;
  }
}

/** Read the list from the server, keep the browser copies, and draw everything. */
async function refresh(passwordInput) {
  setStatus(LOADING_TEXT);
  try {
    const runs = await fetchRunList();
    drawList(runs, passwordInput, () => refresh(passwordInput));
    const copyNote = await keepCopies(runs);
    if (copyNote !== "") setStatus(copyNote);
  } catch (error) {
    setStatus(error.message);
  }
}

/** Start the page: show the note, wire Refresh, and read the list. */
function startRunsPage() {
  document.getElementById("runs-note").textContent = RUNS_NOTE_TEXT;
  const passwordInput = document.getElementById("runs-password");
  document.getElementById("runs-refresh").addEventListener("click", () => refresh(passwordInput));
  refresh(passwordInput);
}

startRunsPage();
