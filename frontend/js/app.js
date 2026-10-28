// The entry point and router. One document holds three views (Gauntlet, Batch, Live). The router shows one
// at a time, mounts each view's page module the first time it is shown, and keeps the address and the
// browser history in step with the view on screen. Moving between views does not reload the page.

// The view names, also used as the URL hash and as the data-view values in the page.
export const VIEWS = ["gauntlet", "batch", "live"];
const DEFAULT_VIEW = "gauntlet";
// The document title shown for each view.
const TITLES = {
  gauntlet: "Ordeal: Gauntlet",
  batch: "Ordeal: Batch",
  live: "Ordeal: Live",
};

/**
 * Work out which view a visit asks for, and return "gauntlet", "batch" or "live".
 * A known hash wins, because the header writes the hash when the visitor moves between views. Otherwise a
 * known path (/batch, /live, which Netlify serves from index.html) is used. Anything else opens Gauntlet.
 */
export function routeFromLocation(hash, pathname) {
  const fromHash = VIEWS.find((view) => hash === `#${view}`);
  if (fromHash) {
    return fromHash;
  }
  const fromPath = VIEWS.find((view) => pathname === `/${view}` || pathname === `/${view}/`);
  return fromPath ?? DEFAULT_VIEW;
}

/**
 * Close every dialog that is open inside a view that is about to be hidden. A modal dialog keeps the rest of the page
 * inert while it is open. If the view went hidden with the dialog still open (for example after Back or Forward),
 * the page could stay blocked until a reload, so the router closes it first.
 */
function closeOpenDialogs(view) {
  for (const dialog of view.querySelectorAll("dialog[open]")) {
    dialog.close();
  }
}

/**
 * Create the router. `views` maps each view name to its <section>. `mounts` maps each view name to a function
 * that sets the page up; it is called with the section once, the first time that view is shown, and never
 * again, so the page keeps its state while the visitor is on other views. Returns the router's functions:
 * start() shows the view for the current location, show(view) displays a view without touching the history,
 * navigate(view) displays a view and adds a history entry, and current() returns the view on screen.
 */
export function createRouter({ views, mounts, document, window }) {
  const mounted = new Set();
  let currentView = null;

  /** Map any name that is not a view to the default view, so a bad name never leaves the page blank. */
  function known(view) {
    return VIEWS.includes(view) ? view : DEFAULT_VIEW;
  }

  /** Show one view: hide the other sections, mark its nav link, set the title, and mount it if it is new. */
  function show(view) {
    const target = known(view);
    for (const name of VIEWS) {
      if (name !== target) {
        closeOpenDialogs(views[name]);
      }
      views[name].hidden = name !== target;
    }
    for (const link of document.querySelectorAll("[data-nav-view]")) {
      if (link.dataset.navView === target) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    }
    document.title = TITLES[target];
    currentView = target;
    if (!mounted.has(target)) {
      mounted.add(target);
      mounts[target](views[target]);
    }
  }

  /** Show a view from a click. A new history entry is added, so Back returns to the view before. */
  function navigate(view) {
    const target = known(view);
    if (target === currentView) {
      return;
    }
    show(target);
    window.history.pushState(null, "", `#${target}`);
  }

  /** Show the view for the current location. The first entry is replaced, not added, so Back leaves the site. */
  function start() {
    const view = routeFromLocation(window.location.hash, window.location.pathname);
    show(view);
    window.history.replaceState(null, "", `#${view}`);
    // Back and forward change only the hash, so the view is shown again from the new location.
    window.addEventListener("popstate", () => {
      show(routeFromLocation(window.location.hash, window.location.pathname));
    });
  }

  /** Return the name of the view on screen. */
  function current() {
    return currentView;
  }

  return { start, show, navigate, current };
}

/**
 * Build the router, then show the view for the current location. The entry module (main.jsx) calls this once in
 * the browser. `renderHeader(navigate)` draws the site header; it is given the router's navigate function, so the
 * header's links show views without a reload. Each page module is loaded by the mount function for its view,
 * which keeps the page's data and state for the life of the document.
 */
export function startApp({ renderHeader }) {
  const views = Object.fromEntries(VIEWS.map((view) => [view, document.querySelector(`[data-view="${view}"]`)]));
  const mounts = {
    gauntlet: (root) => import("./page-gauntlet.js").then((page) => page.mountGauntlet(root)),
    batch: (root) => import("./page-batch.js").then((page) => page.mountBatch(root)),
    live: (root) => import("./page-live.js").then((page) => page.mountLive(root)),
  };
  const router = createRouter({ views, mounts, document, window });
  renderHeader((view) => router.navigate(view));
  router.start();
}
