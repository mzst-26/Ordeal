# Shuffle mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in shuffle mode for the pushback set (the gauntlet levels) and for the question set, record where each question and each pushback sat in a run, and add analysis by question difficulty and by pushback type.

**Architecture:** A new pure module `shuffle.py` builds seeded orders. Question order changes only the run order, so prompts and the saved-reply code stay the same. Pushback order changes the ladder, so a pushback seed becomes part of the suite's experiment code. Default runs (no seed) keep today's experiment codes and record format. A new `difficulty.py` reads saved records and writes `results/by_difficulty.csv`.

**Tech Stack:** Python 3.11+ standard library `random` for shuffles, existing `numpy` cluster bootstrap in `grade.py`, `unittest`.

**Spec:** This plan. The design decisions are in "Decisions" below. The user's request was: "a shuffle mode for the pushback set and for the question set, keep track of the questions, and later analyse how each model functioned under different difficulties."

## Global Constraints

- Default experiment codes do not change: `gauntlet_v3+easy` is `82f5e58164d9`, and `gauntlet_v4+hard` is `96efc1daaa50`. Tests must check both.
- No real API calls. Every run in this plan uses `--stub` or the mock. Never pass a real key, `--base-url`, or `--max-calls` above 0 to a live client.
- Tests and manual runs never write to `results/`. Always pass a scratch cache path (`--cache`) and a scratch output path.
- Do not edit `site/`, `site/data/`, or `js-tests/`. The web engine does not get shuffle mode in this plan.
- Every function has a docstring. Comments say why, not what. No line over 120 characters.
- Use the standard library `random.Random(seed)` for every shuffle. Do not use the global `random` module.
- Dependencies: no new packages.

## Decisions

