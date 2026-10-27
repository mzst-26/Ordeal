// The browser id: a random id that this browser keeps in its own storage. Each save sends it, so the server can count
// what one browser has saved against its cap, and only that browser can delete its own runs. It is not a login, and
// a visitor who clears their storage gets a new id. If the storage cannot be used, the id is kept in memory for this
// page only, so the page still works.

// The key the id is kept under in this browser's storage.
const STORAGE_KEY = "ordeal.browserId";
// The same shape as the run ids the server makes: a lower-case UUID. A saved value of any other shape is replaced.
const BROWSER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The id for this page, used when the browser's storage cannot be read or written.
let pageId = null;

/** Return true when the value has the shape of a browser id. */
export function isBrowserId(value) {
  return typeof value === "string" && BROWSER_ID_PATTERN.test(value);
}

/** Make a new id with the browser's own random generator. */
function newBrowserId() {
  return globalThis.crypto.randomUUID();
}

/** Read the saved id, or return null when there is none, it is not valid, or storage cannot be read. */
function savedBrowserId() {
  try {
    const saved = globalThis.localStorage.getItem(STORAGE_KEY);
    return isBrowserId(saved) ? saved : null;
  } catch {
    return null;
  }
}

/** Save the id, and return true when it was written. Storage can refuse, for example in a private window. */
function saveBrowserId(id) {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return this browser's id. The saved id is used when there is one. Otherwise a new one is made and saved. If the
 * storage refuses the save, the same id is kept for this page only.
 */
export function getBrowserId() {
  const saved = savedBrowserId();
  if (saved !== null) return saved;
  if (pageId === null) pageId = newBrowserId();
  saveBrowserId(pageId);
  return pageId;
}
