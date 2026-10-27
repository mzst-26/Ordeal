// The runs page. It lists the web runs kept on the server, shows the 24-hour and size note, and gives a delete button
// to each run this browser saved. The list is read when the page opens and again on Refresh. Gauntlet runs also get a
// copy kept in this browser; batch runs are not copied. Text is always set with textContent, and the rules live in
// runs-api.js.

import { el } from "./ui.js";
import { openPageStorage } from "./persistence-ui.js";
import { getBrowserId } from "./browser-id.js";
import { fetchRunList, deleteRun, keepBrowserCopies, rowText, RUNS_NOTE_TEXT } from "./runs-api.js";

const LOADING_TEXT = "Loading runs.";
const EMPTY_TEXT = "No runs are stored yet.";
const COPY_ERROR_TEXT = "The runs are listed, but the browser copies could not be saved.";
const CONFIRM_TEXT = "Delete this run? It cannot be undone.";
const DELETED_TEXT = "The run was deleted.";
const OTHER_BROWSER_TEXT = "Saved from another browser";

/** Set the status line under the controls. Plain text only. */
function setStatus(text) {
  document.getElementById("runs-status").textContent = text;
}

/** Build the row for one run: its title, its detail line, and a Delete button when this browser saved it. */
function buildRow(summary, browserId, onDeleted) {
  const text = rowText(summary, Date.now());
  const details = [
    el("p", { className: "run-label", text: text.title }),
    el("p", { className: "run-meta", text: text.meta }),
  ];
  // Only the browser that saved a run may delete it, so other runs show a plain note instead of a button.
  const action = summary.mine
    ? el("button", {
      type: "button",
      className: "btn btn-danger",
      text: "Delete",
      "aria-label": `Delete ${text.title}, saved ${summary.id.slice(0, 8)}`,
    })
    : el("p", { className: "run-meta", text: OTHER_BROWSER_TEXT });
  if (summary.mine) {
    action.addEventListener("click", () => removeRun(summary.id, browserId, onDeleted));
  }
  return el("li", { className: "run-item" }, [el("div", { className: "run-main" }, details), action]);
}

/** Ask for confirmation, delete the run for this browser, then redraw the list. */
async function removeRun(id, browserId, onDeleted) {
  if (!window.confirm(CONFIRM_TEXT)) return;
  try {
    await deleteRun(id, browserId);
    setStatus(DELETED_TEXT);
    await onDeleted();
  } catch (error) {
    setStatus(error.message);
  }
}

/** Draw the list, or the line for an empty store. */
function drawList(runs, browserId, onDeleted) {
  const items = runs.map((summary) => buildRow(summary, browserId, onDeleted));
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
async function refresh() {
  setStatus(LOADING_TEXT);
  try {
    const browserId = getBrowserId();
    const runs = await fetchRunList();
    drawList(runs, browserId, refresh);
    const copyNote = await keepCopies(runs);
    if (copyNote !== "") setStatus(copyNote);
  } catch (error) {
    setStatus(error.message);
  }
}

/** Start the page: show the note, wire Refresh, and read the list. */
function startRunsPage() {
  document.getElementById("runs-note").textContent = RUNS_NOTE_TEXT;
  document.getElementById("runs-refresh").addEventListener("click", refresh);
  refresh();
}

startRunsPage();
