# Model details and selection counts Implementation Plan

> **For agentic workers:** Execute task-by-task with subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the batch page, show how many models (and other multi-select lists) are ticked, and show each model's context window, reasoning support and industry rank in its row, ordered from the highest rank down.

**Architecture:** The catalog in `config.json` gains four fields per model: `context_tokens`, `reasoning`, `industry_rank` and `rank_basis`. The export copies them to `site/data/config.json`. The batch page reads them and draws each row. A small shared counter function shows the "N of M selected" line at the top of each multi-select group.

**Tech Stack:** Plain HTML, CSS and ES modules (no build step), `node --test` for the browser engine tests, `python -m unittest` for the Python side.

**Spec:** This plan (from the user's request: count selected items at the top, show more data for each model in the picker, rank models from clever to least clever by industry reputation, plain numbers and a simple UI).

## Global Constraints

- The experiment code does not change. `prompt_settings` does not read the catalog, so `82f5e58164d9` and `96efc1daaa50` must stay the same. Check both.
- Do not invent data. A context length, reasoning flag or score that cannot be sourced is stored as `null`, and the page shows "unknown".
- Every rank comes with a `rank_basis` that says what it is based on. Allowed forms: a named public benchmark with its score and date, or "no public score found".
- No inline script, no `style=` attribute, no `innerHTML`. Model names are set with `textContent`. Run `scripts/check_no_secrets.py` and `npm test` before finishing.
- Readability is the top priority. Each JavaScript function has a doc comment and each new Python function a docstring. Comments explain why. No line over 120 characters.

## Decisions

- **D1. The picker.** The batch page's model checkbox list is the "dropdown" the user means. The live page only shows model names as text. It gets no picker, but its model line shows the same count.
- **D2. Counts.** Each multi-select group (models, questions, probe families) gets a line at its top: "N of M selected" (for example "3 of 29 selected"). The counts update on every change. The question count line already exists (`question-count`); it is replaced by the shared line so the wording matches.
- **D3. Model row.** Each row shows: the rank as "#1" to "#29", the model name, the context window as "128K" or "1M" (or "unknown"), a reasoning mark ("Reasoning" or "No reasoning" or "unknown"), and the price line already in the catalog. The rows are sorted by rank, top is #1.
- **D4. Rank scale.** `industry_rank` is an integer from 1 (most capable) to 29, unique, with the highest-scoring model first. Ties are broken by the public score, then by name. Models with no public score are placed after all scored models, in name order, and their `rank_basis` says "no public score found".
- **D5. Explanation.** One line under the model heading says what the rank is: "Rank: highest public score first. Source per model in its row title." The source text appears in the row's `title` attribute.
- **D6. No new dropdown library.** Use native checkboxes, as now.

## Review Focus

1. A model with `null` context or reasoning shows "unknown", not "0K" or "false". Covered by the browser engine test `modelRowText` in `js-tests/model-details.test.js`.
2. A ranking tie or a missing rank does not break the sort, and no model disappears from the list. Covered by `sortByRank` tests.
3. The count stays right after "Select all", "Clear", adding a custom model, and a preset load. Covered by `selectionCountText` tests and a headless check.
4. The page still works with the old `config.json` (no new fields). Covered by a test that passes a catalog entry with no new fields.
5. The site's catalog still matches the Python side (the catalog is not part of the experiment code). Covered by the existing Python config test and by the fingerprint check.

---

### Task A: Model data (context, reasoning, rank)

**Files:**
- Modify: `config.json` (the 29 `catalog` entries)
- Modify: `scripts/export_site_data.py` only if the new keys are dropped (check first)
- Test: `tests/test_config_catalog.py`

**Interfaces:**
- Produces: each catalog entry has `context_tokens` (integer or null), `reasoning` ("yes", "no" or null), `industry_rank` (integer 1 to 29, unique), `rank_basis` (string).

- [ ] Research each of the 29 model ids. Use WebSearch for the provider's model page (context length, reasoning or thinking mode) and for one public capability leaderboard that covers these models. Use `mode: "extended"` only when a standard search is thin. Record the source and date in `rank_basis`, for example "Artificial Analysis Intelligence Index, checked 2026-10-24, score 61".
- [ ] Put the four fields into each catalog entry. Keep the existing fields and their order.
- [ ] Rank: sort by public score, highest first. Unscored models go last in name order.
- [ ] Add tests in `tests/test_config_catalog.py`: every entry has the four fields; ranks are unique integers 1..29; `context_tokens` is null or a positive integer; `reasoning` is "yes", "no" or null.
- [ ] Run: `python -m unittest tests.test_config_catalog -v`, then `python -m unittest discover -s tests -t .` and check `82f5e58164d9` and `96efc1daaa50` with `python -c "import core; print(core.load_suite().experiment, core.load_suite('gauntlet_v4','hard').experiment)"`.
- [ ] Run `python scripts/export_site_data.py` and check `site/data/config.json` has the new fields. Report any other change in `site/data/` (there should be only `config.json`).

### Task B: Batch page counts and model rows

**Files:**
- Modify: `site/batch.html` (the model, question and family groups, and the question count line)
- Modify: `site/js/page-batch.js` (`modelChoices` near line 357, the model list build near line 370, the checkbox build)
- Create: `site/js/selection-count.js` (the shared count line)
- Create: `site/js/model-details.js` (the row text and the rank sort, pure functions)
- Modify: `site/css/page-batch.css` (small row layout, using existing tokens only)
- Test: `js-tests/model-details.test.js`, `js-tests/selection-count.test.js`

**Interfaces:**
- Produces in `model-details.js`: `formatContext(tokens) -> string` ("128K", "1M", or "unknown"); `reasoningText(value) -> string` ("Reasoning", "No reasoning", or "unknown"); `sortByRank(entries) -> entries` (new array, rank ascending, unscored last); `modelRowText(entry) -> {rank, name, context, reasoning, price}`.
- Produces in `selection-count.js`: `selectionCountText(ticked, total, noun) -> string` ("3 of 29 models selected"); `updateSelectionCount(element, ticked, total, noun)` sets `textContent`.

- [ ] Write the tests first (`node --test js-tests/model-details.test.js js-tests/selection-count.test.js` must fail).
- [ ] Implement the two modules with doc comments.
- [ ] In `page-batch.js`, build each model row from `modelRowText`, sorted with `sortByRank`. Keep the `title` attribute with the basis text. Use the old `modelChoices` fallback when the catalog has no new fields.
- [ ] Add the count line at the top of the models group, the questions group and the probe families group. Update it on every change (checkbox change, "Select all", "Clear", custom model add, preset load, saved batch load).
- [ ] Add the one-line rank explanation under the models heading (D5).
- [ ] Run `npm test` and `python scripts/check_contrast.py`. Then run `python scripts/check_no_secrets.py`.
- [ ] Headless check: open `site/batch.html` through the local server (`python -m http.server` from `site/`, or the scratch server used before). Check the count reads "3 of 29 models selected" at load, changes after "Clear", and the first model row is rank #1. Paste the text you saw.

### Task C: Live page model line

**Files:**
- Modify: `site/live.html` (the `model-list` paragraph), `site/js/page-live.js` (the model line near line 58 and its text)
- Test: `js-tests/model-details.test.js` (extend)

- [ ] Show the same "N of M models" count and list the models in rank order, using `model-details.js`. The text stays plain: name, rank, context, reasoning, one per line.
- [ ] `npm test` passes. Headless: the live page's model line lists the models in rank order.

### Task D: Review

- [ ] Run the phase review (ai-toolkit:phase-reviewer) on the changed files. Fix blockers and majors before reporting.
- [ ] Report: the test counts, the two experiment codes, the list of rank sources (or "no score" models), and any value shown as "unknown".

## Execution order

Task A first. Then Tasks B and C (C after B, because it reuses B's modules). Then Task D.
