// Browser side of the web runs. It calls the /api/runs server functions, decides which gauntlet runs get a copy kept
// in the browser, and writes the text shown in each row of the runs page. The calls take a fetch function as an
// argument, so a test can pass a fake one. Each call names this browser by its browser id, in a header.

import { listRuns, keepRunCopy } from "./store/run-store.js";
import { RETENTION_HOURS, HOUR_MS } from "./run-retention.js";

/** The note the runs page shows, so the visitor knows the 24-hour, 100 MB and delete rules. */
export const RUNS_NOTE_TEXT = `Runs are kept for ${RETENTION_HOURS} hours. Each browser can keep up to 100 MB, and you can `
  + "delete only the runs saved from this browser. The store holds up to 1.5 GB; the oldest runs are removed first "
  + "when it is full.";

const API_PATH = "/api/runs";
// The request header that names this browser. The server uses it to count and to check the owner of each run.
const BROWSER_HEADER = "x-browser-id";
const KIND_LABELS = Object.freeze({ batch: "Batch run", gauntlet: "Gauntlet run" });
const SIZE_UNITS = Object.freeze([
  ["GB", 1024 * 1024 * 1024],
  ["MB", 1024 * 1024],
  ["KB", 1024],
]);
const LIST_ERROR_TEXT = "The runs could not be loaded from the server.";
const READ_ERROR_TEXT = "That run could not be read from the server.";
const NOT_OWN_TEXT = "You can only delete runs saved from this browser.";
const GONE_TEXT = "That run is no longer stored.";
const DELETE_ERROR_TEXT = "The run could not be deleted.";
const SAVE_ERROR_TEXT = "The run could not be saved.";

/** Call the browser's fetch. Passed as a function, so a test can replace it without touching the global. */
function defaultFetch(url, init) {
  return globalThis.fetch(url, init);
}

/** Return the address of the runs list, or of one run when an id is given. */
export function runsUrl(id) {
  return id === undefined ? API_PATH : `${API_PATH}?id=${encodeURIComponent(id)}`;
}

/** Read the list of runs from the server and return the summaries. Reading needs no browser id. */
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
 * Save a run on the server for this browser. The kind and the run go in the body, and the browser id goes in the
 * header. A refusal (for example, the browser is over its 100 MB) comes back with the server's plain message.
 */
export async function saveRunOnServer(kind, run, browserId, fetchFn = defaultFetch) {
  const response = await fetchFn(runsUrl(), {
    method: "POST",
    headers: { "content-type": "application/json", [BROWSER_HEADER]: browserId },
    body: JSON.stringify({ kind, run }),
  });
  if (response.status === 201) return response.json();
  const body = await response.json().catch(() => ({}));
  throw new Error(body.error ?? SAVE_ERROR_TEXT);
}

/**
 * Delete one run on the server. The browser id goes in the header, and the server allows the delete only when this
 * browser saved the run. A 403 gets its own message, and so does a run that is already gone.
 */
export async function deleteRun(id, browserId, fetchFn = defaultFetch) {
  const response = await fetchFn(runsUrl(id), {
    method: "DELETE",
    headers: { [BROWSER_HEADER]: browserId },
  });
  if (response.status === 403) throw new Error(NOT_OWN_TEXT);
  if (response.status === 404) throw new Error(GONE_TEXT);
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
 * Return how many whole hours a run has left before the 24-hour limit, never below 0. A run saved just now has 24
 * hours left; a run 24 hours old has none. Rounding up means a run with part of an hour left still shows that hour.
 */
export function hoursLeft(createdAtMs, nowMs) {
  const endsAt = createdAtMs + RETENTION_HOURS * HOUR_MS;
  return Math.max(0, Math.ceil((endsAt - nowMs) / HOUR_MS));
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
  const hours = hoursLeft(summary.createdAt, nowMs);
  const savedAt = new Date(summary.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  return {
    title: KIND_LABELS[summary.kind] ?? "Run",
    meta: `Saved ${savedAt} · ${sizeText(summary.size)} · kept ${hours} more ${hours === 1 ? "hour" : "hours"}`,
  };
}
