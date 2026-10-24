# PLAN: Sycophancy Meter, gauntlet v4 and new features

Started: Sat 24 Oct 2026, 09:05 BST. Hackathon start: 10:00 (P0 is the deadline for that).
Orchestrator: Claude (plans, delegates, verifies). Writers: Haiku 5.5 subagents only.
Task list: TaskCreate is not available in this session, so the task list is section 5 of this file.

## 0. Ground rules (from the brief)

- Subagents only. Haiku 5.5. Medium effort, or high for the hard tasks (core, runner, grader, tests, engine, security).
- No paid API calls during build or tests. Tests use the local mock server (`127.0.0.1` only).
- Tests never write to `results/cache.jsonl`, `results/*.csv`, `results/*.png` or `site/data/`. They use temp dirs.
- The key is read only from env `TOKEN_FACTORY_TOKEN`. It never goes into a file, log, test output or the site.
- No git commits. `spine-meter/` is untracked (its git root is `/Users/mobinzaki/Github`).
- Keep the old system: `ladder_v3.json`, `wrappers_v3.json`, `questions.json`, the three static pages, `app.py`, `archive/`, all existing tests.
- Baseline before any change: `scratchpad/snapshot_before/` (copy of this folder without `.venv`). Reviewers diff against it.
- Baseline tests: Python 195 OK, npm 861 pass.

## 1. The paid run that is already going. Do not touch it.

- PID 18431: `runner.py --condition none --probes all --max-calls 11000`, started 08:46. It was launched by an earlier session (F22 in the old task sheet).
- It writes to `results/cache.jsonl` under experiment fingerprint `82f5e58164d9`.
  At 09:03 there were 14,751 cache lines in total, and about 3,600 under that fingerprint.
- Invariants that every task must keep:
  - I1. `core.current_experiment()` for `gauntlet_v3` + `easy` returns `82f5e58164d9`. If it changes, the saved replies are ignored and must be paid for again.
  - I2. Every prompt, message and step rendered for `gauntlet_v3` + `easy` is identical to the baseline snapshot. This covers levels, setup turn, confession, probes, twins, doses and corrections.
  - I3. `runner.py --dry-run` for `gauntlet_v3` + `easy` prints the same counts as the baseline.
  - I4. Nobody kills or restarts PID 18431. Nobody starts a paid run without the user's go-ahead.

## 2. Decisions I took (the user may change them)

- D1. Pushback sets: `gauntlet_v3` = easy pushbacks (10 levels, `ladder_v3.json` + `wrappers_v3.json`). `gauntlet_v4` = hard pushbacks (12 levels, `ladder_v4.json` + `wrappers_v4.json`).
  Question sets: `easy` = `questions.json` (32). `hard` = `questions_hard.json` (59).
  Any pair can be chosen. Both are kept. Nothing is deleted.
- D2. Defaults are `easy` + `gauntlet_v3`, so existing results stay valid. Config keys are `"questions"` and `"ladder"` in `config.json`. CLI flags are `--questions` and `--ladder`.
- D3. "Upload your own pretrained model" is built as: register your own OpenAI-compatible endpoint (https base URL, model name, and a key). In the CLI the key comes from a named env var. On the web it is typed in and kept in memory only, as the Token Factory key is now.
  Uploading weight files is NOT built. It needs a local GPU inference server, which is out of scope for this build. Say so to the user.
- D4. Run persistence on the web is IndexedDB in the browser. Each unit is saved when it finishes. A run resumes after a reload and never repeats saved calls. The CLI already persists to `results/cache.jsonl`.
  Supabase is NOT added. The static Netlify site has no server, and Supabase would need accounts and row-level security for a feature nobody asked to share across devices.
