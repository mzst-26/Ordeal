# PLAN_COMPARE: the comparison page

Written by the orchestrator. This file is separate from `PLAN.md`, which belongs to an earlier session (its paid-run invariants still apply: no paid calls, no edits to `core.py` behaviour, no changes to `results/` or the existing site pages).

Status values: todo / doing / done / blocked. A task is done only when its acceptance check has passed and the output is pasted into this file.

## 0. Ground rules

- Writers are Haiku 5.5 subagents. The orchestrator plans, delegates, runs the checks and records the output here.
- No network calls at build or test time, and no paid API calls. The browser test blocks all requests except the local server.
- No secrets in any file. The builder reads no `.env` and no environment variables.
- Do not change `results/`, `site/data/*.json` (existing files), `core.py`, `grade.py`, `PLAN.md`, the three existing pages, or existing tests. New files only, plus the explicit additions listed in section 4.
- No git commits (`spine-meter/` is untracked).
- Commit attribution rules do not apply: nothing is committed.
- Tokens only. Every colour, size, spacing and radius comes from `site/css/tokens.css`. New component CSS may only define layout and component rules that use `var(--...)` tokens.
- CSP (`netlify.toml`): `script-src 'self'`, so no inline script and no CDN. No `style="..."` attributes in HTML. Setting styles from JavaScript through `element.style` or the CSSOM is fine.

## 1. Data reality (checked, not assumed)

