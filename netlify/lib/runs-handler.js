// The request handling for saved web runs. It is written as factory functions that take the store, the clock and the
// id maker as arguments. The Netlify functions pass in the real Netlify Blobs store; the tests pass a fake store.
// That way every rule here (who may see what, which caps apply, what a refusal says) runs without Netlify.
//
// Two handlers live here. The visitor handler serves /api/runs: each visitor lists, saves, reads and deletes only
// their own runs. The admin handler serves /api/runs-admin: it prunes expired runs or clears the whole store, and
// needs the admin password.

import { randomUUID } from "node:crypto";
import { passwordMatches } from "./write-password.js";
import { checkNewRun, buildRecord, runIdIsValid, summaryOf } from "./run-rules.js";
import { checkVisitorId, runKeyFor, ownedBy } from "../../site/js/visitor-rules.js";
import { planVisitorSave, expiredRunIds, VISITOR_MAX_BYTES, MAX_STORE_BYTES } from "../../site/js/run-retention.js";
import { listEntries, writeRecord, readRecord, removeKey } from "./run-store.js";

// The header each browser uses to send its visitor id with every request.
export const VISITOR_HEADER = "x-visitor-id";

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

/** Return the words sent back when a save is refused for a cap. Each reason gets its own plain sentence. */
function refusalText(reason) {
  if (reason === "visitor") {
    return "This run is bigger than the 200 MB your browser may hold, so it was not saved.";
  }
  return "The shared store is full. Removing your own runs cannot make enough room, so this run was not saved.";
}

/**
 * Return this visitor's runs as list summaries, newest first. The summaries carry the run id, kind, save time and
 * size, and never the run itself.
 */
async function handleList(store, visitorId) {
  const mine = ownedBy(await listEntries(store), visitorId);
  const summaries = mine
    .map((entry) => summaryOf(entry.runId, { kind: entry.kind, createdAt: entry.createdAt, bytes: entry.bytes }))
    .sort((a, b) => b.createdAt - a.createdAt);
  return jsonResponse(200, { runs: summaries });
}

/** Return one of this visitor's runs with its full record. A run under another visitor's id is simply not found. */
async function handleGetOne(store, visitorId, runId) {
  if (!runIdIsValid(runId)) {
    return jsonResponse(400, { error: "The run id is not valid." });
  }
  const record = await readRecord(store, runKeyFor(visitorId, runId));
  return record === null ? jsonResponse(404, { error: "No run has that id." }) : jsonResponse(200, record);
}

/**
 * Save one run for this visitor. The size is measured on the stored record. If the visitor's own oldest runs can
 * make room under both caps, they are removed first. Otherwise the save is refused and nothing is removed.
 */
async function handleSave(store, visitorId, request, deps) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "The body must be JSON." });
  }
  const check = checkNewRun(body);
  if (!check.ok) return jsonResponse(400, { error: check.error });

  const runId = deps.newId();
  const createdAt = deps.now();
  const record = buildRecord(runId, body, createdAt);
  const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
  const entries = await listEntries(store);
  const plan = planVisitorSave({
    visitorRuns: ownedBy(entries, visitorId),
    storeRuns: entries,
    incomingBytes: bytes,
    visitorMax: deps.limits.visitorMax,
    storeMax: deps.limits.storeMax,
  });
  if (!plan.fits) {
    return jsonResponse(413, { error: refusalText(plan.reason) });
  }
  for (const key of plan.removeIds) {
    await removeKey(store, key);
  }
  await writeRecord(store, runKeyFor(visitorId, runId), record, bytes);
  return jsonResponse(201, summaryOf(runId, { kind: record.kind, createdAt, bytes }));
}

/** Delete one of this visitor's runs. Deleting an id that is not theirs removes nothing. */
async function handleDelete(store, visitorId, runId) {
  if (!runIdIsValid(runId)) {
    return jsonResponse(400, { error: "The run id is not valid." });
  }
  await removeKey(store, runKeyFor(visitorId, runId));
  return jsonResponse(200, { deleted: runId });
}

/**
 * Remove every expired run, from every visitor. The daily job and the admin prune both call this. The clock is read
 * once by the caller, so every run is judged at the same moment. Returns how many runs were removed.
 */
export async function pruneExpired(store, nowMs) {
  const expired = expiredRunIds(await listEntries(store), nowMs);
  for (const key of expired) {
    await removeKey(store, key);
  }
  return expired.length;
}

/** Remove every run of every visitor. Only the admin clear uses this. Returns how many runs were removed. */
async function clearAll(store) {
  const entries = await listEntries(store);
  for (const entry of entries) {
    await removeKey(store, entry.id);
  }
  return entries.length;
}

/**
 * Build the handler for /api/runs. Every request needs a valid visitor id in the x-visitor-id header, checked before
 * the store is opened. GET lists this visitor's runs, or reads one with ?id=. POST saves a run. DELETE removes one.
 *
 * deps: openStore (returns the store), now (returns milliseconds), newId (returns a run id), and limits
 * (visitorMax and storeMax in bytes). The caps default to the 200 MB and 1.5 GB of the site.
 */
export function createRunsHandler({
  openStore,
  now = Date.now,
  newId = randomUUID,
  limits = { visitorMax: VISITOR_MAX_BYTES, storeMax: MAX_STORE_BYTES },
}) {
  return async function handler(request) {
    const methods = ["GET", "POST", "DELETE"];
    if (!methods.includes(request.method)) {
      return jsonResponse(405, { error: "Use GET, POST or DELETE." });
    }
    const visitorId = request.headers.get(VISITOR_HEADER);
    const check = checkVisitorId(visitorId);
    if (!check.ok) return jsonResponse(400, { error: check.error });

    const store = openStore();
    if (request.method === "POST") {
      return handleSave(store, visitorId, request, { now, newId, limits });
    }
    const id = idFromUrl(request);
    if (request.method === "DELETE") {
      return handleDelete(store, visitorId, id);
    }
    return id === null ? handleList(store, visitorId) : handleGetOne(store, visitorId, id);
  };
}

/**
 * Build the handler for /api/runs-admin. It takes a POST with a JSON body {"action": "prune"} or {"action": "clear"}
 * and the admin password as a Bearer header. The password is read through getPassword, so an unset password means
 * every admin call is refused.
 */
export function createAdminHandler({ openStore, now = Date.now, getPassword = () => process.env.WRITE_PASSWORD }) {
  return async function handler(request) {
    if (request.method !== "POST") {
      return jsonResponse(405, { error: "Use POST." });
    }
    if (!passwordMatches(request.headers.get("authorization"), getPassword())) {
      return jsonResponse(401, { error: "The admin password is missing or wrong." });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: "The body must be JSON." });
    }
    const store = openStore();
    if (body !== null && body.action === "prune") {
      return jsonResponse(200, { removed: await pruneExpired(store, now()) });
    }
    if (body !== null && body.action === "clear") {
      return jsonResponse(200, { removed: await clearAll(store) });
    }
    return jsonResponse(400, { error: "The action must be prune or clear." });
  };
}
