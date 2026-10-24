# Dashboard Redesign Implementation Plan

> **For agentic workers:** Tasks are run by Haiku 5.5 subagents at medium effort, one owner per task. The coordinator owns this checklist and marks statuses; agents do not edit it. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the three-view Sycophancy Meter site (Gauntlet, Batch, Live) from a narrow stacked page into a wide dashboard with a sidebar, KPI cards and a panel grid, keeping the Field Notes theme and keeping each view's state when the visitor switches views.

**Architecture:** The site stays one static document with three `data-view` sections, shown and hidden by the existing router in `site/js/app.js`. Each page module mounts once and is never unmounted, so state survives a view switch. The new layout adds a sidebar shell (`site/js/shell.js`, `site/css/base.css`), a shared dashboard kit (`site/css/dashboard.css`), and per-view layout changes inside each view's own section. No new colours, fonts or libraries.

**Tech Stack:** Plain HTML, CSS and ES modules. Node test runner (`npm test`), Python `unittest` with Playwright (`../.venv-spine`) for browser checks, `scripts/check_contrast.py`, `scripts/check_no_secrets.py`.

**Spec:** The user's request in this conversation (2026-10-24): the UI is narrow and long; use the free width with a sidebar or a proper dashboard, without crowding; keep the current website theme (Field Notes, `site/design/DESIGN.md`); proper tab integration so no data is lost when switching tabs; fast, low-error delivery.

## Global Constraints

- Theme: Field Notes only. Use the tokens in `site/css/tokens.css` for every colour, size, space and radius. Add no new colour values.
- Chart series colours stay `--cat-1`, `--cat-2`, `--cat-3`, and only for series identity.
- CSP is `style-src 'self'` and `script-src 'self'`: no inline `<style>`, no `style=""` attributes, no inline `<script>`. Set styles through classes or CSSOM only.
- Model replies are untrusted text: render with `textContent`, never `innerHTML`.
- No paid API calls during build or tests. Browser tests must abort every request that leaves `127.0.0.1`.
- The API key (`.env`) must never appear under `site/`, in logs or in test output.
- No git commits. Everything stays in `spine-meter/`.
- Every function gets a one-line doc comment. Lines at most 120 characters. Names readable by a beginner.
- Keep the existing element ids. Where a view id clashes, use `site/js/view-ids.js`.
- Breakpoints: phone under 760px (one column, 16px gutter, no horizontal page scroll). Sidebar layout from 1024px. Content max width 1440px (new token only if needed, defined in `tokens.css` in both themes).
- Dashboard rules (from the kpi-dashboard-design and grafana-dashboards skills): 4 to 6 KPI cards per view, shown first; each KPI names its source on screen (a field-hint line); numbers before charts; charts before tables; no 3D, no decorative gradients.

## Review Focus

1. A 390px phone width: no horizontal page scroll, sidebar becomes a top bar, every control reachable. Owner: T1, V1, V2, V3, QA.
2. A view switch while a batch or live run is in progress: the run keeps going and the numbers are still there on return. Owner: T3, F1.
3. Empty or failed data load: the KPI cards show a clear placeholder ("No data loaded") and the load-fallback message still shows. Owner: V1, V2, V3.
4. Long model names and long question text inside KPI cards and panels: wrap or truncate, never push the grid wider. Owner: T2, V2.
5. Keyboard and reduced motion: the sidebar links, Key and theme buttons take focus in order with a visible ring; `prefers-reduced-motion` stops transitions. Owner: T1, QA.

## Phases and tasks

Wave 1 runs in parallel (disjoint files). Wave 2 runs in parallel (one view each). Wave 3 is the coordinator's checks plus fixes. Status values: TODO, DOING, REVIEW, DONE, BLOCKED.

