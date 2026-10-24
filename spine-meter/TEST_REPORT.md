# TEST_REPORT (T26)

Date: 2026-10-24

Project: spine-meter. Python: `/Users/mobinzaki/Github/Hacktest/.venv-spine/bin/python`. Exit codes were captured directly (the shell is zsh).

| Check | Command | Result | Detail |
|---|---|---|---|
| a | `npm test` | pass | 860 pass, 0 fail, 860 total (exit 0) |
| b | `python -m unittest discover -s tests -t .` | pass | Ran 194 tests, OK (exit 0) |
| c | `scripts/export_site_data.py` | pass | exit 0; 9 data files written |
| d | `scripts/check_no_secrets.py --no-env-check` | pass | Secrets check passed: 49 files scanned (exit 0) |
| e | `scripts/check_no_secrets.py --root .` | pass | Secrets check passed: 49 files scanned (exit 0) |
| f | `scripts/check_contrast.py` | pass | 42 of 42 pairs passed (exit 0) |
| g | `scripts/make_golden.py` run twice, SHA-256 of `js-tests/fixtures/*.json` | pass | 5 fixtures; run 1 changed none; run 2 identical to run 1 |
| h | awk line length over 120 on the listed globs | pass | No lines over 120 |
| i | `node --check` on all `site/js/**/*.js` | pass | 25 files, 0 failures |
| j | grep for `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval(`; grep for `style=` in `site/*.html` and `site/js/` | pass | No matches |
| k | grep for `sk-[A-Za-z0-9]{16,}` or `Bearer ` in `site/` | fail | 2 files matched; see below |

## Failures

1. **Check k (key scan).** Two files matched, and neither contains a key literal (values masked when inspected):
   - `site/design/API_DECISION.md:18`: documentation text that names the `Authorization: Bearer` header. Cause: the regex matches the literal text "Bearer ".
   - `site/js/engine/api.js:185`: `'Bearer ' + context.token`. Cause: the same literal text, with the token supplied at runtime. Cause for the match is clear; whether the page should ship this header pattern is a design question.

   The secrets scanner (checks d and e) passed on the same tree.

No other check failed.

## Golden fixtures

The golden fixtures are unchanged: the first `make_golden.py` run changed no file compared with the pre-run SHA-256 values, and the second run produced hashes identical to the first.

## Notes

- CSS edit (step 1): added `.swatch-repeat.swatch-1`, `.swatch-repeat.swatch-2` and `.swatch-repeat.swatch-3` to `site/css/page-live.css`. Each sets `outline: 1px dashed var(--cat-N)` with `outline-offset: 2px`. An outline is used instead of a border because a dashed border in the same colour as the fill would not be visible. No new colours were added.
- The `ai-toolkit:testing-strategies` skill covers Kotlin/Micronaut backend testing and does not apply to this Python/Node project. It was loaded, but its guidance was not used.

---

# TEST_REPORT (T22): full suites and PLAN.md section 6 acceptance checks

Date: 2026-10-24, run between about 12:52 and 12:55 BST. Project: `/Users/mobinzaki/Github/Hacktest/spine-meter`. Python: `/Users/mobinzaki/Github/Hacktest/.venv-spine/bin/python`. Logs are in `/private/tmp/claude-501/-Users-mobinzaki-Github-Hacktest/0fd03ae6-325a-46ee-9906-4d98d6f484df/scratchpad/T22/`.

No paid API call was made. No source, test, fixture or data file was edited. No process was killed or restarted.

## Test totals

| Run | npm test (tests / pass / fail) | Python (Ran / result) |
|---|---|---|
| 1 (about 12:52) | 1148 / 1148 / 0 | Ran 392 tests, OK |
| 2 (12:53) | 1153 / 1153 / 0 | Ran 400 tests, FAILED (errors=2) |

The test counts rose between runs (npm 1148 to 1153; Python 392 to 400). Other work was adding test files while these runs were in progress, so the totals are not from a fixed tree.

## Acceptance checks

