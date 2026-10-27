// Browser side of the web runs. It calls the /api/runs server functions, decides which gauntlet runs get a copy kept
// in the browser, and writes the text shown in each row of the runs page. The calls take a fetch function as an
// argument, so a test can pass a fake one. The password is sent only in the request header and is never stored.

import { listRuns, keepRunCopy } from "./store/run-store.js";
import { RETENTION_DAYS, DAY_MS } from "./run-retention.js";

/** The note the runs page shows, so the visitor knows the 7-day, 1.5 GB and delete rules. */
export const RUNS_NOTE_TEXT = "Runs are kept for 7 days. The store holds up to 1.5 GB; the oldest runs are removed first "
  + "when it is full. You can delete a run at any time.";

const API_PATH = "/api/runs";
const KIND_LABELS = Object.freeze({ batch: "Batch run", gauntlet: "Gauntlet run" });
const SIZE_UNITS = Object.freeze([
  ["GB", 1024 * 1024 * 1024],
  ["MB", 1024 * 1024],
  ["KB", 1024],
]);
const LIST_ERROR_TEXT = "The runs could not be loaded from the server.";
const READ_ERROR_TEXT = "That run could not be read from the server.";
const WRONG_PASSWORD_TEXT = "The write password is missing or wrong.";
const DELETE_ERROR_TEXT = "The run could not be deleted.";
const SAVED_TEXT = "Saved to the web store. It is kept for 7 days.";
// Exported so the save panel can show the same words when the request never reaches the server.
export const SAVE_ERROR_TEXT = "The run could not be saved to the web store.";
const SAVE_TOO_BIG_TEXT = "This run is too large for the 1.5 GB store, so it was not saved.";
// The status the server sends back when it has kept a new run.
const CREATED_STATUS = 201;
const TOO_BIG_STATUS = 413;

/** Call the browser's fetch. Passed as a function, so a test can replace it without touching the global. */
function defaultFetch(url, init) {
  return globalThis.fetch(url, init);
}

/** Return the address of the runs list, or of one run when an id is given. */
export function runsUrl(id) {
  return id === undefined ? API_PATH : `${API_PATH}?id=${encodeURIComponent(id)}`;
}

/** Read the list of runs from the server and return the summaries. Reading needs no password. */
export async function fetchRunList(fetchFn = defaultFetch) {
  const response = await fetchFn(runsUrl());
  if (!response.ok) throw new Error(LIST_ERROR_TEXT);
  const body = await response.json();
  return body.runs;
}

/** Read one run, with its full record, from the server. */
export async function fetchRunRecord(id, fetchFn = defaultFetch) {
  const response = await fetchFn(runsUrl(id));
  if (!response.ok) throw new Error(READ_ERROR_TEXT);
  return response.json();
}

/**
 * Delete one run on the server. The password goes only in the Authorization header, as a Bearer value, and is not
 * kept anywhere. A 401 means the password was wrong or missing, which gets its own message.
 */
export async function deleteRun(id, password, fetchFn = defaultFetch) {
  const response = await fetchFn(runsUrl(id), {
    method: "DELETE",
    headers: { authorization: `Bearer ${password}` },
  });
  if (response.status === 401) throw new Error(WRONG_PASSWORD_TEXT);
  if (!response.ok) throw new Error(DELETE_ERROR_TEXT);
  return true;
}

/**
 * Return the ids of the gauntlet runs that have no copy in the browser yet. Batch runs are never copied, so they
 * are left out here, and a run already held in the browser is left out too.
 */
export function planBrowserCopies(summaries, localIds) {
  const held = new Set(localIds);
  return summaries
    .filter((summary) => summary.kind === "gauntlet" && !held.has(summary.id))
    .map((summary) => summary.id);
}

/**
 * Save a browser copy of each planned gauntlet run, fetched from the server. A record whose run id does not match
 * the id asked for is skipped, so a bad answer cannot write the wrong run. Returns how many copies were saved.
 */
export async function keepBrowserCopies(adapter, summaries, fetchFn = defaultFetch) {
  const localRuns = await listRuns(adapter);
  let copied = 0;
  for (const id of planBrowserCopies(summaries, localRuns.map((run) => run.id))) {
    const record = await fetchRunRecord(id, fetchFn);
    if (record.run && record.run.id === id) {
      await keepRunCopy(adapter, record.run);
      copied += 1;
    }
  }
  return copied;
}

/**
 * Return the body of a save request. The server reads the kind and the run from it. The password is not in the body:
 * it travels only in the header, so it is never written into a stored record.
 */
export function buildSaveBody(kind, run) {
  return { kind, run };
}

/**
 * Return the headers of a save request. The password is sent as a Bearer value, the same way as a delete, and the
 * body is declared as JSON so the server reads it as one.
 */
export function buildSaveHeaders(password) {
  return { "content-type": "application/json", authorization: `Bearer ${password}` };
}

/**
 * Return the plain message the page shows for a save answer, given its HTTP status. Only the statuses the page can
 * act on get their own words; every other failure gets the general message.
 */
export function saveMessage(status) {
  if (status === CREATED_STATUS) return SAVED_TEXT;
  if (status === 401) return WRONG_PASSWORD_TEXT;
  if (status === TOO_BIG_STATUS) return SAVE_TOO_BIG_TEXT;
  return SAVE_ERROR_TEXT;
}

/**
 * Send one run to the web store. Returns { saved, status, message }: saved is true only when the server kept the
 * run, status is the HTTP status it sent, and message is the text to show. A network failure makes fetch throw,
 * and the caller shows SAVE_ERROR_TEXT.
 */
export async function saveRunToWeb(kind, run, password, fetchFn = defaultFetch) {
  const response = await fetchFn(API_PATH, {
    method: "POST",
    headers: buildSaveHeaders(password),
    body: JSON.stringify(buildSaveBody(kind, run)),
  });
  return {
    saved: response.status === CREATED_STATUS,
    status: response.status,
    message: saveMessage(response.status),
  };
}

/**
 * Return how many whole days a run has left before the 7-day limit, never below 0. A run saved just now has 7 days
 * left; a run 7 days old has none. Rounding up means a run with part of a day left still shows that day.
 */
export function daysLeft(createdAtMs, nowMs) {
  const endsAt = createdAtMs + RETENTION_DAYS * DAY_MS;
  return Math.max(0, Math.ceil((endsAt - nowMs) / DAY_MS));
}

/** Return a size in the largest unit that keeps the number under 1024, with one decimal place for KB, MB and GB. */
export function sizeText(bytes) {
  for (const [unitName, unitSize] of SIZE_UNITS) {
    if (bytes >= unitSize) return `${(bytes / unitSize).toFixed(1)} ${unitName}`;
  }
  return `${bytes} bytes`;
}

/** Return the title and the detail line for one row of the runs list. */
export function rowText(summary, nowMs) {
  const days = daysLeft(summary.createdAt, nowMs);
  const savedAt = new Date(summary.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  return {
    title: KIND_LABELS[summary.kind] ?? "Run",
    meta: `Saved ${savedAt} · ${sizeText(summary.size)} · kept ${days} more ${days === 1 ? "day" : "days"}`,
  };
}