| ID | Task | Owner | Depends on | Output files | Acceptance check | Status |
|---|---|---|---|---|---|---|
| T1 | Sidebar shell: nav, theme, Key placed in a left sidebar from 1024px; top bar under 1024px | Haiku T1 | none | `site/js/shell.js`, `site/css/base.css` | `node --check` passes; `npm test` passes; at 1440px the nav is a left column, at 390px it is a top bar | DONE (sidebar 232px via --sidebar-width token) |
| T2 | Dashboard kit: `.dash` 12-column grid, `.dash-kpis` strip, `.kpi-card`, `.panel`, span classes, wrapping rules | Haiku T2 | none | `site/css/dashboard.css` (new), `site/css/tokens.css` only if a token is missing | Classes listed in Interfaces exist; contrast script passes; no hard-coded colours | DONE (dashboard.css; browser width check in C1) |
| T3 | Tab-state test: Playwright test that starts a run, switches view and back, and checks the run and the key status survive; also checks Back and Forward | Haiku T3 | none | `tests/test_tab_state.py` (new) | Test runs; it reports pass or the exact failing step; it writes nothing outside the scratchpad | DONE (3 of 3 OK, re-run by coordinator) |
| V1 | Gauntlet layout: KPI strip and panel grid inside `section[data-view="gauntlet"]` | Haiku V1 | T1, T2 | `site/index.html` (Gauntlet section only), `site/css/page-gauntlet.css` | `npm test` passes; Gauntlet has 4 to 6 KPI cards; phone check passes | DONE (+ levels moved to span-8 two-column grid) |
| V2 | Batch layout: KPI strip (plan counts) and panel grid inside `section[data-view="batch"]` | Haiku V2 | T1, T2 | `site/index.html` (Batch section only), `site/css/page-batch.css`, `site/js/page-batch.js` (KPI text only) | `npm test` passes; plan counts still match the planner; phone check passes | DONE (dashboard.css link moved to shared head) |
| V3 | Live layout: KPI strip and panel grid inside `section[data-view="live"]` | Haiku V3 | T1, T2 | `site/index.html` (Live section only), `site/css/page-live.css`, `site/js/page-live.js` (KPI text only) | `npm test` passes; animations still respect reduced motion; phone check passes | DONE (chart titles wrap via draw.js wrapTitle) |
| F1 | Tab-state fixes found by T3 (only if T3 reports a failure) | Haiku T3 (continued by message) | T3, V1, V2, V3 | the files named in T3's report | `tests/test_tab_state.py` passes | NOT NEEDED (T3 passed) |
| D1 | Update `site/design/DESIGN.md`: sidebar, dashboard grid, KPI card, panel; remove the old 760px-only layout text | Haiku D1 | V1, V2, V3 | `site/design/DESIGN.md` | Doc matches the built classes; no claims without a class | DONE (doc: 1440px dashboard cap, 1120px compare cap) |
| Q1 | QA: screenshots at 1440px and 390px for all three views (saved state); list overflow, focus and text issues | Haiku Q1 | D1 | scratchpad PNGs and a findings list (no edits) | Findings list with file and selector per issue | DONE (screenshots at 390 and 1440, all views) |
| F2 | Fixes from Q1, one owner per view (same file rules as V1 to V3) | Haiku V1, V2, V3 | Q1 | as V1 to V3 | Q1 issues closed; `npm test` passes | DONE (Gauntlet levels layout, KPI note, Live title wrap) |
| C1 | Coordinator checks: `npm test`, Python `unittest` for `test_tab_state` and `test_compare_browser`, `check_contrast.py`, `check_no_secrets.py`, screenshot review | Coordinator | F2 | none | All green, or each failure named with its cause | DONE (npm 1178, unittest 451, tab-state 3, compare 12, contrast 42/42, secrets 86 files) |

## Interfaces (shared by all tasks)

- Shell (T1): `buildShell({ vault, navigate })` in `site/js/shell.js` keeps its signature. It returns a `header.site-header` containing `nav.site-nav` (links with `data-nav-view`), and `.site-tools` (theme button, Key button, `.key-status`). Sidebar classes: `.site-header` (sidebar at 1024px+), `.site-nav-list`, `.site-nav-link`.
- Dashboard kit (T2), CSS classes only:
  - `.dash`: the 12-column grid. Gap `--space-6`.
  - `.dash-kpis`: 4 to 6 cards in one row at 1024px+, two per row on tablet, one per row on phone.
  - `.kpi-card`: a card with `.kpi-label` (small caps), `.kpi-value` (`--size-3xl`, `--font-serif`), `.kpi-note` (`--size-sm`, ink-mute).
  - `.panel`: a card with a `.panel-title` (section label, numbered) and a body.
  - Spans: `.span-3`, `.span-4`, `.span-6`, `.span-8`, `.span-12`. Each is full width under 760px.
  - `.is-empty` on a `.kpi-card` shows the placeholder text in `.kpi-value`.
- Router (unchanged): `site/js/app.js` `createRouter`. Views are hidden, never removed. Mounts run once.

## Task details

### T1: Sidebar shell