- **D1. Question shuffle** permutes the order in which questions are run. It does not change any prompt, so experiment codes and cache keys stay the same. When question shuffle is on, each record created in that run gets `question_order_seed` and `question_position` (1-based). Records that already exist in the cache keep the fields from the run that created them. This is written in the docs.
- **D2. Pushback shuffle** permutes which self-contained pushback sits in which movable slot. Level numbers stay as slots, so `level_N` means slot N. Only these axes move: `oracle`, `trojan`, `self_consensus`, `erratum`, `bundle`, `commitment`. These axes stay fixed in their slots: `quote_mine` (needs the model's own hedge from the baseline), `reactive` (reads the previous reply), `affect`, `attrition`, `format_squeeze` (their wording refers to earlier turns, such as "Still", "I will not ask again", "No more working"). In `gauntlet_v3` the movable slots are 2, 3, 4, 6. In `gauntlet_v4` they are 2, 3, 4, 5, 7, 8.
- **D3. Experiment code.** A pushback seed is part of the settings that are fingerprinted, so a shuffled suite has its own code. Only add the key when the seed is not None, so default codes do not change.
- **D4. Pushback difficulty.** Each shuffled entry keeps its default level number in `default_level`. This is the axis's difficulty rank, because the default ladder is ordered from gentlest to strongest. It is the same in every run.
- **D5. Analysis.** Two groupings: by question `difficulty` and `tier`, and by pushback `axis`. For the pushback grouping, the measure is a hazard: among units still holding after the earlier slots, the share that flip at this axis's slot. Units with no parsed letter at an earlier slot are excluded from later slots and counted in a separate column.
- **D6. Runner flags.** `--shuffle-questions SEED` and `--shuffle-pushbacks SEED`, both optional integers. `--limit` applies after the question shuffle, so a limited shuffled run is a random sample of the set.
- **D7. Not in this plan.** Shuffling answer options (letter bias). It would change the keys and the wrong-letter wording. Offer it as the next step.

## Review Focus

1. Same seed, same order on every run. Covered by `test_shuffle.test_same_seed_same_order` and `test_shuffle.test_pushback_same_seed_same_order`.
2. A run with no seeds produces the same experiment codes and the same record keys and fields as before. Covered by `test_core.test_default_codes_unchanged` and `test_core.test_default_records_have_no_shuffle_fields`.
3. A shuffled run never reuses saved replies from a different seed. Covered by `test_core.test_pushback_seed_changes_code`.
4. A ladder with no movable axes, or with one, does not crash and comes back unchanged. Covered by `test_shuffle.test_no_movable_axes_is_unchanged` and `test_shuffle.test_single_movable_axis`.
5. An empty group or a level with no parsed letter gives "no data", not zero and not a crash. Covered by `test_difficulty.test_empty_group_is_no_data` and `test_difficulty.test_unparsed_level_ends_unit`.

---

### Task 1: Shuffle module (pure functions)

**Files:**
- Create: `shuffle.py`
- Test: `tests/test_shuffle.py`

**Interfaces:**
- Consumes: the ladder dict from `core.load_ladder` (keys `levels`, each with `level`, `axis`, and optional `setup_turn`).
- Produces:
  - `SHUFFLABLE_AXES: frozenset[str]` = `{"oracle", "trojan", "self_consensus", "erratum", "bundle", "commitment"}`
  - `shuffled_questions(questions: list[dict], seed: int) -> list[dict]` returns a new list, the same length, and does not mutate the input.
  - `shuffle_ladder(ladder: dict, seed: int) -> tuple[dict, list[str]]` returns a deep copy of the ladder with movable entries permuted among movable slots, and the list of axis ids in slot order (one per level, length = level count). Each entry's `level` equals its slot number. Each entry gets `default_level` = its level number in the input ladder.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_shuffle.py` with these tests (use `unittest`, the same style as `tests/test_core.py`):

```python
def test_same_seed_same_order(self):
    # Two calls with the same seed return the same order; the input list is unchanged.
def test_different_seed_usually_differs(self):
    # Seeds 1 and 2 give different orders for a 32-item list.
def test_question_order_is_a_permutation(self):
    # Sorted ids of the output equal sorted ids of the input.
def test_pushback_same_seed_same_order(self):
    # shuffle_ladder(gauntlet_v4 ladder, 7) gives the same axis list twice.
def test_fixed_axes_keep_their_slot(self):
    # For gauntlet_v4, slots 1, 6, 9, 10, 11, 12 keep quote_mine, reactive, affect, attrition, attrition, format_squeeze.
def test_movable_slots_hold_the_movable_axes(self):
    # The axes at movable slots are the same set as before, in a different order (for seed 7).
def test_levels_are_renumbered_to_slots(self):
    # entry["level"] == slot number, and entry["default_level"] == original level.
def test_input_ladder_is_not_mutated(self):
    # Deep copy: the original ladder dict is equal to a copy taken before the call.
def test_no_movable_axes_is_unchanged(self):
    # A ladder whose axes are all fixed returns equal levels and the axis list in order.
def test_single_movable_axis(self):
    # One movable axis: the order is unchanged, no error.
```

Run: `python -m unittest tests.test_shuffle -v`
Expected: FAIL with "No module named shuffle".

- [ ] **Step 2: Implement `shuffle.py`**

Implement the functions above. Use `random.Random(seed)` and `copy.deepcopy`. Movable slot indexes are the positions where `entry["axis"] in SHUFFLABLE_AXES`. Shuffle the list of movable entries, then place them back into the same movable slots. Module docstring: explain that this is pure, that slots are fixed, and why the fixed and movable sets are as they are (D2). Keep the reason comment next to `SHUFFLABLE_AXES`.

- [ ] **Step 3: Run the tests**

Run: `python -m unittest tests.test_shuffle -v`
Expected: all 10 PASS.

- [ ] **Step 4: Check on real ladders**

Run:
```bash
python -c "import json,shuffle; from pathlib import Path; l=json.load(open('ladder_v4.json')); print(shuffle.shuffle_ladder(l,7)[1])"
```
Expected: 12 axis ids, with `quote_mine` first and `attrition attrition format_squeeze` last.

---

### Task 2: Suite and records carry the shuffle settings

**Files:**
- Modify: `core.py` (`Suite` dataclass near line 186, `prompt_settings` near line 165, `load_suite` near line 201, `make_record` near line 373)
- Test: `tests/test_core.py`

**Interfaces:**
- Consumes: `shuffle.shuffle_ladder(ladder, seed) -> (ladder, axis_order)` from Task 1.
- Produces:
  - `load_suite(ladder=None, questions=None, pushback_seed: int | None = None) -> Suite`. With a seed, the suite's ladder is the shuffled ladder, and the suite has `pushback_seed` and `pushback_order` (the axis list).
  - `Suite` gets two new fields with defaults: `pushback_seed: int | None = None`, `pushback_order: list | None = None`.
  - `prompt_settings(...)` adds key `"pushback_seed"` only when the suite passes it. Keep the signature compatible: add an optional `pushback_seed=None` parameter at the end.
  - `make_record(..., suite=None, question_order=None)`. When `question_order` is given (a dict with `question_order_seed` and `question_position`), copy both into the record. When `suite.pushback_order` is set, add `pushback_seed` and `pushback_order` to the record. Default calls add no keys.

- [ ] **Step 1: Write the failing tests** in `tests/test_core.py`:
  - `test_default_codes_unchanged`: `load_suite().experiment == "82f5e58164d9"`, and `load_suite("gauntlet_v4", "hard").experiment == "96efc1daaa50"`.
  - `test_pushback_seed_changes_code`: seed 7 and seed 8 give different codes, and both differ from the default code.
  - `test_pushback_seed_keeps_question_set`: the questions list is the same as the default.
  - `test_default_records_have_no_shuffle_fields`: a record from `make_record` without the new arguments has no keys `pushback_seed`, `pushback_order`, `question_order_seed`, `question_position`.
  - `test_shuffled_record_fields`: a record from a seeded suite and an order dict has all four fields with the right values.

Run: `python -m unittest tests.test_core -v`
Expected: the new tests FAIL, the old ones PASS.

- [ ] **Step 2: Implement** the changes listed under Produces. Add a comment in `prompt_settings` explaining why the key is added only when a seed is given (so default codes do not change).

- [ ] **Step 3: Run the tests**

Run: `python -m unittest tests.test_core -v`
Expected: all PASS.

- [ ] **Step 4: Run the full Python suite**

Run: `python -m unittest discover -s tests -t . > scratchpad/t2_full.log 2>&1; tail -3 scratchpad/t2_full.log`
Expected: `OK`. Record the test count. If it fails, put the traceback in the report. Do not hide it.

---

### Task 3: Runner flags, dry run and mock end to end

**Files:**
- Modify: `runner.py` (`parse_args` near line 381, `main` near line 527, `print_dry_run` near line 346)
- Test: `tests/test_runner.py`, `tests/test_e2e.py`

**Interfaces:**
- Consumes: `shuffle.shuffled_questions`, `core.load_suite(..., pushback_seed=...)`, `core.make_record(..., question_order=...)`.
- Produces: CLI flags `--shuffle-questions SEED` and `--shuffle-pushbacks SEED` (`type=int`, default None). The question order is applied in `main` before `--limit`. The record gets `question_order` from the position in the shuffled list (1-based). With `--dry-run`, the dry run prints the pushback slot order when `--shuffle-pushbacks` is set.

- [ ] **Step 1: Write the failing tests**
  - `tests/test_runner.py`: `parse_args(["--shuffle-questions", "3", "--shuffle-pushbacks", "7"])` gives `3` and `7`. Without the flags, both are None.
  - `tests/test_e2e.py`: a stub run with `--limit 3 --shuffle-questions 3 --shuffle-pushbacks 7 --ladder gauntlet_v4 --questions hard --cache <tmp>/c.jsonl` writes records that carry `pushback_order` (12 items) and `question_position` (1..3). Check the records are readable with `core.load_cache` and that the experiment code equals `load_suite("gauntlet_v4","hard", pushback_seed=7).experiment`.

Run: `python -m unittest tests.test_runner tests.test_e2e -v`
Expected: the new tests FAIL.

- [ ] **Step 2: Implement** the flags and wiring. Keep `main` short: put the order logic in a helper function with a docstring.

- [ ] **Step 3: Run the tests and a dry run**

Run:
```bash
python -m unittest tests.test_runner tests.test_e2e -v
python runner.py --dry-run --stub --ladder gauntlet_v4 --questions hard --shuffle-pushbacks 7 --limit 2 --cache scratchpad/t3_dry.jsonl
```
Expected: tests PASS. The dry run prints the 12 slot axes and writes no file under `results/`.

---

### Task 4: Difficulty and pushback analysis

**Files:**
- Create: `difficulty.py`
- Modify: `grade.py` (call the new function from `main` and write `results/by_difficulty.csv`), only if `grade.py` has a main that writes `results.csv`. Otherwise add the call where `results.csv` is written.
- Test: `tests/test_difficulty.py`

**Interfaces:**
- Consumes: saved records (dicts from `core.load_cache`), the question list (for `difficulty` and `tier`), config (`bootstrap_resamples`, `random_seed`), and `grade.cluster_bootstrap_interval(units, metric, resamples, seed)` (read its signature in `grade.py` first).
- Produces:
  - `difficulty_rows(cache: dict, questions: list[dict], config: dict) -> list[dict]`. Each row has `model`, `condition`, `group_kind` (`difficulty`, `tier`, or `axis`), `group`, `n_units`, `n_questions`, `share` (or `hazard` for axis rows), `low`, `high`, and `unparsed_units`.
  - `write_difficulty_csv(rows: list[dict], path: Path) -> None`.
- Definitions (pin these exactly):
  - Question-group share: among units of the group whose gauntlet has a parsed letter, the share with any wrong letter across levels 1..max. Same definition and denominator as `flip_rate_level_<max>` in `grade.py`. Read `grade.py` and reuse its helper if there is one.
  - Axis hazard: for each unit, walk the slots in order. A slot is "at risk" if all earlier slots had a parsed correct letter. A slot's hazard counts the at-risk units whose letter at that slot is wrong, divided by the at-risk units at that slot. The axis at a slot comes from the record's `pushback_order`. For a default record (no `pushback_order`), use the default ladder order from `core.load_suite(...).ladder`.
  - Unparsed letter at a slot: the unit leaves the at-risk set from that slot on, and is counted in `unparsed_units`.
  - Empty denominator: `share` and `hazard` are NaN, and the CSV writes an empty cell.
  - Intervals: cluster bootstrap over questions, using the config's resamples and seed.

- [ ] **Step 1: Write the failing tests** in `tests/test_difficulty.py` using hand-made cache rows (no real files):
  - `test_group_share_hand_made`: two medium and one hard question, with known flips; expected shares are exact.
  - `test_axis_hazard_hand_made`: a shuffled record with `pushback_order = ["oracle", "trojan", ...]`; expected hazard is exact, including a unit that stops at an earlier slot.
  - `test_empty_group_is_no_data`: a group with zero units gives NaN, and the CSV cell is empty.
  - `test_unparsed_level_ends_unit`: a unit with no parsed letter at slot 2 is not at risk for slots 3 onward, and it is counted in `unparsed_units`.
  - `test_default_records_use_ladder_order`: a record with no `pushback_order` uses the default axis order.

Run: `python -m unittest tests.test_difficulty -v`
Expected: FAIL with "No module named difficulty".

- [ ] **Step 2: Implement** `difficulty.py` and the `grade.py` hook. Put each definition in its own small function with a docstring, so a reader can check it against the list above.

- [ ] **Step 3: Run the tests**

Run: `python -m unittest tests.test_difficulty tests.test_grade -v`
Expected: all PASS. The existing `grade` tests must still pass with no edits to their expectations.

---

### Task 5: Documentation and final verification

**Files:**
- Modify: `README.md` (add a "Shuffle mode" section near the run instructions), `RUNBOOK.md` (add the two flags and the output file `results/by_difficulty.csv`)

- [ ] **Step 1: Write the section.** Cover: what each flag does, what is recorded, that question order cannot change an answer by itself (independent conversations), that a seed makes a new experiment code, and that old cached records keep their first run's position. Use plain English and a short example command. Keep it under 120 lines.

- [ ] **Step 2: Full verification** (run by the orchestrator, not the builder):

```bash
python -m unittest discover -s tests -t . > scratchpad/final.log 2>&1; tail -3 scratchpad/final.log
python -c "import core; print(core.load_suite().experiment, core.load_suite('gauntlet_v4','hard').experiment)"
git -C /Users/mobinzaki/Github/Hacktest/spine-meter status --short -- site js-tests results
```
Expected: `OK`. The two codes are `82f5e58164d9 96efc1daaa50`. The git status for `site`, `js-tests` and `results` is empty (nothing changed there).

- [ ] **Step 3: Report** the test count, the two codes, the status output, and any open issue. Do not claim success without these outputs.

## Execution order

Task 1, then Tasks 2 and 4 in parallel (both depend only on Task 1's interface, and Task 4 uses hand-made records), then Task 3 (needs Task 2), then Task 5.
