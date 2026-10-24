# Phase review: Python scripts, JS engine, pages, charts and tests

Snapshot reviewed at about 08:01. The builder edited api.js, shell.js, page-batch.js, page-live.js and page-gauntlet.js while I read, so line numbers are from the latest copy and may drift. `scripts/validate_palette.js` does not exist, so it was skipped.

## Summary

The key handling is sound: there is no innerHTML, no inline script, no `style=` attribute, no key in storage, URL or console, and `check_no_secrets.py` passes. One blocker: live mode on the Gauntlet page throws a ReferenceError on its first call. The batch runner can keep spending calls after an unexpected error, and Stop can lag behind retry back-off. The largest quality debt is copy-pasted code between pages and three files of 1,000 or more lines. Findings: **1 blocker, 8 major, 15 minor.** Checks run: npm test 836 pass, Python unittest 194 pass, check_contrast 28 of 28, no line over 120 characters, every exported JS function has a doc comment.

## Findings

| ID | Severity | File and line | What is wrong | Suggested fix |
|---|---|---|---|---|
| R1 | blocker | site/js/page-gauntlet.js:467-468 | `callModel` reads `config.temperature` and `config.max_tokens`, but `config` is no longer declared there (confirmed by a scope check), so the first live call throws. No test loads page code. | Add `const { config } = page.data;` at the top of `callModel`. |
| R2 | major | site/js/engine/runner.js:250-257, 281-289; page-batch.js:667-681; page-live.js:1044-1047 | An error thrown inside one unit (verified with a bad question option) rejects `start()`, but the other workers keep calling the API (2 calls at rejection, 14 four hundred ms later) and no end event is sent. The pages say "stopped" while calls continue. | Catch per unit and emit a failure event, or call `requestStop()` in a `finally` and always emit an end event. |
| R3 | major | site/js/engine/api.js:201 | `sleep(backoffSeconds(...))` ignores the abort signal. Verified: Stop at 0.2 s ended the call at 1.5 s; with real back-off it can wait 16 s. | Pass the signal to `sleep` and reject at once on abort. |
| R4 | major | engine/planner.js:54, 74, 99; engine/flows.js:216, 232, 258 | `confessionCanFollow` takes `families`, `ladder` and `probeSpec` and uses none; `planModelCalls` and `planAllModels` pass an unused `config`. `planModelCalls` has 9 positional parameters, `runFlows` 8. | Drop the unused parameters and group the rest into one options object. |
| R5 | major | page-batch.js:949-1079 and page-live.js:509-678 | Ten identical chart-panel functions (about 110 lines) are copied between two pages, plus more copies (see Duplicated logic). | Move them into one shared module, for example `chart-panel.js` and `data-loader.js`. |
| R6 | major | page-batch.js (1227 lines), page-live.js (1196), charts/index.js (1021); runner.js:179 `createBatchRunner` (158 lines), :75 `makeReplyRunner` (98), index.js:903 `createChart` (79), token-dialog.js:79 (48) | Several jobs per module and functions far past 40 lines, which a non-coder cannot follow. | Split by job (setup form, run control, results, export; one file per chart type); turn the runner into small named pieces. |
| R7 | major | charts/index.js:135-142; page-batch.js:1082-1087 | Missing or NaN values are drawn as 0, so "no data" looks like "never flips", while the table beside it shows a dash. Not sure how often it shows in practice. | Keep NaN as a gap in the chart, or label the bar "no data". |
| R8 | major | charts/index.js:196-198; page-batch.js:816 | `svg.style.*` and `progressFill.style.width` set inline styles. CSP allows the DOM `style` property, but the owner rule says no inline style attributes. Judgement call on the progress bar. | Put the three static rules in a CSS class; use `<progress>` or width classes for the bar. Make `ui.js` `el()` reject `style` and `on*` names. |
| R9 | major | scripts/export_site_data.py:162 | `sort_keys=True` re-orders JSON objects. `site/data/probe_spec.json` lists dials authority, consensus, stakes, stated_confidence; the source has consensus, authority, stated_confidence, stakes. flows.js:112 and :246 follow object order, so the site's dose order differs from Python. Tests avoid this by reading the private file (planner.test.js:27-31). | Export without sorting keys for these two files, and make the tests read the shipped copy. |
| R10 | minor | site/js/shell.js:54-59, 92-99 | With storage blocked, the theme button re-reads "system" each click, so it only ever goes to "light"; the comment at :106 says otherwise. | Keep the current theme in a variable. |
| R11 | minor | engine/runner.js:10-39, 284 | `Math.max(1, limit)` guards the loop count but not the semaphore: concurrency 0 hangs (verified), NaN ends with no work. The semaphore is redundant, since loops already equal the limit. | Check `limit` once, then delete the semaphore. |
| R12 | minor | engine/runner.js:250-254 | `unit-done` and `counts.done` also count units cut short by Stop or a failure. Not sure this is intended. | Count only completed units. |
| R13 | minor | engine/runner.js:118-126 | A refused key (401 or 403) is an ordinary step failure, so the batch keeps sending failing calls. Read from code, not run. | Treat it as fatal and stop the batch. |
| R14 | minor | page-live.js:1007 | After the call cap ends a run the status says "Stopped by you." (the batch page tracks `budgetHit`). | Track the cap in `live` and show the cap message. |
| R15 | minor | engine/flows.js:38 | `Object.freeze(new Set(...))` does not stop `add` or `delete` (verified). | Export a function that returns a new Set. |
| R16 | minor | charts/index.js:756 | `onLeft` is true when the dot is right of the midline; the name says the opposite (tests use it, charts.test.js:85, 113). | Rename to `labelGoesLeft`. |
| R17 | minor | planner.js:115-142; charts/index.js:870-897, 1019; token.js:26-29, 52-55; runner.js:75; export_site_data.py:56 | Dead code: `describeFamilies` and `parseFamilies` (tests only), `sparkline` and helpers (nothing imports), `maskToken` and `masked()` (shell.js no longer shows them), exported `makeReplyRunner`, unused `SAMPLE_FIELDS`. | Delete them; the masked key can only leak. |
| R18 | minor | api.js:173; toast.js:20; adaptive.js:57; grade.js:81-90, 302; charts/index.js:209, 231, 257-259, 448; page-batch.js:642 | Magic numbers (5 retries, 4000 ms, 140, 2.5 and 97.5, `* 1000`, many layout numbers) beside an unused `DEFAULT_TONE` and a long constant block. | Name them; use `DEFAULT_TONE` in toast.js. |
| R19 | minor | engine/grade.js:46-74 | The same six-term polynomial is typed out three times, index by index. | Add one `evaluatePolynomial(coefficients, x)` helper. |
| R20 | minor | page-batch.js:239, 786; page-live.js:760; export_site_data.py:165; check_no_secrets.py:58-61 | Misleading names and comments: `gradeSettings` only validates; "Start was not pressed" is wrong; "see the brief" points outside the code; `find_secret_problem` returns a bool; patterns are called "a" to "d". | Rename (`requireGradeSettings`, `contains_secret`, descriptive pattern names) and fix the comments. |
| R21 | minor | js-tests/runner.test.js:18-20; planner.test.js:29-31; flows.test.js:17-20; grade.test.js:23; token.test.js:38, 43; runner.test.js:236; tests/test_check_no_secrets.py | Tests read private root JSON although js-tests/README.md says fixtures hold the inputs; `readJson` is copied three times; one test is repeated; one assertion accepts two outcomes. Gaps: no page tests (why R1 got through), no `read_project_key`, `netlify.toml` scan or `check_contrast.py` tests. | Add a shared test helper, tighten the assertion, add the missing tests. |
| R22 | minor | page-batch.js:156, 836-870, 1075; page-live.js:674 | Measured 0.63 s on the main thread for one full regrade (1000 resamples, 3 models); it runs on every selection change and on every theme change. | Redraw with the stored options on a theme change; debounce the regrade. |
| R23 | minor | scripts/check_contrast.py:51 | Only the forced dark block is checked; the OS-dark block (tokens.css:82-107) could drift unnoticed. | Check both blocks. |
| R24 | minor | scripts/make_golden.py:461-464, 370-373 and 480-483, 534, 102-119 | Two identical `fp_` and `twin_` branches, `run_flows` called the same way twice, `build_grade` repeats what `with_probe_spec` does, bare numbers 11, 5 and 3. | Merge the branches, add one `run_all_flows` helper, name `NEVER_FLIPS = 11`. |

