# Single-page navigation Implementation Plan

> **For agentic workers:** Execute task-by-task with subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Moving between Gauntlet, Batch and Live no longer reloads the page. The API key, the chosen settings, the running or finished results and the fetched data stay in memory across tab changes.

**Architecture:** One document, `site/index.html`, holds three view sections. A small router (`site/js/app.js`) shows one view at a time, using the hash (`#gauntlet`, `#batch`, `#live`) or the path (`/batch`, `/live`). Each page module mounts once, the first time its view opens, and then keeps its state. All lookups are scoped to the view's root element, so the three views can share one document. `batch.html` and `live.html` become small redirect pages for old links.

**Tech Stack:** Plain HTML, CSS and ES modules, no build step. `node --test` for engine and router tests. Headless browser check for the navigation behaviour.

**Spec:** This plan. The user asked: "Ensure when moving pages data refetches and wont loose the data every time changing tabs."

## Global Constraints

- The key is still held only in the vault (`site/js/engine/token.js`). Do not write it to any storage, URL, or the DOM. Keeping it in memory across tab changes is allowed. A full page reload still clears it, and the page says so.
- No inline script, no `style=` attribute, no `innerHTML`, no `on*` attributes. Text with `textContent`. Pages must keep the CSP in `netlify.toml` unchanged.
- Each of the three views keeps its own stylesheet rules. Load all three stylesheets in `index.html`. Check the rules do not collide (see Task 1).
- Experiment codes and engine outputs do not change. `npm test` and the Python tests must still pass, and `python scripts/check_contrast.py` and `python scripts/check_no_secrets.py` must pass.
- Readability first: every exported JavaScript function has a doc comment. Comments explain why. No line over 120 characters.
- Python interpreter: `/Users/mobinzaki/Github/Hacktest/.venv-spine/bin/python`. `python` is not on PATH.

## Decisions

- **D1. One document.** The three page HTML bodies move into `site/index.html` as `<section data-view="gauntlet|batch|live" hidden>`. The first view shown on load is chosen from the hash or path, default `gauntlet`.
- **D2. Unique IDs.** The IDs that clash between pages (`start-button`, `stop-button`, `model-list`, `condition-select`, `preset-panel`, `footer-text`, and any others found by a duplicate check) get a view prefix: `gauntlet-`, `batch-`, `live-`. Task 1 writes the full old-to-new ID table into `site/js/view-ids.js`, and the page tasks use it.
- **D3. Mount once.** A page's `mount(root)` runs the first time its view is opened, then the module keeps its state. Switching views only toggles `hidden` and the nav `aria-current`.
- **D4. Live and running work continue** while a view is hidden. Timers keep going. The page shows the state when the user comes back. Nothing is paused on a tab change.
- **D5. Routing.** Hash wins over path. `/batch` and `/live` are served by `index.html` through `_redirects`. Old `batch.html` and `live.html` contain a `<meta http-equiv="refresh">` to `/#batch` and `/#live`. No inline script is used.
- **D6. Data fetched once.** A small `site/js/data-cache.js` keeps each `/data/*.json` request for the life of the document. The three pages use it. The suite cache in `suites.js` stays as it is.
- **D7. Title and history.** `document.title` changes with the view. Each switch uses `history.pushState` (or `replaceState` on the first load). Back and forward work through `popstate`.

## Review Focus

1. Switching tabs does not fetch any `/data/*.json` file again. Covered by the headless check (count requests) and `js-tests/data-cache.test.js`.
2. The API key stays "Key saved" after switching tabs and is cleared by a full reload. Covered by the headless check.
3. Ticked models and questions in Batch, the Gauntlet conversation, and the Live run are still there after switching away and back. Covered by the headless check.
4. Back and forward move between views, and a bad hash (`#nope`) opens Gauntlet. Covered by `js-tests/router.test.js`.
5. Old links (`batch.html`, `live.html`) reach the right view. Covered by the headless check on each file.

---

### Task 1: Single document and router

**Files:**
- Modify: `site/index.html` (merge the three page bodies as sections, rename clashing IDs, load all three stylesheets)
- Create: `site/js/app.js` (router, mounts pages lazily, owns the header through `shell.js`)
- Create: `site/js/view-ids.js` (the old-to-new ID table, a plain object, with a doc comment)
- Modify: `site/js/shell.js` (build the header once; nav items become hash links and call the router)
- Modify: `site/batch.html`, `site/live.html` (become meta-refresh pages)
- Modify: `site/_redirects` (`/batch /index.html 200`, `/live /index.html 200`)
- Test: `js-tests/router.test.js`

**Interfaces:**
- Produces: `routeFromLocation(hash, pathname) -> "gauntlet" | "batch" | "live"` (pure; unknown or empty gives "gauntlet"). `createRouter({ views, mounts, document, window }) -> { show(view), current() }`, where `mounts` maps each view to a `mount(root)` function, called once.
- Produces: `VIEW_IDS` in `view-ids.js`: for each view, a map from old ID to new ID.

