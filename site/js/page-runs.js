// The runs page. It lists only this browser's runs kept on the server, shows the retention note, and gives each run a
// Delete button. This browser's visitor id is sent with every call, so no other visitor's runs can appear here. The
// list is read when the page opens and again on Refresh. Text is always set with textContent, and the rules live in
// runs-api.js.

import { el } from "./ui.js";
import { pageVisitorId } from "./visitor-id.js";
import { fetchRunList, deleteRun, rowText, RUNS_NOTE_TEXT } from "./runs-api.js";

const LOADING_TEXT = "Loading runs.";
const EMPTY_TEXT = "No runs are saved in this browser yet.";
const CONFIRM_TEXT = "Delete this run? It cannot be undone.";
const DELETED_TEXT = "The run was deleted.";

/** Set the status line under the controls. Plain text only. */
function setStatus(text) {
  document.getElementById("runs-status").textContent = text;
}

/** Build the row for one run: its title, its detail line and a Delete button. */
function buildRow(summary, visitorId, onDeleted) {
  const text = rowText(summary, Date.now());
  const remove = el("button", {
    type: "button",
    className: "btn btn-danger",
    text: "Delete",
    "aria-label": `Delete ${text.title}, saved ${summary.id.slice(0, 8)}`,
  });
  remove.addEventListener("click", () => removeRun(summary.id, visitorId, onDeleted));
  return el("li", { className: "run-item" }, [
    el("div", { className: "run-main" }, [
      el("p", { className: "run-label", text: text.title }),
      el("p", { className: "run-meta", text: text.meta }),
    ]),
    remove,
  ]);
}

/** Ask for confirmation, delete the run for this visitor, then redraw the list. */
async function removeRun(id, visitorId, onDeleted) {
  if (!window.confirm(CONFIRM_TEXT)) return;
  try {
    await deleteRun(visitorId, id);
    setStatus(DELETED_TEXT);
    await onDeleted();
  } catch (error) {
    setStatus(error.message);
  }
}

/** Draw the list, or the line for an empty list. */
function drawList(runs, visitorId, onDeleted) {
  const items = runs.map((summary) => buildRow(summary, visitorId, onDeleted));
  const list = el("ol", { className: "run-list" }, items);
  document.getElementById("runs-list").replaceChildren(list);
  setStatus(runs.length === 0 ? EMPTY_TEXT : "");
}

/** Read this visitor's list from the server and draw it. A failure is shown in the status line. */
async function refresh(visitorId) {
  setStatus(LOADING_TEXT);
  try {
    const runs = await fetchRunList(visitorId);
    drawList(runs, visitorId, () => refresh(visitorId));
  } catch (error) {
    setStatus(error.message);
  }
}

/** Start the page: show the note, wire Refresh, and read this visitor's list. */
function startRunsPage() {
  const visitorId = pageVisitorId();
  document.getElementById("runs-note").textContent = RUNS_NOTE_TEXT;
  document.getElementById("runs-refresh").addEventListener("click", () => refresh(visitorId));
  refresh(visitorId);
}

startRunsPage();