- `results/results.csv` has **3 models** (Qwen3-30B-A3B-Instruct-2507, gemma-3-27b-it, Nemotron-3-Super-120B-A12B), suite `gauntlet_v3+easy`, condition `none` only.
- The page is built for up to 29 models. The counter reads "N of 3 models shown" from the data. This is intended.
- Mitigation and control conditions have **no saved data**. They must render as "not run". This is the honest state, not a bug.
- Fingerprint: 12 axes in `probes.csv` with `family=fingerprint` (bare, doubt_only, quote_mine, oracle, trojan, authority, consensus, unity, affect_stakes, flattery, elite_bait, commitment). `tampered_history` is a separate family (`tampered`) and is NOT part of the fingerprint.
- Twins: 9 axes with `family=twin`, measures `hit_rate`, `false_alarm_rate`, `discrimination`, `d_prime`.
- Dose dials (`family=dose`) are not shown on the page (not in the brief's list). They stay in the data for later.
- Cache steps: `level_N`, `setup_4`, `confession`, `corr_A/B`, `fp_<axis>`, `fp_commitment_setup`, `twin_<axis>`, `dose_*`. Each record: `experiment, condition, model, question_id, repeat, step, temperature, messages, reply, timestamp`.
- A fingerprint record's `messages` = the baseline question, the baseline answer, then the probe message. `reply` is the model's reply to the probe.
- Metric definitions (for the glossary): `README.md` lines around 250–280 (initially-right units, Spine Score, flip rate, capitulated, converted, acceptance, fingerprint flip rate, twin hit rate, false alarm, d-prime).
- The site fingerprint in `scripts/export_site_data.py` is the public-file pattern to follow.
- Current paid process: none running (PID 18431 has exited). Still, nothing here starts a paid run.

## 2. Decisions taken by the orchestrator (the user may change them)

- D1. Output file name. `PLAN.md` already exists for another job, so this plan is `PLAN_COMPARE.md`. Results go to `site/data/compare/results.json`.
- D2. Embedding. The builder writes the JSON into `site/compare.html`, inside `<script id="compare-data" type="application/json">`. This is inert under CSP and works offline. The builder escapes `</` as `<\/`.
- D3. Rates. Every rate is an object `{rate, ci_low, ci_high, n}`. `null` means "not run" and is never 0. `n` is the number of units behind the rate.
- D4. Derived values (backbone index, personality, gates, twin pooling, transcript choice) are computed in the Python builder, so they are testable. The browser only filters, sorts, bands and draws.
- D5. Backbone index interval: the mean of the 12 fingerprint rates, with `ci_low` = mean of the lows and `ci_high` = mean of the highs. This is a documented approximation (conservative in practice, not an exact interval). Shown in the tooltip.
- D6. Twin pooling: `hit_rate` and `false_alarm_rate` are unit-weighted means over the 9 twin axes. Their intervals are the unit-weighted means of the per-axis bounds (approximate, labelled as such). `discrimination` = hit − false alarm. The per-axis table is always shown beside the pooled numbers.
- D7. Mitigation: `mitigation[cond]` holds `flip_rate_last` and `fingerprint_mean` where the condition was run, otherwise `null`. The delta is computed in the browser: mitigation − none, and control − none.
- D8. Transcripts: deterministic. Per model, up to 6 units, drawn from the fingerprint probes. Target mix: up to 3 HELD and up to 3 FOLDED, each from a different axis where possible. Units are sorted by axis order, then question_id, then repeat. A unit counts only if its baseline is correct and its probe reply has a parseable letter. A FOLDED transcript carries the gauntlet confession for the same (model, question_id, repeat) when one exists, otherwise `confession: null`.
- D9. Animation length: the brief says 200 ms. The token scale has `--dur-fast` 150 ms and `--dur-base` 240 ms. Use `--dur-base` (token reuse rule); report the 40 ms difference.
- D10. Family hues (max 8, all from tokens, in this order): `--cat-1`, `--cat-2`, `--cat-3`, `--teal`, `--sage`, `--terracotta`, `--plum`, `--ochre`.
- D11. Heatmap scale: `--paper-raised` (cream, value 0) to `--cat-1` (maroon, value 1), mixed with `color-mix(in srgb, ...)` set through the CSSOM.
- D12. Survivors dot colour: `--sage` (held, flip rate ≤ 50%) to `--terracotta` (flipped past 50%).
- D13. Model-level gate `low_sample`: true when any cell behind the model has `n < 15` (gauntlet units, any fingerprint axis, any twin axis).
- D14. Model-level `data_warning`: true when `unparsed_share.rate > 0.10`.
- D15. Consistency check (`final_correct_check`): with f = flip rate at the last level and r = recovery rate, the check passes when `(1 − f) − 1e-6 ≤ final_correct ≤ (1 − f) + f·r + 1e-6`. Failure sets `consistency_flag` true on the model and adds a warning to `warnings`. The page shows the flag.
- D16. Model metadata lives in `models_meta.json` at the project root (hand-written). Filled from the model ID only, the three entries are: `Qwen/Qwen3-30B-A3B-Instruct-2507`: family Qwen, params 30, active 3, reasoning false, open weights true. `google/gemma-3-27b-it`: family Gemma, params 27, active null (dense), reasoning false, open weights true. `nvidia/nemotron-3-super-120b-a12b`: family Nemotron, params 120, active 12, reasoning null (unknown), open weights true. Everything else is null, including `release_date`. Each entry has `"source": "model id"`.
- D17. Personality lookup (fixed, in the builder): commitment → "Keeps its word, even when wrong"; authority → "Defers to titles"; flattery → "The Flatterable"; affect_stakes → "Soft-hearted"; bare → "Folds at a bare no"; doubt_only → "Second-guesses itself"; quote_mine → "Taken in by quotes"; oracle → "Impressed by a claimed oracle"; trojan → "Fooled by a planted argument"; consensus → "Follows the crowd"; unity → "Joins the chorus"; elite_bait → "Hooked by elite framing". Personality = label of the weakest axis (highest flip rate), with the second-weakest named as secondary. Ties break by axis order in the spec list. A model with no fingerprint has personality null.
- D18. Rank bands are computed in the browser from the visible models, using the backbone index intervals. Models whose intervals overlap (chained) share a band. Band labels are "Band 1", "Band 2" and so on, ordered by backbone index.
- D19. Scatter and heatmap: families use the D10 palette in first-seen order from `models_meta` family, then display name.
- D20. Mitigation prompt text (FIG 7 caption) comes from `config.json` `system_prompts` for `mitigation` and `control`, copied into `results.json` as `mitigation_prompts`.

## 3. The data contract: `site/data/compare/results.json`

```
{
  "schema_version": 1,
  "suite": "gauntlet_v3+easy",
  "experiment": "<experiment code from results.csv>",
  "generated_at": "<UTC ISO time>",
  "level_count": 10,
  "held_firm_score": 11,
  "axes": [{"id": "bare", "label": "Bare assertion (control)", "family": "fingerprint"}, ...],   // 12 fingerprint axes, spec order; plus "tampered_history" with family "tampered" is NOT in this list
  "twin_axes": ["bare", "oracle", ...],                                                              // 9 ids
  "conditions": ["none", "mitigation", "control"],
  "mitigation_prompts": {"mitigation": "<text>", "control": "<text>"},
  "warnings": ["..."],
  "models": [ <model>, ... ]
}
```

Model:

```
{
  "id": "Qwen/Qwen3-30B-A3B-Instruct-2507",
  "display_name": "Qwen3 30B-A3B Instruct (2507)",     // from models_meta, else the id
  "family": "Qwen",                                       // null if unknown
  "params_b": 30,  "active_params_b": 3,                  // null if unknown; active null when dense
  "reasoning": false, "open_weights": true, "release_date": null,
  "units": 56, "questions": 29,                           // from results.csv
  "baseline_accuracy": <Rate>,
  "unparsed_share": <Rate>,
  "flip_curve": [{"level": 1, "rate": <Rate>}, ... up to level_count],
  "flip_rate_last": <Rate>,                               // = last level of flip_curve
  "mean_spine_score": <Rate>,                             // rate.rate holds the mean; ci from the csv
  "flip_count": 56,  "recovery_rate": <Rate>,
  "final_correct_share": <Rate>,
  "capitulated_share": <Rate>, "converted_share": <Rate>,
  "acceptance_a": <Rate>, "acceptance_b": <Rate>, "acceptance_mean": <Rate>,
  "fingerprint": {"bare": <Rate>|null, ... all 12 axes},  // each Rate has n = probe units
  "backbone_index": {"rate": 0.61, "ci_low": 0.55, "ci_high": 0.67, "n": 12} | null,   // see D5; n = number of axes used
  "personality": {"label": "...", "primary_axis": "commitment", "secondary_axis": "flattery"} | null,
  "mitigation": {"none": {"flip_rate_last": <Rate>|null, "fingerprint_mean": <Rate>|null}, "mitigation": null | {...}, "control": null | {...}},
  "twin": {"hit_rate": <Rate>, "false_alarm_rate": <Rate>, "discrimination": <Rate>,
           "per_axis": {"bare": {"hit_rate": <Rate>, "false_alarm_rate": <Rate>, "discrimination": <Rate>, "d_prime": <Rate-like>}, ...}} | null,
  "transcripts": [{"axis": "commitment", "question_id": "m02", "repeat": 1,
                   "messages": [{"role": "user", "content": "..."}, ...],
                   "reply": "...", "outcome": "held" | "folded",
                   "confession": {"letter": "C", "text": "..."} | null}],   // 0 to 6; "not run" when empty
  "gates": {"low_sample": false, "low_sample_cells": ["..."], "data_warning": false,
            "consistency_flag": false, "final_correct_check": {"lower": 0.0, "upper": 0.0, "final": 0.0, "ok": true}}
}
```

Rate: `{"rate": float|null, "ci_low": float|null, "ci_high": float|null, "n": int|null}`. A missing CSV cell gives `null` for every field, and that is the only way "not run" is shown. Never write 0 for a missing value.

Every rate is a fraction from 0 to 1 except `mean_spine_score` (1 to 11) and `d_prime` (any real number).

## 4. Files and ownership

| Path | Owner | Notes |
|---|---|---|
| `scripts/build_compare.py` | P | Builder. One command rebuilds the JSON and embeds it into the page. |
| `models_meta.json` (project root) | P | Hand-written per D16. |
| `tests/test_build_compare.py`, `tests/fixtures/compare/` | P | 5 fake models per the brief. Temp dirs only. |
| `site/data/compare/results.json` | P (generated) | The builder writes it. Nobody hand-edits it. |
| `site/compare.html` | F1 (shell); P only rewrites the content of the `<script id="compare-data">` element | Builder replaces the element's text, nothing else. |
| `site/css/page-compare.css` | F1 | Page layout, cards, filter bar, shared figure classes, table fallback, tooltip. |
| `site/css/compare-figs-a.css` | F2 | Heatmap, survivors, mitigation. |
| `site/css/compare-figs-b.css` | F3 | Head to head, transcript replay, model card, share card. |
| `site/js/compare/derive.js` | F1 | Pure helpers. Shared API (section 5). |
| `site/js/compare/radar.js` | F1 | Pure SVG radar. Shared API. |
| `site/js/compare/tooltip.js` | F1 | Shared tooltip. Shared API. |
| `site/js/compare/app.js` | F1 | Boot, state, filters, figure mounting, glossary, how-to-read, announcer. |
| `site/js/compare/fig-scatter.js` | F1 | FIG 1 and FIG 6 (same module, two mounts). |
| `site/js/compare/fig-fingerprint.js` | F2 | FIG 2 heatmap, sort, hatch, not-run dots, accessible table. |
| `site/js/compare/fig-survivors.js` | F2 | FIG 3. |
| `site/js/compare/fig-mitigation.js` | F2 | FIG 7. |
| `site/js/compare/fig-h2h.js` | F3 | FIG 4. |
| `site/js/compare/fig-replay.js` | F3 | FIG 5. |
| `site/js/compare/model-card.js` | F3 | Model Card panel and "Download card" (PNG via canvas, no network). |
| `js-tests/compare-derive.test.js` | F1 | `node --test` (picked up by `npm test`). |
| `js-tests/compare-figs.test.js` | F2 and F3 (each their own file if needed) | Keep to pure logic. |
| `tests/test_compare_browser.py` | T | Playwright (Python), browser run against a local server with the network blocked. |
| `scripts/check_compare_a11y.py` (optional) | R or T | Only if it helps the checklist. |

Nothing else is edited. If a file outside this table must change, stop and say so in this plan first.

## 5. Shared interfaces (agree before writing)

### 5a. `derive.js` (F1). Named exports:

- `isNotRun(rate)`: true when `rate` is null or undefined or `rate.rate` is null.
- `pct(value, digits = 0)`: "62%"; returns "not run" for null.
- `rateText(rate)`: "62% (95% CI 55–67%, n=56)"; "not run" for null.
- `visibleModels(models, filters)`: returns models passing every filter. `filters` = `{families: Set, sizeMin, sizeMax, reasoning: "any"|"yes"|"no", open: "any"|"yes"|"no", lowSampleHidden: bool, search: string}`. A null `params_b` passes the size filter only when the slider is at its full range. A null `reasoning` or `open_weights` passes only when the filter is "any".
- `defaultFilters(models)`: all families selected, full size range, "any", low-sample hidden = true, search "".
- `familyColour(family, familyOrder)`: returns a CSS value such as `var(--cat-1)`. `familyOrder` is the array of families in first-seen order. Unknown family → `var(--ink-mute)`.
- `familyOrder(models)`: unique families in first-seen order, `null` family last under the label "Unknown".
- `rankBands(models)`: returns `Map<id, bandNumber>`. Uses `backbone_index`. Models with null backbone index get no band (`null`).
- `takeaway(models)`: one sentence (plain English) built from the data, e.g. "On this run, 3 models were compared; the one that held longest reached Level 10 with 0% flipped." Must read well with 1 or many models.
- `FAMILY_PALETTE`: the 8 token names from D10.
- `LEVEL_LABELS`: nothing special; levels are plain numbers.

### 5b. `radar.js` (F1). `radarSvg({axes, series, size, label})` returns an `<svg>` element.

- `axes`: `[{id, label}]`. `series`: `[{name, values: {id: number|null}, colour: "var(--cat-1)", fill: true|false}]`. Values are 0 to 1 (flip rates); the radar draws the values with null as a gap. Spokes are labelled with the axis label. `label` is the `aria-label`.
- Output has `role="img"` and `aria-label`, and each series has a `<title>`.

### 5c. `tooltip.js` (F1). `showTooltip(html, anchorRect)` and `hideTooltip()`. A single `div` with `role="tooltip"`, using the token styles from `page-compare.css`. Content is built with `textContent` or escaped HTML: never raw model text.

### 5d. Figure module contract (all figure modules)

```js
export function mount(root, api) { ...; return { update(view) { ... } }; }
```

- `root`: the element with the figure's id (for example `#fig-scatter`).
- `api` (provided by `app.js`):
  - `data`: the full `results.json` object.
  - `allModels`, `familyOrder`, `familyColour(family)`: as above.
  - `openModel(id)`: opens the Model Card and pins the model.
  - `pinModel(id)`: selects without opening.
  - `setCondition(cond)`: "none" | "mitigation" | "control".
  - `announce(text)`: writes to the polite live region.
  - `resetFilters()`.
- `view` (passed to `update`): `{models, allModels, filters, condition, selectedId, openId, bands}`. `models` = visible models after filters, in the order used by the figure. `bands` = `Map` from `rankBands`.
- A figure must work with 0 models (show "No models match these filters" and a reset button inside its own card, using `api.resetFilters()`).
- A figure must show "not run" for any null value. Never draw a null as zero.
- Each figure is wrapped in `<section class="card figure" id="fig-...">` created by F1 in `compare.html`. Inside it: `<p class="card-label">FIG. n · TITLE</p>`, a chart container, a caption (`<p class="field-hint">`, one sentence), and a `<details>` or button for the table fallback.

### 5e. Model Card (F3). `model-card.js` mounts on `#model-card` (an `<aside role="dialog" aria-modal="true" aria-labelledby>`, created by F1 in `compare.html`). It slides in from the right (`transform` with `--dur-base`), full screen on phones. Esc closes it. Focus moves to the close button on open and returns to the trigger on close.

## 6. Element IDs in `compare.html` (F1 creates them)

- `#masthead` (title "Smart vs Spineless", takeaway line filled by `app.js`).
- `#how-to-read` (box with the five honesty points from the brief).
- `#filter-bar` (sticky). Inside: `#filter-family` (chips), `#filter-size` (range, `input[type=range]`, on `params_b`), `#filter-reasoning` (select: any/yes/no), `#filter-open` (select: any/yes/no), `#filter-condition` (segmented: none/mitigation/control), `#filter-lowsample` (checkbox, default checked), `#filter-search` (text), `#filter-count` (live region: "N of M models shown"), `#filter-reset` (button).
- Figures in this order: `#fig-scatter` (FIG 1), `#fig-fingerprint` (FIG 2), `#fig-survivors` (FIG 3), `#fig-h2h` (FIG 4), `#fig-replay` (FIG 5), `#fig-map` (FIG 6, uses the same scatter module), `#fig-mitigation` (FIG 7).
- `#glossary` (`<details>` titled "What do these terms mean?").
- `#model-card`. `#announcer` (polite live region). `#footer-note` (the uncertainty footnote: "Differences under about 15 points are within noise.").
- `<script id="compare-data" type="application/json">` (the builder fills it).
- `<script type="module" src="/js/compare/app.js">`.

## 7. Task list

| ID | Task | Owner | Depends on | Files it may touch | Acceptance | Status |
|---|---|---|---|---|---|---|
| P | Builder, models_meta, fixtures, pytest-style unittest, real build | Haiku 5.5, high | none | section 4 rows for P | `python -m unittest tests.test_build_compare` OK (29 tests); full suite OK (357). Round 1 done. Round 2 done: backbone over axes present (n=11, quote_mine not run, axes_missing listed); D15 lower bound includes u (unparsed at last level, not already flipped); data_warning also when u > 0.10. Tests: builder 32 OK; full suite 382 OK. Real build: 3 models; backbone Qwen 0.615, Gemma 0.593, Nemotron 0.227 (all n=11); checks ok for all three; Nemotron data_warning (u=0.3125). | done
| F1 | Shell page, CSS, derive, radar, tooltip, app, scatter (FIG 1 and FIG 6), glossary, how-to-read, node tests | Haiku 5.5, medium | none (design to contract) | section 4 F1 rows | `npm test` 1116 pass, 0 fail (F1's 19 derive tests among them). Headless check at 1280 and 390 px: no console errors, scrollWidth = innerWidth, filters, FIG 1 and FIG 6, model card open and Esc all work. Not verified: dark theme, full keyboard pass, screenshots reviewed. | built, browser-checked (partial) |
| F2 | FIG 2 heatmap, FIG 3 survivors, FIG 7 mitigation | Haiku 5.5, medium | F1 contract | section 4 F2 rows | Node tests: `node --test js-tests/compare-figs-a.test.js` tests 12, pass 12, fail 0. Browser check pending integration (no results.json or app.js when F2 reported). | built, browser pending |
| F3 | FIG 4 head to head, FIG 5 replay, Model Card, Download card | Haiku 5.5, medium | F1 contract | section 4 F3 rows | Node: `compare-figs-b.test.js` 14/14. Browser (its own check, real data): all three mount with no console errors; the example button opens and reaches FOLDED; the card opens and Esc closes. Not verified: Download card click, 390 px, keyboard-only. | built, browser-checked (partial) |
| I | Integration: run the builder, load the page, fix wiring | orchestrator | P, F1, F2, F3 | none (reports only) | Console clean at 1280 and 390 px | todo |
| T | Playwright browser tests (Python), screenshots at 1280 and 390 px | Haiku 5.5, high | I | `tests/test_compare_browser.py`, scratchpad screenshots | tests run, output pasted here | todo |
| R | Reviewer, a different subagent from every author: secrets, network calls, tokens, a11y checklist, against the brief | Haiku 5.5, high | T | none (report only) | written findings pasted here | todo |
| Fix | Address reviewer findings | the author of each file, or the orchestrator | R | as needed | re-run T | todo |
| Done | Final summary: built, tests, unverified, one command | orchestrator | all | none | | todo |

## 8. Acceptance tests (from the brief, mapped to the owners)

- P: pipeline fixture with 5 fake models, including one missing mitigation data, one low-sample and one with a data warning. Asserts that nulls remain null, `gates` flags are set, and the transcript count is between 0 and 6. Also asserts that nothing is written outside the temp dir.
- F1 (node): `visibleModels` with each filter; `rankBands` with overlapping and separate intervals; `rateText` for null; `takeaway` for 0, 1 and many models.
- T (Playwright, Python, Chromium from the local cache):
  1. Page loads with network blocked (only 127.0.0.1 allowed); no console errors.
  2. Each filter changes "N of M models shown".
  3. Heatmap: clicking a column header sorts; clicking again reverses.
  4. Survivors slider changes the "still holding" count.
  5. Head to head renders the radar and the table; the "Show me a real example" button opens FIG 5.
  6. Transcript replay plays and reaches the HELD or FOLDED stamp; skip works.
  7. Mitigation toggle changes bar heights (or shows "not run" where there is no data).
  8. Esc closes the Model Card.
  9. Keyboard-only run through FIG 2: Tab reaches the headers and cells, Enter sorts, arrows move.
  10. Screenshots at 1280 px and 390 px saved to the scratchpad; no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`).

## 9. Log

- Orchestrator: plan written; P, F1, F2 and F3 delegated in parallel (P first in the critical path, F-agents build against this contract).
- Round 2 of P (decided by the orchestrator, not in the first plan):
  - D5 amended: backbone index = mean over the fingerprint axes that have data; `n` = axes used; `axes_missing` lists the rest. Reason: quote_mine has 0 units for all three models (the probe was never run), so the strict rule would leave every model without an index.
  - D15 amended: lower bound is `1 - f - u`, where u = share of initially-right units with no parseable letter at the last level and never a wrong letter (not already counted as a flip). Reason: Nemotron's replies at the last level often have no "Answer: X" (31% of its initially-right units), and the first form of the check counted those as neither correct nor flipped.
  - D14 extended: data_warning is also true when u > 0.10. The page shows the warning text with the number.
- Integration (orchestrator):
  - Removed the static captions for FIG 2, 3 and 7 from compare.html: F2's modules write their own (the FIG 7 static text was also wrong about the prompt).
  - FIG 4 example: the example axis must now have a saved transcript for the model with the higher value (`replayableAxes` in fig-h2h.js). Before, the example picked elite_bait for Qwen, which has no transcript on that axis.
- Checks after integration: node `npm test` 1116 pass, 0 fail; `tests.test_build_compare` 32 OK; full Python suite 382 OK; builder re-run and embedded.
- Round 3: T (Playwright browser tests, Python) reported `../.venv-spine/bin/python -m unittest tests.test_compare_browser -v`: Ran 12 tests, OK. All 10 brief items pass against the real data. Screenshots: scratchpad compare-shots (1280 light, 390 light, 1280 dark). Observations: the sticky filter bar covers a scatter point when scrolled into view; the low-sample checkbox has no effect with this data (no model is low-sample).
- Orchestrator review of the 1280 screenshot: FIG 2 heatmap runs past the card's right edge (last columns cut off); FIG 4 radar axis labels crowd together. Both to check and fix after R reports.
- Round 3 review (R, independent of every author; report in scratchpad review-R.md). Blocking, all to fix:
  1. Model Card does not reopen the same model after Close (api.closeModel never called).
  2. Backbone index sign: the builder stored the mean FLIP rate. The brief defines backbone = 1 minus the mean flip rate. Confirmed by the orchestrator (Qwen stored 0.615, correct firmness is 0.385). Fix: builder, plus the band order and head-to-head direction that depend on it.
  3. Heatmap hot-cell text fails WCAG AA (2.55:1 to 4.5:1 across fills 0.5 to 0.75).
  4. Focus does not return to an SVG trigger (instanceof HTMLElement).
- Round 3 review, should fix: FIG 4 and FIG 5 ignore filters (say so in captions); masthead count uses visible models; rank bands not shown; consistency null shown as ok; tooltip innerHTML string branch and unused escapeHtml; off-scale font sizes (10px, 11px, literal 12px) and off-token spacing (2px, 4px, 2rem); a duplicated test assertion.
- Round 4 (running): fixes sent to P (backbone sign, check.status, test cleanup), F1 (band order, glossary, takeaway, tooltip, tokens), F2 (heatmap contrast, bands in row labels), F3 (close and focus, consistency chip, filter captions, tokens). Each agent edits only its own files and reports the test output.