## Duplicated logic

- Chart-panel set, byte-identical: page-batch.js:939-1069 and page-live.js:509-678.
- `loadJson` page-batch.js:195 = page-gauntlet.js:107 (a third form, `fetchJson`, at page-live.js:49); `CONDITION_LABELS` batch:25 = gauntlet:49; grade-settings check batch:239 and live:58; `errorText` batch:318 = `errorMessage` runner.js:67.
- Three hand-built dialogs: page-live.js:940, page-gauntlet.js:625, token-dialog.js:79.
- Short model name has three versions with different results: batch:308, gauntlet:161, live:88. `readWholeNumber` means two different things (batch:351, live:893).
- "Wrong letter" test: grade.js:144, flows.js:148, page-gauntlet.js:404, page-live.js:135.
- First messages runner.js:42 = flows.js:61; think-block pattern rules.js:22 = adaptive.js:22.
- Secret patterns: export_site_data.py:67 and check_no_secrets.py:58-59 differ in strictness.

## What is good

- Key safety: the key lives only in the vault closure, is sent only by api.js, and goes only to an exact-match host (api.js:180); model text always uses text nodes; tests check that errors and events never carry the key.
- The engine is pure and well covered, with golden fixtures made from the Python reference; most functions are short, with clear names and named message constants.
- Both languages follow the documentation rule closely (docstrings on all Python functions, doc comments on all exported JS functions), with reasons given where the code is not obvious.