| Check | Command | Verbatim result |
|---|---|---|
| a | `../.venv-spine/bin/python -c "import core; print(core.current_experiment())"` | `82f5e58164d9` (matches invariant I1) |
| b | Full Python suite, run 1 | `Ran 392 tests in 20.999s` then `OK` (exit 0) |
| b | Full Python suite, run 2 | `Ran 400 tests in 21.120s` then `FAILED (errors=2)` (exit 1). See the intermittent failure below. |
| c | Full npm suite, run 1 | `ℹ tests 1148`, `ℹ pass 1148`, `ℹ fail 0` (exit 0) |
| c | Full npm suite, run 2 | `ℹ tests 1153`, `ℹ pass 1153`, `ℹ fail 0` (exit 0) |
| d | `../.venv-spine/bin/python -m unittest tests.test_e2e -v` | `Ran 5 tests in 7.315s` then `OK` (exit 0). The five tests passed: default v3 run with ten flip columns, v4 saves every step, grade writes flip rate and Breaking Point, non-local base URL exits 2 and sends nothing, one 429 is retried and the run finishes. |
| e | `../.venv-spine/bin/python scripts/check_no_secrets.py` | Last line: `Secrets check passed: 83 files scanned.` (exit 0) |
| f | `md5 -q results/cache.jsonl` | `34cb57d7c30217701e2f08277f55237e` (matches expected) |
| f | `wc -l < results/cache.jsonl` | `20487` (matches expected) |
| g | `ps -p 18431` | Header line only (`PID TTY TIME CMD`), exit 1: no process with PID 18431 is running. |

Note on g: PLAN.md section 6 item 7 expects PID 18431 to still be running. This task expected it to have finished at 10:43. The observed result matches this task's expectation. The cache line count and md5 are unchanged from the expected values, so the cache was not truncated. I did not check the run's own log to confirm how it ended.

Note on f: the expected values matched, so no difference to report.

## Intermittent failure (run 2)

Run 1 passed. Run 2 had two errors, both at import or setup time, not in the assertions:

1. `ERROR: setUpModule (tests.test_compare_browser)`: `RuntimeError: The local server did not answer at http://127.0.0.1:56717/compare.html: <urlopen error [Errno 61] Connection refused>`.
   Likely cause (a hypothesis, not reproduced): `wait_for_server` in `tests/test_compare_browser.py` retries 50 times. A refused connection returns at once, so the retries do not wait for the `http.server` subprocess to bind. The retries can finish in well under a second, before the server is up. The one-second timeout applies only when a connection hangs, so it does not cover this case. A short sleep between attempts would be the usual fix. This was not changed.
2. `ERROR: tests.test_difficulty`: `ModuleNotFoundError: No module named 'difficulty'`. `tests/test_difficulty.py` was modified at 12:52:39, and `difficulty.py` did not exist yet when run 2 imported it. It was created at 12:53:45, during the run. This is concurrent work by another task, not a flake in a stable tree. Re-check it in the next run.

This run was not repeated a third time, following the task steps. The cause of the intermittent failure is not confirmed.

## Open items

- Intermittent failure: the `wait_for_server` race above is the likely cause for the compare-browser error. The `difficulty` error is caused by a file that was being written during the run.
- Compare-page tests (`tests/test_compare_browser.py`, `site/compare.html`): these belong to a feature that is not in PLAN.md.
- Custom-model form: not built.
- CSP decision D6: still pending.
- Batch page `builtInModels` follow-up: still open.

## Not verified in a browser

- The compare-page browser test (`tests/test_compare_browser.py`) was the only browser test in these runs. It ran in run 1, through Playwright and Chromium, and was not run again after run 2 failed at its setup.
- No page was opened in a browser by this task. This covers the three static pages, the compare page, the batch page, the live site and mobile layouts.
- The custom-model form and the CSP header were not checked, because the form is not built and D6 is pending.
- PLAN.md section 6 items 1 (`adaptive.py` self-test), 4 (`--ladder gauntlet_v3 --questions easy` run) and 6 (PLAN.md task status) were not run by this task. Item 3 is covered only by the e2e tests, which use the mock server.
