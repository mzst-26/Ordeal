// The saved-runs API, served at /api/runs. GET lists the runs (or returns one when ?id= is given). Anyone may read.
// POST saves a run and DELETE removes one; both need the write password in the Authorization header. A save first
// makes room under the 1.5 GB cap by removing the oldest runs. Every rule used here is in netlify/lib.

import { randomUUID } from "node:crypto";
import { passwordMatches } from "../lib/write-password.js";
import { checkNewRun, buildRecord, runIdIsValid, toRetentionRuns } from "../lib/run-rules.js";
import {
  openRunStore,
  listSummaries,
  writeRecord,
  readRecord,
  removeRecord,
} from "../lib/run-store.js";
import { planSizeCleanup } from "../../site/js/run-retention.js";

// Netlify reads this to route the address /api/runs to this function.
export const config = { path: "/api/runs" };

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

/** Return the 401 response for a request without the right write password. It does not say which part was wrong. */
function unauthorised() {
  return jsonResponse(401, { error: "The write password is missing or wrong." });
}

/** Return true when the request carries the write password. An unset WRITE_PASSWORD means no write is allowed. */
function isWriter(request) {
  return passwordMatches(request.headers.get("authorization"), process.env.WRITE_PASSWORD);
}

/** List every run, or return one run when an id is given. Reading needs no password. */
async function handleGet(request) {
  const store = openRunStore();
  const id = idFromUrl(request);
  if (id === null) {
    return jsonResponse(200, { runs: await listSummaries(store) });
  }
  if (!runIdIsValid(id)) {
    return jsonResponse(400, { error: "The run id is not valid." });
  }
  const record = await readRecord(store, id);
  return record === null
    ? jsonResponse(404, { error: "No run has that id." })
    : jsonResponse(200, record);
}

/**
 * Save a run. The size is measured on the stored record. If the store would go over the cap, the oldest runs are
 * removed first. A run too big for the whole cap is refused with 413, and nothing is removed for it.
 */
async function handlePost(request) {
  if (!isWriter(request)) return unauthorised();
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "The body must be JSON." });
  }
  const check = checkNewRun(body);
  if (!check.ok) return jsonResponse(400, { error: check.error });

  const id = randomUUID();
  const record = buildRecord(id, body, Date.now());
  const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
  const store = openRunStore();
  const plan = planSizeCleanup(toRetentionRuns(await listSummaries(store)), bytes);
  if (!plan.fits) {
    return jsonResponse(413, { error: "This run is too large for the 1.5 GB store." });
  }
  for (const oldId of plan.removeIds) {
    await removeRecord(store, oldId);
  }
  await writeRecord(store, record, bytes);
  return jsonResponse(201, { id, kind: record.kind, createdAt: record.createdAt, size: bytes });
}

/** Delete one run. It needs the write password and a valid id. */
async function handleDelete(request) {
  if (!isWriter(request)) return unauthorised();
  const id = idFromUrl(request);
  if (!runIdIsValid(id)) {
    return jsonResponse(400, { error: "The run id is not valid." });
  }
  await removeRecord(openRunStore(), id);
  return jsonResponse(200, { deleted: id });
}

/** Send each HTTP method to its handler. Any other method is refused. */
export default async function handler(request) {
  if (request.method === "GET") return handleGet(request);
  if (request.method === "POST") return handlePost(request);
  if (request.method === "DELETE") return handleDelete(request);
  return jsonResponse(405, { error: "Use GET, POST or DELETE." });
}
