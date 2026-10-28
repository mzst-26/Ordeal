// The levels drawer on the Gauntlet view: a collapsible panel docked beside the header sidebar from 1024px.
// The pure helpers take their inputs as arguments, so they can be tested without a browser. The wiring at the
// bottom only runs in the page: it sets data-levels-drawer on <html>, sets the toggle button's state and saves
// the choice. The CSS decides where the drawer shows, because the drawer sits inside the Gauntlet section, which
// the router hides on the other views, so no hash listening is needed.

// localStorage key that remembers whether the levels drawer is open.
export const DRAWER_STORAGE_KEY = "ordeal-levels-drawer";

/** Read the saved choice. Defaults to open (true) when nothing is saved or storage is missing or blocked. */
export function readStoredDrawer(storage) {
  try {
    return storage?.getItem(DRAWER_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

/** Save the choice. Storage can be blocked, so a failure is ignored; the drawer still changes for this visit. */
export function writeStoredDrawer(storage, open) {
  try {
    storage.setItem(DRAWER_STORAGE_KEY, open ? "true" : "false");
  } catch {
    // Not saved: the drawer keeps its state for this visit only.
  }
}

/** Find the drawer in the page, apply the saved state, and wire the toggle button. Does nothing if markup is missing. */
function setupDrawer(doc, win) {
  const drawer = doc.querySelector(".levels-drawer");
  const toggle = drawer?.querySelector(".levels-drawer-toggle");
  const body = drawer?.querySelector("#levels-drawer-body");
  if (!drawer || !toggle || !body) {
    return;
  }

  let storage = null;
  try {
    storage = win.localStorage;
  } catch {
    storage = null;
  }

  function apply(open) {
    doc.documentElement.dataset.levelsDrawer = open ? "open" : "closed";
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    body.hidden = !open;
  }

  apply(readStoredDrawer(storage));

  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    apply(open);
    writeStoredDrawer(storage, open);
  });
}

// Start in the page only. In Node (the tests) there is no document, so nothing runs.
if (typeof document !== "undefined" && typeof window !== "undefined") {
  setupDrawer(document, window);
}