**Files:** Modify `site/js/shell.js`, `site/css/base.css`.
**Interfaces:** Keep `buildShell` and `initShell`. Add no new exports.

- [ ] Step 1: Run `npm test` and note the pass count (must stay the same after the change).
- [ ] Step 2: In `base.css`, make `.site-header` a fixed-width left column (about 232px) from 1024px. The `.page` next to it takes the rest of the width. Under 1024px the header is a top bar and the nav links wrap.
- [ ] Step 3: In `shell.js`, put the brand line ("Sycophancy Meter") at the top of the header, the nav in the middle, and the tools at the bottom of the column. The DOM order stays nav, then tools, so keyboard order is unchanged.
- [ ] Step 4: Keep `aria-current="page"` on the open link. Keep `hidden` behaviour: the `[hidden]` rule must win over any `display` set by a class.
- [ ] Step 5: `npm test` passes with the same count. `node --check site/js/shell.js` passes.

### T2: Dashboard kit

**Files:** Create `site/css/dashboard.css`. Modify `site/css/tokens.css` only if a needed token is missing (add it to both themes).

- [ ] Step 1: Write `dashboard.css` with the classes in Interfaces. Use tokens only.
- [ ] Step 2: Add `overflow-wrap: anywhere` to `.kpi-value` and `.panel-title` so long model names wrap.
- [ ] Step 3: Under `prefers-reduced-motion: reduce`, set no transitions on `.kpi-card`.
- [ ] Step 4: `python3 scripts/check_contrast.py` in `spine-meter/` passes. `npm test` passes.

### T3: Tab-state test

**Files:** Create `tests/test_tab_state.py`.
**Interfaces:** Uses the same server pattern as `tests/test_compare_browser.py` (serve `site/` on 127.0.0.1, abort other hosts).

- [ ] Step 1: Test A: open `/#batch`, tick two models, press Start on a saved (offline) run, switch to Gauntlet, switch back. Assert the model ticks and the status line text are unchanged.
- [ ] Step 2: Test B: press the Key button, type a fake 30-character key, save, switch to Live, switch back. Assert `.key-status` reads "Key saved". The key text must not be in the page source.
- [ ] Step 3: Test C: navigate Gauntlet, Batch, Live, then Back twice. Assert the hash and the visible view match at each step.
- [ ] Step 4: Run `../.venv-spine/bin/python -m unittest tests.test_tab_state -v` from `spine-meter/`. Report each assertion result.

Do not change site files in T3. If a test fails, report the failing step, the observed value and the file you think owns the cause.

### V1, V2, V3: View layouts

**Files:** One view each. Edit `site/index.html` only inside your own `<section data-view="...">`, with Edit (not Write). Edit the CSS file and JS file named for your view.

- [ ] Step 1: Read the section and its page module. List the existing numbers the view already shows (counts, status, run totals).
- [ ] Step 2: Add a `.dash-kpis` strip with 4 to 6 `.kpi-card` elements at the top of the section, using existing ids where a value exists; otherwise add an id prefixed with the view name.
- [ ] Step 3: Wrap the rest of the section's panels in `.dash` with `.panel` and span classes so the view uses the width at 1024px+.
- [ ] Step 4: Fill each KPI from data already on the page (text only; `textContent`). With no data, show "No data loaded" with `.is-empty`.
- [ ] Step 5: `npm test` passes. Load the page in headless Chromium at 390px and check `document.documentElement.scrollWidth <= 390`.

### D1: Design doc

**Files:** Modify `site/design/DESIGN.md` (Layout grid and Components sections only).

- [ ] Step 1: Describe the sidebar, the 12-column dashboard grid, `.kpi-card`, and `.panel` with their class names.
- [ ] Step 2: Remove the sentence that says the content is capped at 1120px; state the new cap.

### Q1: QA

- [ ] Step 1: Screenshot the three views at 1440px and 390px in light and dark theme with headless Chromium. Save to the scratchpad.
- [ ] Step 2: Read each PNG. Write a findings list: file, selector, problem. Do not edit site files.

## Coordinator notes

- Wave 1 is safe in parallel because T1, T2 and T3 touch disjoint files.
- Wave 2 edits one shared file (`site/index.html`), one section per agent, with Edit. The risk is a race in the same second; the coordinator checks the file after the wave with `node` HTML parse and by counting `data-view` sections (must be 3).
- The plan does not commit. The coordinator runs C1.