- D5. Configuration presets: named presets (save, load, rename, delete) for single runs (Gauntlet page) and batch runs (Batch page), kept in IndexedDB. A preset holds models, question set, pushback set, probe families, repeats, temperature, max tokens, concurrency, call cap and system-prompt condition.
- D6. CSP trade-off (confirm with the user). A static page can only call a user's own endpoint if `connect-src` allows `https:`. The change is `connect-src 'self' https:` plus the Nebius host. The custom endpoint must be `https`, must have no credentials in the URL, and must be shown on screen before any call. The security reviewer signs this off.
- D7. Level count comes from the ladder file (10 for v3, 12 for v4). Held-firm score is levels + 1 (11 and 13). The user-facing label is "Breaking Point". The column name `spine_score` stays for old scripts.
- D8. The 59 hard keys are verified independently (task T8). A mismatch is reported to the user. Nothing is changed silently.
- D9. The Downloads `adaptive.py` is NOT copied over the project's `adaptive.py`. The project version is newer and is what the v3 replies were made with. Only the v4 axes are added, and the v3 output must stay identical (I2).

## 3. Interface contracts (so parallel tasks agree)

Suite (`core.load_suite(ladder=..., questions=...)`), a plain dict or dataclass with:
`name` ("gauntlet_v3+easy"), `ladder_name`, `question_set`, `ladder` (levels sorted),
`level_count` (int), `held_firm_score` (int), `probe_spec` (dict), `questions` (list), `experiment` (str).

Registries in `core.py`:
- `LADDER_FILES = {"gauntlet_v3": ("ladder_v3.json", "wrappers_v3.json"), "gauntlet_v4": ("ladder_v4.json", "wrappers_v4.json")}`
- `QUESTION_FILES = {"easy": "questions.json", "hard": "questions_hard.json"}`
- `DEFAULT_LADDER = "gauntlet_v3"`, `DEFAULT_QUESTIONS = "easy"` (config.json overrides them).

Functions:
- `current_experiment(suite=None)`: fingerprint. Default suite gives `82f5e58164d9`.
- `load_cache(path=CACHE_PATH, experiment=None)`: reads only that experiment's replies.
- `append_record(record, path)`: unchanged.

Step names (unchanged): `level_0`, `level_{n}` for n in 1..level_count, `setup_{n}` (n is the level that has `setup_turn: true`; v3 gives 4, v4 gives 5), `confession`, `corr_A`, `corr_B`, `fp_{axis}`, `fp_{axis}_setup`, `twin_{axis}`, `dose_{dial}_{i}`.

Saved record keys stay `(condition, model, question_id, repeat, step)`. Records get a `suite` field. Old records have no `suite` field and count as `gauntlet_v3+easy`.

Custom models (config.json): `"custom_models": [{"name": "...", "base_url": "https://...", "model": "...", "api_key_env": "MY_MODEL_KEY"}]`. A custom model runs only when it is named in `--models`. The default list is the three built-in models. A custom model's saved replies are keyed by "name@<8 hex of sha256(base_url, api model)>", so changing its endpoint never reuses old replies.

Test-only override: `runner.py --base-url http://127.0.0.1:<port>` is accepted only for localhost. Tests also pass `--cache <tmp path>`.

## 4. Phases

- P0 (before 10:00): gauntlet v4 runs end to end in the CLI, against the mock. Old v3 path unchanged.
- P1: presets, custom models, persistence, fingerprint probes, calibrate, the Gradio app, security fixes.
- P2: site engine parity, the live page, reviews, docs.

## 5. Task list

Status: todo / doing / done / blocked. A task is done only after its acceptance check passes and the output is shown.

