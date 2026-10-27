// Browser side of the web runs. It calls the /api/runs server function with this browser's visitor id in a header, so
// the server shows and changes only this visitor's runs. It also writes the text shown in each row of the runs page.
// The calls take a fetch function as an argument, so a test can pass a fake one. No password is used here.

import { RETENTION_DAYS, DAY_MS } from "./run-retention.js";

/** The note the runs page shows. It gives the 7-day, 200 MB, 1.5 GB and delete rules in plain words. */
export const RUNS_NOTE_TEXT = "Your runs are kept for 7 days. You can hold up to 200 MB. The shared store holds up to 1.5 GB "
  + "in total; when it is full, the oldest runs are removed first. You can delete a run at any time.";

// The header that carries the visitor id. The server reads the same name.
export const VISITOR_HEADER = "x-visitor-id";

const API_PATH = "/api/runs";
const KIND_LABELS = Object.freeze({ batch: "Batch run", gauntlet: "Gauntlet run" });
const SIZE_UNITS = Object.freeze([
  ["GB", 1024 * 1024 * 1024],
  ["MB", 1024 * 1024],
  ["KB", 1024],
]);
const LIST_ERROR_TEXT = "The runs could not be loaded from the server.";
const READ_ERROR_TEXT = "That run could not be read from the server.";
const SAVE_ERROR_TEXT = "This run could not be saved to the server.";
const DELETE_ERROR_TEXT = "The run could not be deleted.";

/** Call the browser's fetch. Passed as a function, so a test can replace it without touching the global. */
function defaultFetch(url, init) {
  return globalThis.fetch(url, init);
}

/** Return the headers every call sends: the visitor id, so the server knows whose runs to use. */
function visitorHeaders(visitorId) {
  return { [VISITOR_HEADER]: visitorId };
}

/** Return the address of the runs list, or of one run when an id is given. */
export function runsUrl(id) {
  return id === undefined ? API_PATH : `${API_PATH}?id=${encodeURIComponent(id)}`;
}

/** Read the list of this visitor's runs from the server and return the summaries. */
export async function fetchRunList(visitorId, fetchFn = defaultFetch) {
  const response = await fetchFn(runsUrl(), { headers: visitorHeaders(visitorId) });
  if (!response.ok) throw new Error(LIST_ERROR_TEXT);
  const body = await response.json();
  return body.runs;
}

/** Read one of this visitor's runs, with its full record, from the server. */
export async function fetchRunRecord(visitorId, id, fetchFn = defaultFetch) {
  const response = await fetchFn(runsUrl(id), { headers: visitorHeaders(visitorId) });
  if (!response.ok) throw new Error(READ_ERROR_TEXT);
  return response.json();
}

/**
 * Read the sentence the server sent with a refusal, if there is one. A reply that is not JSON gives null, so the
 * caller falls back to its own plain sentence.
 */
async function serverMessage(response) {
  try {
    const body = await response.json();
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * Save a run to the server under this visitor. The kind is "batch" or "gauntlet". A batch sends its summary; a
 * gauntlet sends the whole run. Returns the summary the server made. A refusal throws the server's own sentence,
 * such as the one for a full store, so the visitor sees why the save did not happen.
 */
export async function saveRun(visitorId, kind, run, fetchFn = defaultFetch) {
  const response = await fetchFn(runsUrl(), {
    method: "POST",
    headers: { ...visitorHeaders(visitorId), "content-type": "application/json" },
    body: JSON.stringify({ kind, run }),
  });
  if (!response.ok) throw new Error((await serverMessage(response)) ?? SAVE_ERROR_TEXT);
  return response.json();
}

/** Delete one of this visitor's runs on the server. A run that is not theirs is simply not removed. */
export async function deleteRun(visitorId, id, fetchFn = defaultFetch) {
  const response = await fetchFn(runsUrl(id), { method: "DELETE", headers: visitorHeaders(visitorId) });
  if (!response.ok) throw new Error(DELETE_ERROR_TEXT);
  return true;
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
