// The saved-runs API, served at /api/runs. Anyone may read the list or one run. Anyone may save a run, and the browser
// that saves it is named by the X-Browser-Id header. A browser may hold up to 100 MB of runs, and it may delete only
// the runs it saved. A save first makes room under the 1.5 GB store cap by removing the oldest runs. Every rule used
// here is in netlify/lib and site/js/run-retention.js.

import { randomUUID } from "node:crypto";
import { checkNewRun, buildRecord, runIdIsValid, browserIdIsValid, toRetentionRuns } from "../lib/run-rules.js";
import {
  openRunStore,
  listSummaries,
  writeRecord,
  readRecord,
  removeRecord,
} from "../lib/run-store.js";
import { planSizeCleanup, fitsBrowserCap } from "../../site/js/run-retention.js";

// Netlify reads this to route the address /api/runs to this function.
export const config = { path: "/api/runs" };

// The request header that names the browser making a save or delete.
const BROWSER_HEADER = "x-browser-id";

/** Build a JSON response. Responses are never cached, because the list changes with every save and delete. */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Return the run id from the ?id= query value, or null when it is missing. */
function idFromUrl(request) {
  return new URL(request.url).searchParams.get("id");
}

/** Return the browser id from the request header, or null when it is missing or not a valid id. */
function browserIdFrom(request) {
  const id = request.headers.get(BROWSER_HEADER);
  return browserIdIsValid(id) ? id : null;
}

/** Return the 400 response for a save or delete that did not say which browser it is from. */
function noBrowserId() {
  return jsonResponse(400, { error: "The request must name the browser it comes from." });
}

/**
 * Remove the owner from a summary, and say whether the browser asking owns it. The owner's id is never sent back,
 * so one browser cannot read another browser's id from the list.
 */
function shownSummary(summary, viewer) {
  const { owner, ...rest } = summary;
  return { ...rest, mine: viewer !== null && owner === viewer };
}

/** List every run, or return one run when an id is given. Reading needs no password. */
async function handleGet(request) {
  const store = openRunStore();
  const viewer = browserIdFrom(request);
  const id = idFromUrl(request);
  if (id === null) {
    const summaries = await listSummaries(store);
    return jsonResponse(200, { runs: summaries.map((summary) => shownSummary(summary, viewer)) });
  }
  if (!runIdIsValid(id)) {
    return jsonResponse(400, { error: "The run id is not valid." });
  }
  const record = await readRecord(store, id);
  if (record === null) {
    return jsonResponse(404, { error: "No run has that id." });
  }
  return jsonResponse(200, shownSummary(record, viewer));
}

/**
 * Save a run for the browser that sent it. The run keeps the id the browser gave it, so saving the same run again
 * replaces its copy instead of adding one. A run saved again keeps the time of its first save, and the browser may
 * not replace a run that another browser saved. The browser's runs are capped at 100 MB, and a save over that is
 * refused with nothing removed. The whole store is capped at 1.5 GB: when a save would go over, the oldest runs are
 * removed first. A run too big for the whole store is refused with 413, and nothing is removed for it.
 */
async function handlePost(request) {
  const owner = browserIdFrom(request);
  if (owner === null) return noBrowserId();
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "The body must be JSON." });
  }
  const check = checkNewRun(body);
  if (!check.ok) return jsonResponse(400, { error: check.error });

  const store = openRunStore();
  const existing = await readRecord(store, body.id);
  if (existing !== null && existing.owner !== owner) {
    return jsonResponse(403, { error: "That run was saved from another browser." });
  }
  const createdAt = existing === null ? Date.now() : existing.createdAt;
  const record = buildRecord(body, createdAt, owner);
  const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
  // The run being replaced is left out of the totals, because its old copy is about to go.
  const others = toRetentionRuns(await listSummaries(store)).filter((run) => run.id !== body.id);
  if (!fitsBrowserCap(others, owner, bytes)) {
    return jsonResponse(413, { error: "This browser has used its 100 MB. Delete one of its runs to make room." });
  }
  const plan = planSizeCleanup(others, bytes);
  if (!plan.fits) {
    return jsonResponse(413, { error: "This run is too large for the 1.5 GB store." });
  }
  for (const oldId of plan.removeIds) {
    await removeRecord(store, oldId);
  }
  await writeRecord(store, record, bytes);
  const status = existing === null ? 201 : 200;
  return jsonResponse(status, { id: body.id, kind: record.kind, createdAt: record.createdAt, size: bytes });
}

/** Delete one run. Only the browser that saved it may delete it. */
async function handleDelete(request) {
  const owner = browserIdFrom(request);
  if (owner === null) return noBrowserId();
  const id = idFromUrl(request);
  if (!runIdIsValid(id)) {
    return jsonResponse(400, { error: "The run id is not valid." });
  }
  const store = openRunStore();
  const record = await readRecord(store, id);
  if (record === null) {
    return jsonResponse(404, { error: "No run has that id." });
  }
  if (record.owner !== owner) {
    return jsonResponse(403, { error: "You can only delete runs saved from this browser." });
  }
  await removeRecord(store, id);
  return jsonResponse(200, { deleted: id });
}

/** Send each HTTP method to its handler. Any other method is refused. */
export default async function handler(request) {
  if (request.method === "GET") return handleGet(request);
  if (request.method === "POST") return handlePost(request);
  if (request.method === "DELETE") return handleDelete(request);
  return jsonResponse(405, { error: "Use GET, POST or DELETE." });
}