| ID | Task | Owner (model, effort) | Depends on | Files it may touch | Acceptance | Status |
|---|---|---|---|---|---|---|
| B0 | Baseline: fingerprint, rendered v3 steps, dry-run counts, test counts, saved to scratchpad | Haiku, medium | snapshot | none (reads snapshot only) | `scratchpad/baseline/` written; script prints counts | DONE (fingerprint 82f5e58164d9; 976 rows and 4,624 messages in prompts_v3_easy.json; dry run 5,117 new calls max; 195 Python and 861 npm tests pass) |
| T1 | Core: registries, `load_suite`, level count from file, held-firm score, suite-aware fingerprint and cache. Copies the gauntlet input files into the project | Haiku, high | snapshot | `core.py`, `config.json`, new input files, `tests/test_core.py` | I1 holds (`82f5e58164d9`); existing tests pass; new tests for v4 pass | DONE (236 tests OK; fingerprint 82f5e58164d9 verified; load_suite gauntlet_v4+hard gives 12 levels, held 13, 59 questions, experiment 96efc1daaa50; inputs copied with matching hashes; spine_score(held=) must be passed by v4 callers) |
| T2 | Adaptive: v4 axes (`setup_message`, `setup_must_start_with`, reactive variants, erratum, bundle, affect, attrition, format_squeeze, self_consensus). v3 output unchanged | Haiku, high | snapshot (for I2) | `adaptive.py`, `tests/test_adaptive.py` | I2 holds for v3 (golden diff empty); v4 messages render for all 59 hard questions | DONE (52 tests OK; v3 rendered text identical to snapshot on 4,876 entries; fixed a crash when a quoted sentence contains {braces}; the function is adaptive.gauntlet_message) |
| T6 | Mock OpenAI-compatible server for tests (stdlib, 127.0.0.1, scripted replies, error injection, key check) | Haiku, high | none | `tests/mock_server.py`, `tests/test_mock_server.py` | its own tests pass; never leaves a process running | DONE (10 tests OK, rerun by orchestrator; base URL ends in /v1; NO_PROXY must include 127.0.0.1 for the SDK) |
| T8 | Independent check of all 59 hard keys (recomputed without reusing `gen_hard.py`). Report only | Haiku, high | none | `scratchpad/verify_hard/` only | report lists each question PASS or FAIL with evidence | DONE (59 PASS, 0 FAIL, checked by orchestrator; report at scratchpad/T8/report.md. Note: knights wrong_path text is a deliberate false narrative, not a key error) |
| T15 | Run store for the web: IndexedDB adapter plus in-memory adapter, run lifecycle, per-unit checkpoints, resume, delete, export | Haiku, high | none | `site/js/store/*.js`, `js-tests/store.test.js` | store tests pass on the memory adapter; no key field can be written | DONE (892 npm tests pass, rerun by orchestrator; 31 new store tests; IndexedDB CRUD not yet exercised in a browser) |
| T3 | Runner: suite-driven levels, setup turn, reminder, confession, custom models, `--ladder`, `--questions`, `--cache`, localhost-only `--base-url` | Haiku, high | T1, T2 | `runner.py`, `flows.py`, `model_client.py`, `tests/test_runner.py`, `tests/test_flows.py` | I2 and I3 hold for v3; dry-run for v4 prints the counts; unit tests pass | DONE (289 tests OK on orchestrator rerun; I2 identical on all three baseline files, 4,624 + 17,536 + 19,136 messages; I3 dry-run matches snapshot; v4 mock run 126 calls, 0 failures, levels 1 to 12 and setup_5 present; every new record now carries a "suite" field) |
| T5 | Grader: loop over levels, flip count, recovery, final correct, capitulated and converted shares, "Breaking Point" label, per-suite rows, old CSV rows kept | Haiku, high | T1 | `grade.py`, `charts.py`, `map.py`, `tests/test_grade.py`, `tests/test_charts_map.py` | existing grade tests pass; new metric tests pass with hand-made cache rows | DONE (289 tests OK on rerun; v3 default CSV columns and row values identical to snapshot; hand-made v4 cache matches all 22 expected fields; real results/ and site/data untouched) |
| T7 | End-to-end on the mock: 5 hard questions, `gauntlet_v4`, rows for baseline, levels, setup, confession; grade prints the table; v3 path still matches | Haiku, high | T3, T5, T6 | `tests/test_e2e.py` | `python -m unittest` shows the e2e passing; output pasted | DONE (5 e2e tests OK on rerun; v4 flips and confession, v3 default path, 429 retry, localhost refusal; results untouched) |
| T9 | Fingerprint probes: `fingerprint.py` (one axis at a time, fresh conversation), table and radar PNG | Haiku, medium | T3, T5 | `fingerprint.py`, `tests/test_fingerprint.py` | mock run produces the table and PNG in a temp dir | DONE (312 tests OK on rerun; radar is fingerprint_radar_<cond>.png, no clash with charts.py; OPEN: one full-suite failure seen once in about 15 runs, cause not found, not reproduced in 40+ later runs; see log) |
| T10 | Calibrate step: integrate `calibrate.py` (baseline, keep 30-90%, screen), README section | Haiku, medium | T2, T6 | `calibrate.py`, `README.md` | mock run of both modes works in a temp dir | DONE (calibrate and e2e tests OK on rerun; key read through core.read_api_key, as the runner does; Makefile added; missing key exits 1 without writing) |
| T11 | Gradio demo (`app.py`): suite dropdowns, v4 levels, existing replay kept | Haiku, medium | T3, T5 | `app.py`, `tests/test_app.py` | `tests/test_app.py` passes | DONE (311 tests OK on rerun; live demo replies go to results/demo_cache.jsonl, and replay reads it for the same experiment; graded cache.jsonl still 20,487 lines, no demo file created) |
| T14 | Export for the site: suites, hard questions, v4 ladder and probes, grade output with suite | Haiku, medium | T5 | `scripts/export_site_data.py`, `site/data/*` (written by the script only) | export runs; secrets check passes | DONE (4 new site/data files; 9 existing files identical to the post-run baseline; secrets check passed, 57 files; questions_hard.json in site/data drops trap, wrong2 and source_hint on purpose) |
| T13 | Web engine parity: rules, adaptive, flows, planner, grade, runner, api ports for v4 and hard. Golden fixtures regenerated from Python | Haiku, high | T3, T5, T2 | `site/js/engine/*.js`, `scripts/make_golden.py`, `js-tests/*` | `npm test` passes; fixtures match Python | DONE (996 npm and 323 Python tests pass on orchestrator rerun; 5 old fixtures byte-identical; v4 and hard fixtures added; pages still use v3 constants until T16 and T19) |
| T17 | Security fixes S1 to S5 from `SECURITY_REVIEW.md`, plus CSP and endpoint validation for custom models | Haiku, high | T13 — DONE 12:35 (1023 npm tests pass; S1 to S6 closed or verified; custom-endpoint checks and origin guard in api.js; CSP widening REVERTED to Nebius-only pending owner approval, D6) | `site/js/page-gauntlet.js`, `site/js/page-batch.js`, `site/js/engine/api.js`, `netlify.toml`, `js-tests/api.test.js` | findings closed; secrets check passes | todo |
| T16 | Web UI: presets, custom model form, suite selectors, resume-after-reload using T15, level count from data | Haiku, high | T15, T17 — DONE 12:50 (1061 npm and 323 Python tests pass on rerun; presets and resume in site/js/presets.js, saved-runs.js, persistence-ui.js; custom-model form NOT built, pending D6; headless smoke test passed per agent, not re-run by orchestrator) | `site/index.html`, `site/batch.html`, `site/js/page-gauntlet.js`, `site/js/page-batch.js`, `site/js/shell.js`, `site/js/token-dialog.js`, related CSS | manual check in replay; `npm test` passes; no inline script | todo |
| T19 | Live page: level count and suite from data | Haiku, medium | T13 | `site/js/page-live.js`, `site/live.html` | DONE (1023 npm tests pass on orchestrator rerun; no LEVEL_COUNT, PUSHBACK_STEPS or innerHTML left in page-live.js; confession label is fixed text "Confession" because the ladder files have no label; browser check NOT done) |
| T20 | Independent code review (a different agent from every writer). Reads the diff against the snapshot | Haiku, high | all build tasks | `REVIEW.md` (findings only) | findings with file and line, tests re-run | todo |
| T21 | Independent security review of the new code | Haiku, high | T16, T17 | `SECURITY_REVIEW.md` (findings only) | no critical or high open | todo |
| T22 | Full test run and `TEST_REPORT.md`, plus the acceptance checks in section 6 | Haiku, high | T20, T21 | `TEST_REPORT.md` | all green or each failure named | todo |
| T23 | Docs: README, RUNBOOK, DEPLOY for flags, presets, custom models, persistence, decisions | Haiku, medium | T22 | `README.md`, `RUNBOOK.md`, `DEPLOY.md` | commands in the docs run | todo |

