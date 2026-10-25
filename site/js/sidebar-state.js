// The collapsed or expanded state of the wide-screen sidebar, and how it is remembered between visits.
// The functions take the storage as an argument, so they can be tested without a browser.

// localStorage key that remembers whether the sidebar was collapsed.
export const SIDEBAR_STORAGE_KEY = "ordeal-sidebar-collapsed";

/** Return the state after the given one: a collapsed sidebar opens, an open one collapses. */
export function nextSidebarState(collapsed) {
  return !collapsed;
}

/** Read the saved choice. Defaults to expanded (false) when nothing is saved or storage is missing or blocked. */
export function readStoredSidebar(storage) {
  try {
    return storage?.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Save the choice. Storage can be blocked, so a failure is ignored; the sidebar still changes for this visit. */
export function writeStoredSidebar(storage, collapsed) {
  try {
    storage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "true" : "false");
  } catch {
    // Not saved: the state in the header still holds the choice for this visit.
  }
}
