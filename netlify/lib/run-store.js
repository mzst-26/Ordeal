// Reads and writes saved runs in Netlify Blobs. Each run is one blob, keyed by "run-" and its id. The size, kind
// and save time are kept as blob metadata, so a list can be drawn without downloading every run. This file only
// talks to storage; the rules (what may be saved, how long it is kept) live in run-rules.js and run-retention.js.

import { getStore } from "@netlify/blobs";
import { summaryOf } from "./run-rules.js";

// The name of the Netlify Blobs store that holds every saved run.
export const STORE_NAME = "web-runs";
// Every run key starts with this prefix, so a list can ask for runs only.
const KEY_PREFIX = "run-";

/** Open the store. Netlify reads the site's credentials from its own environment, so none are passed here. */
export function openRunStore() {
  return getStore(STORE_NAME);
}

/** Return the storage key for a run id. */
function keyFor(id) {
  return KEY_PREFIX + id;
}

/**
 * Return the summary of every stored run, read from metadata only. The store is read one page at a time, so a long
 * list is not loaded in one go. A run that vanishes between the list and the metadata read is skipped.
 */
export async function listSummaries(store) {
  const summaries = [];
  for await (const page of store.list({ prefix: KEY_PREFIX, paginate: true })) {
    for (const blob of page.blobs) {
      const entry = await store.getMetadata(blob.key);
      if (entry !== null) {
        summaries.push(summaryOf(blob.key.slice(KEY_PREFIX.length), entry.metadata));
      }
    }
  }
  return summaries;
}

/** Save a stored record, with its kind, creation time and size kept as metadata. */
export async function writeRecord(store, record, bytes) {
  const metadata = { kind: record.kind, createdAt: record.createdAt, bytes };
  await store.setJSON(keyFor(record.id), record, { metadata });
}

/** Return the stored record for one run id, or null when there is none. */
export async function readRecord(store, id) {
  const found = await store.getWithMetadata(keyFor(id), { type: "json" });
  return found === null ? null : found.data;
}

/** Delete one run. Deleting a run that is not there does nothing. */
export async function removeRecord(store, id) {
  await store.delete(keyFor(id));
}