## 6. Acceptance checks (the orchestrator runs these and pastes output)

1. `../.venv-spine/bin/python adaptive.py` prints "self-test ok" (or the project's equivalent test passes).
2. Full Python suite and `npm test` pass, including the old tests.
3. Mock end-to-end on 5 hard questions with `gauntlet_v4`: cache rows for baseline, levels, setup and confession. `grade.py` prints Breaking Point, flip count, recovery and capitulated share.
4. `--ladder gauntlet_v3 --questions easy` still runs and grades. Its fingerprint is `82f5e58164d9`.
5. `git grep` and a secrets scan find no key in the project. `scripts/check_no_secrets.py` passes.
6. PLAN.md shows every task done or blocked, with a one-line note each.
7. PID 18431 is still running, and `results/cache.jsonl` is not truncated.

## 7. Log

- 09:05 Plan written. Found the paid run (PID 18431). Decided D1 to D9.
- 15:45 T23 DONE: README, RUNBOOK and DEPLOY updated (new flags, sets, custom models, presets, storage, v4 costs). Spot-checked: no Supabase claims, key shown as a name only, secrets scan passed (83 files). Not verified: the calibration figure "at most 4,012 calls" was carried over from an earlier calculation.
- 15:30 T22 (TEST_REPORT.md) reported one failing Python run (2 errors): a server-startup race in tests/test_compare_browser.py (wait_for_server retries with no sleep), and tests/test_difficulty.py importing difficulty.py while it was being created. Cause: other sessions are editing this folder at the same time (compare page, PLAN_COMPARE.md, difficulty.py, docs/superpowers plans for model details, shuffle mode and page navigation). Re-run at 15:31: npm 1153 pass, Python 421 OK, experiment 82f5e58164d9, cache unchanged. Demo (app.py) restarted on the current code at 15:31 (HTTP 200 on 7860); static site on 8080 (HTTP 200). Not changed by this orchestrator: files owned by other sessions.
- 15:10 T23d DONE: JS "yes" rule matches Python; golden fixtures regenerated (one intended change: "Yesterday I agree" is no longer yes). Full checks on the orchestrator's run: npm 1121 pass, Python 392 OK, experiment 82f5e58164d9, cache md5 unchanged, secrets scan 82 files passed. Launched T22 (TEST_REPORT.md) and T23 (README, RUNBOOK, DEPLOY). Still open for the owner: compare page, .env in repo-root .gitignore, D6 (CSP and custom keys), difficulty decisions, intermittent failures.
- 14:55 T23a DONE and verified: 382 Python tests OK; I1 = 82f5e58164d9; I2 holds; cache unchanged (md5 34cb57d7c30217701e2f08277f55237e, 20,487 lines). Fixed: localhost --base-url needs --cache; custom models only via --models; custom cache key includes the endpoint; "yesterday" is not yes; calibrate key includes the endpoint and default out-dir is scratch/. Follow-up: JS adaptive.js still uses startsWith. T23d launched to port the rule and regenerate golden fixtures.
- 14:35 T23b DONE: one flip-rate definition (grade.axis_flip_row; unreadable replies stay in the denominator, never a flip); fingerprint.py now uses it, so the table matches probes.csv. Three fingerprint rates changed (affect_stakes 0.0943 to 0.0781, flattery 0.1429 to 0.1406, commitment 0.8750 to 0.8077); no paid data affected. Atomic CSV writes; --results-csv and --probes-csv flags back. Open: charts.py --probes-csv not restored. Waiting on T23a (runner and cache keys), which caused one test failure during T23b's run because it was editing model_client.py.
- 14:20 T23c DONE and verified (1116 npm tests pass; the Token Factory key is attached only to the built-in endpoint; custom models refused in the browser; API model id sent in the body; built-in request bodies unchanged). Follow-up: page-batch.js does not pass builtInModels, so the batch page's built-in name-clash guard is inactive (custom entries are refused anyway).
- 14:00 Code review (T20, report at scratchpad/T20/REVIEW_V4.md): 0 blocker, 6 major, 10 minor. Fixes running: T23a (runner requires --cache with --base-url; custom models only when named; custom cache key includes route; adaptive "yes" prefix; calibrate key and NO_PROXY leak), T23b (one flip-rate definition for grade and fingerprint; atomic CSV; make_record default; --results-csv aliases), T23c (browser key only to the built-in endpoint; API model id in body). Invariants I1 and I2 rechecked by the reviewer: unchanged.
- 14:00 NOT IN PLAN, to ask the owner: a comparison page exists (site/compare.html, site/js/compare/*, tests/test_build_compare.py, tests/fixtures/compare/ incl. a cache.jsonl fixture, js-tests/compare-*.test.js). Created 12:34 to 12:36 by a session outside this plan. Not reviewed. Do not ship until its purpose is confirmed.
- 13:45 T22b DONE (browser security fixes; 1114 npm tests). One npm run showed 1 failure, the next four runs had 0 failures. Open intermittent failures: the earlier Python one (310 tests), and this npm one. Likely cause: tests run at the same time as other agents' test runs. Not reproduced when run alone. Re-run the full suite once the reviewer finishes.
- 13:30 T22a DONE and verified: calibrate refuses a remote --base-url (exit 2, no key in output, no folder written); demo binds 127.0.0.1; '#' and control characters refused; Makefile out-dir moved under scratch/. Python suite 328 tests OK. T22b (browser fixes) still running. T20 code review still running.
- 13:20 Security review (T21) found 1 high, 3 medium, 4 low, 4 info. Fix agents launched: T22a (Python: calibrate localhost check [HIGH], demo bind 127.0.0.1, '#' and control characters) and T22b (browser: built-in name clash in engine, fragment and control characters, secret-field normalisation, presets name check, model box check, csv leading space). Left for the owner: (a) /Users/mobinzaki/Github/.gitignore does not ignore Hacktest/.env (outside this project; needs approval to edit); (b) per-endpoint key for custom models, which depends on D6.
- 12:35 T17 DONE. The CSP widening to https: is REVERTED on purpose: connect-src stays Nebius-only until the owner approves D6. Custom endpoints are therefore inert in the browser. T19 DONE (live page on the chosen suite). Launching T16 without the custom-model form (it needs D6).
- 12:12 T13 DONE (verified). Launching T17 (security fixes and custom-endpoint validation) and T19 (live page). T16 (web UI) waits for T17, because both touch page-gauntlet.js and page-batch.js.
- 12:05 OPEN ISSUE: one full-suite run failed ("Ran 310 tests ... FAILED (failures=1)") while other agents were editing test files. Its traceback was not saved. Not reproduced in about 40 later runs. Keep the log next time (python -m unittest discover -s tests -t . > log 2>&1). Re-run the full suite before sign-off.
- 11:37 Session rate limit reset (11:30). The Wave 3 tasks T7, T9, T10, T11, T13 and T14 hit the limit and stopped. All six are resumed and marked doing.
- 11:36 Paid run PID 18431 finished: 9,345 calls, 0 failures, exit 0. Cache under 82f5e58164d9 is complete for this wording. results/ and site/data/ post-run files were written at 10:43 by that run's own grading and export. Those files are the new baseline for "unchanged" checks. Before this, the cache and site data had been changing under the planning, so the snapshot is no longer the reference for site/data.
- 09:45 T5 DONE and rechecked. Wave 3 launched: T7 e2e, T9 fingerprint, T10 calibrate, T11 Gradio, T13 web engine parity, T14 export (adds new site/data files only; existing site/data files must stay byte-identical until the paid run ends).
- 09:40 T3 DONE and rechecked (289 tests OK). Paid run PID 18431 still alive. Open: T5 grader still running.
- 09:30 T15 DONE and rechecked (892 npm tests). T3 (runner) and T5 (grader) launched in parallel, both Haiku high.
- 09:25 T1 and T2 DONE and checked. Known blockers for T3 and T5: flows.run_gauntlet indexes PUSHBACK_STEPS (10 entries, so levels 11 and 12 fail); core.HELD_FIRM_SCORE is 11 (v4 needs 13); calibrate.py calls adaptive.fill, which no longer exists (T10 must fix).
- 09:16 T8 DONE: 59 of 59 hard keys PASS on independent recomputation.
- 09:14 T6 DONE (mock server, 10 tests OK on rerun). Note: the openai SDK honours HTTP(S)_PROXY, so tests that use the mock must set NO_PROXY to include 127.0.0.1.
- 09:12 B0 DONE and checked on disk. Paid run still alive (PID 18431, cache 16,632 lines). core.py is being edited by T1.
- 09:10 Snapshot taken at scratchpad/snapshot_before. Wave 0 launched in parallel (Haiku): B0, T1, T2, T6, T8, T15. Still running; no results yet.
