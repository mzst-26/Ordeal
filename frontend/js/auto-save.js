// Saves runs to the server as they change, and says in plain words what happened. A run is sent under its own id, so
// saving it again replaces the server copy: a resumed run is never stored as a second run. Sends are throttled, so a
// run that changes every few seconds is sent about once every SAVE_EVERY_MS, and sends never overlap. The page shows
// the words from onSaveStatus, so the visitor always knows whether a run is on the server or only in this browser.

import { getRun, listRuns, deleteRun } from "./store/run-store.js";
import { saveRunOnServer, keepBrowserCopies, fetchRunList } from "./runs-api.js";
import { getBrowserId } from "./browser-id.js";
import { localRunsToRemove, LOCAL_GAUNTLET_KEEP } from "./run-housekeeping.js";

// Changes made within this many milliseconds of one another are sent together, in one save.
export const SAVE_EVERY_MS = 10000;

// The run kinds that go to the server. Anything else in the store stays in this browser.
const SERVER_KINDS = Object.freeze(["batch", "gauntlet"]);

// Timers of the runs waiting to be sent, by run id.
const waiting = new Map();
// Each send waits for the one before it, so two sends never run at once.
let queue = Promise.resolve();
// The status lines on the page, and the words they were last given.
const listeners = new Set();
let lastText = "";

/**
 * Give a status line a function to call with the status words. It is called at once with the last words, and the
 * function returned stops it. Both the batch and the gauntlet pages can show the same words.
 */
export function onSaveStatus(fn) {
  listeners.add(fn);
  fn(lastText);
  return () => listeners.delete(fn);
}

/** Set the status words and tell every status line. */
function say(text) {
  lastText = text;
  for (const fn of listeners) fn(text);
}

/** Return the time of day in the browser's own format, for the status words. */
function timeText() {
  return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Send one run now, reading it from storage at the moment of the send, so the copy holds every change made so far.
 * A run of another kind, or one that is gone, is not sent.
 */
async function sendOne(adapter, runId) {
  const run = await getRun(adapter, runId);
  const kind = run?.config?.kind;
  if (run === null || !SERVER_KINDS.includes(kind)) return;
  say("Saving to the server.");
  try {
    await saveRunOnServer(run, kind, getBrowserId());
    say(`Saved to the server at ${timeText()}. It is kept for 24 hours.`);
  } catch (error) {
    say(`Not saved to the server: ${error.message} It is kept in this browser only.`);
  }
}

/** Queue one send behind the sends already waiting, so the server sees one save at a time. */
function sendQueued(adapter, runId) {
  queue = queue.then(() => sendOne(adapter, runId)).catch(() => {});
  return queue;
}

/**
 * Ask for a run to be sent soon. A run already waiting is not queued twice, so a burst of changes becomes one send
 * at the end of the window. The send reads the run when it goes, so nothing changed in the window is lost.
 */
export function scheduleServerSave(adapter, runId) {
  if (waiting.has(runId)) return;
  say("Changes will be saved to the server shortly.");
  const timer = setTimeout(() => {
    waiting.delete(runId);
    sendQueued(adapter, runId);
  }, SAVE_EVERY_MS);
  waiting.set(runId, timer);
}

/** Send a run now, and cancel any send waiting for it. Used when a run ends, so its final state is on the server. */
export function saveServerNow(adapter, runId) {
  clearTimeout(waiting.get(runId));
  waiting.delete(runId);
  return sendQueued(adapter, runId);
}

/**
 * Remove the oldest gauntlet copies held in this browser, beyond the gauntlet cap. The run being worked on (activeId)
 * is never removed. The server copies are not changed.
 */
export async function enforceLocalCaps(adapter, activeId = null) {
  const runs = await listRuns(adapter);
  for (const id of localRunsToRemove(runs, "gauntlet", LOCAL_GAUNTLET_KEEP, activeId)) {
    await deleteRun(adapter, id);
  }
}

/**
 * Bring this browser's runs back from the server, for example after the storage was cleared. Batch runs all come back,
 * and gauntlet runs only up to the gauntlet cap. Nothing here is sent. Returns how many runs were copied.
 */
export async function restoreServerRuns(adapter) {
  try {
    const copied = await keepBrowserCopies(adapter, await fetchRunList());
    await enforceLocalCaps(adapter);
    return copied;
  } catch {
    return 0;
  }
}

