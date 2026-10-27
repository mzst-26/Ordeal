// The visitor id of this browser. Each browser makes one random id on its first visit and keeps it in localStorage,
// so every save, list and delete from this browser carries the same id. The server only shows a visitor the runs
// that were saved under their id, so the id is what keeps one browser's runs apart from another's.
// If storage is blocked, the id moves to sessionStorage, and if that is blocked too, it lasts for this page only.

import { checkVisitorId } from "./visitor-rules.js";

// The key the id is saved under. It is the only thing this file writes to storage.
export const VISITOR_KEY = "ordeal-visitor-id";

// 16 random bytes are 128 random bits. Written as hex, they make a 32 character id, the shortest the server accepts.
const ID_BYTES = 16;

// The id is kept for the whole page, so a second call never makes a second id. Null until the first call.
let pageId = null;

/**
 * Make a new random visitor id. The bytes come from the browser's random source, never from Math.random, which is
 * not safe for ids. The random source is passed in, so a test can give a fixed one.
 */
export function newVisitorId(randomSource = globalThis.crypto) {
  const bytes = new Uint8Array(ID_BYTES);
  randomSource.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Return the saved id from the first storage that works, or make and save a new one. A storage that throws is
 * skipped, because some privacy modes block storage. A saved value that fails the id check is replaced. If every
 * storage is blocked, a new id is returned without being saved.
 */
export function readOrCreateVisitorId(storages, makeId) {
  for (const storage of storages) {
    try {
      const saved = storage.getItem(VISITOR_KEY);
      if (checkVisitorId(saved).ok) return saved;
      const fresh = makeId();
      storage.setItem(VISITOR_KEY, fresh);
      return fresh;
    } catch {
      // This storage is blocked or full, so the next one is tried.
    }
  }
  return makeId();
}

/** Return the browser storages in the order they are tried. Reading one can itself throw, so each read is guarded. */
function browserStorages() {
  const storages = [];
  for (const name of ["localStorage", "sessionStorage"]) {
    try {
      const storage = globalThis[name];
      if (storage) storages.push(storage);
    } catch {
      // Reading the property threw, which means this storage is blocked, so it is left out.
    }
  }
  return storages;
}

/**
 * Return the visitor id for this page. The first call reads or makes it, and every later call returns the same one,
 * so the id never changes while the page is open.
 */
export function pageVisitorId() {
  if (pageId === null) {
    pageId = readOrCreateVisitorId(browserStorages(), () => newVisitorId());
  }
  return pageId;
}
