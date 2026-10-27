// Reads and writes saved runs in Netlify Blobs. Each run is one blob, keyed owner/<visitor id>/<run id>, so every
// visitor's runs sit under their own prefix. The kind, save time and size are kept as blob metadata, so a list can be
// drawn without downloading every run. This file only talks to storage. The rules (who may see what, the caps and
// the expiry) live in run-rules.js, visitor-rules.js and run-retention.js. Every function takes the store as an
// argument, so the handlers can be tested with a fake store.

import { getStore } from "@netlify/blobs";
import { parseOwnerKey, OWNER_ROOT } from "../../site/js/visitor-rules.js";

// The name of the Netlify Blobs store that holds every saved run.
export const STORE_NAME = "web-runs";

/** Open the store. Netlify reads the site's credentials from its own environment, so none are passed here. */
export function openRunStore() {
  return getStore(STORE_NAME);
}

/**
 * Return one entry for every stored run of every visitor: its storage key (as id), its owner (the visitor id), its
 * run id, and its kind, save time and size from the metadata. Keys that are not run keys are skipped, and so is a
 * run that vanishes between the list and the metadata read. The store is read one page at a time.
 */
export async function listEntries(store) {
  const entries = [];
  for await (const page of store.list({ prefix: `${OWNER_ROOT}/`, paginate: true })) {
    for (const blob of page.blobs) {
      const owned = parseOwnerKey(blob.key);
      if (owned === null) continue;
      const found = await store.getMetadata(blob.key);
      if (found === null) continue;
      entries.push({
        id: blob.key,
        owner: owned.visitorId,
        runId: owned.runId,
        kind: found.metadata.kind,
        createdAt: found.metadata.createdAt,
        bytes: found.metadata.bytes,
      });
    }
  }
  return entries;
}

/** Save a stored record under its key, with its kind, creation time and size kept as metadata. */
export async function writeRecord(store, key, record, bytes) {
  const metadata = { kind: record.kind, createdAt: record.createdAt, bytes };
  await store.setJSON(key, record, { metadata });
}

/** Return the stored record for one key, or null when there is none. */
export async function readRecord(store, key) {
  const found = await store.getWithMetadata(key, { type: "json" });
  return found === null ? null : found.data;
}

/** Delete one stored run by its key. Deleting a key that is not there does nothing. */
export async function removeKey(store, key) {
  await store.delete(key);
}