- [ ] Write `js-tests/router.test.js` first: `routeFromLocation` for `#batch`, `/live`, `#nope`, empty, and `#batch` beating `/live`. `createRouter` mounts a view once even if shown twice. Run `node --test js-tests/router.test.js` (must fail).
- [ ] Find every duplicate ID across the three pages (`grep` the `id="` attributes), and fill `VIEW_IDS`.
- [ ] Merge the three bodies into `index.html` as sections. Rename the IDs from `VIEW_IDS`. Keep the `<main>`-level structure valid (one `<main>`, the sections inside it). Keep the `load-fallback.js` script.
- [ ] Check the three stylesheets for clashing selectors and report any clash (the first page's rules win otherwise). Do not change the look of a page; if a clash is found, scope the rule to its section and report it.
- [ ] Write `app.js` and the header change in `shell.js`. Make the three `initShell` calls go away: the router owns the header.
- [ ] Turn `batch.html` and `live.html` into the redirect pages (D5). Update `_redirects`.
- [ ] Run `node --test js-tests/router.test.js` and `npm test`. Report the counts.

### Task 2: Gauntlet view mount

**Files:**
- Modify: `site/js/page-gauntlet.js`
- Test: `js-tests/page-gauntlet.test.js` only if a pure helper moves out

**Interfaces:**
- Consumes: `VIEW_IDS.gauntlet` and the root element from the router (Task 1).
- Produces: `export function mountGauntlet(root)`. Every `document.getElementById(...)` and `document.querySelector` in the file uses `root` instead. The module-level page state is created at mount time, not at import time.

- [ ] Replace every document-level lookup with a lookup in `root`. Use the new IDs from `VIEW_IDS.gauntlet`. Remove the call to `initShell`. Keep the behaviour the same.
- [ ] Use `data-cache.js` (Task 3) for the `/data/*.json` reads. If Task 3 is not done yet, leave the fetch in place and say so.
- [ ] `npm test` passes. Report the lines changed.

### Task 3: Shared data cache

**Files:**
- Create: `site/js/data-cache.js`
- Test: `js-tests/data-cache.test.js`

**Interfaces:**
- Produces: `createDataCache(fetchFn = fetch) -> { loadJson(path) }`. The first call for a path fetches it. Later calls return the same promise. A failed fetch is removed from the cache so a retry can happen. A module-level `loadJson` uses one shared cache for the whole document.

- [ ] Write the test first (a fake `fetchFn` counts calls: two loads of one path make one call; a failed load is retried on the next call).
- [ ] Implement it and run `node --test js-tests/data-cache.test.js`.

### Task 4: Batch view mount

**Files:**
- Modify: `site/js/page-batch.js`

**Interfaces:**
- Produces: `export function mountBatch(root)`. All lookups go through `root` with the `VIEW_IDS.batch` IDs (the `IDS` object in the file maps names to IDs; change it to use the view's IDs). Remove `initShell`. Use `data-cache.js` for the data reads.

- [ ] Same steps as Task 2, for `page-batch.js`. Keep the ticked models, questions and families when the view is hidden (they live in the module state, and nothing resets them on hide).
- [ ] `npm test` passes. Report the lines changed.

### Task 5: Live view mount

**Files:**
- Modify: `site/js/page-live.js`

**Interfaces:**
- Produces: `export function mountLive(root)`. Same rules as Task 4 for `VIEW_IDS.live`. The replay and live timers keep running while the view is hidden.

- [ ] Same steps as Task 2, for `page-live.js`. Check that the module-level `dom` object is filled at mount time and not at import time.
- [ ] `npm test` passes. Report the lines changed.

### Task 6: Verification

- [ ] Headless browser check (use the browser tools available: the claude-in-chrome set, loaded with ToolSearch, or playwright if installed). Serve `site/` with `python -m http.server` from a port that is free. Check:
  1. Open `/`. Tick two models on Batch, paste a key in the Key dialog (use a fake value that the dialog accepts, e.g. the same format as in the tests; never a real key), then click Gauntlet, then Batch. The two models are still ticked, and the header still says "Key saved".
  2. Count `/data/config.json` requests across three tab changes: one request in total.
  3. Open `/batch.html` and `/live.html`: each ends on the right view with the URL hash.
  4. Back and forward move between views.
  5. A full reload clears the key ("No key set").
- [ ] Run `npm test`, `python scripts/check_no_secrets.py`, `python scripts/check_contrast.py`, and the Python suite (`/Users/mobinzaki/Github/Hacktest/.venv-spine/bin/python -m unittest discover -s tests -t .`). Paste the outputs.
- [ ] Report what was checked and what was not (for example, a browser check that could not be run is reported as not run).

## Execution order

Task 1 first (it sets the markup, the IDs and the router contract). Then Tasks 2, 3, 4 and 5 in parallel (3 is needed by 2, 4 and 5 for the data reads, but they can build against its interface). Then Task 6.
