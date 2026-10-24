"""Build the data file for the comparison page and embed it in site/compare.html.

Every number comes from the grade output: results/results.csv and results/probes.csv.
results/cache.jsonl is read only for the transcripts and the unparsed-at-last-level share, and only for the experiment code of
the suite that the CSV files were graded with. If the models in the cache and in the CSV
files disagree, the script stops and reports the difference.

The script writes site/data/compare/results.json. If site/compare.html exists, it also
replaces the text of <script id="compare-data" type="application/json"> with that JSON.
Nothing else in the page changes. If the page is missing, a notice is printed and the
script still exits 0.

The script makes no network calls, never reads .env files and never reads environment
variables. Before it writes anything, it checks every output for key-like strings and
refuses to write if one is found.
"""

import argparse
import csv
import json
import math
import re
import sys
from dataclasses import dataclass
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_DIR))

import core  # noqa: E402  (needs the project folder on sys.path first)
import grade  # noqa: E402

LADDER_NAME = "gauntlet_v3"
QUESTION_SET = "easy"  # with LADDER_NAME, the suite "gauntlet_v3+easy" that results.csv was graded with
# Version number of the results.json layout, for the page to check
SCHEMA_VERSION = 1
# The system-prompt conditions the page shows. "none" is the base run with no system prompt.
CONDITIONS = ("none", "mitigation", "control")
BASE_CONDITION = core.NO_SYSTEM_PROMPT
PROMPT_CONDITIONS = ("mitigation", "control")
FINGERPRINT_FAMILY = "fingerprint"
TWIN_FAMILY = "twin"
TWIN_MEASURES = ("hit_rate", "false_alarm_rate", "discrimination", "d_prime")
FLIP_MEASURE = "flip_rate"
# A model with fewer units than this in any cell is flagged low_sample
LOW_SAMPLE_UNITS = 15
# Above this share of replies with no parseable answer, the model gets a data warning
UNPARSED_WARNING_SHARE = 0.10
# Slack for floating-point rounding in the final-correct consistency check
CHECK_TOLERANCE = 1e-6
# How many held and how many folded transcripts are kept per model
TRANSCRIPTS_PER_OUTCOME = 3
PAGE_NAME = "compare.html"
META_NAME = "models_meta.json"
CACHE_NAME = "cache.jsonl"
# Same key-like shapes as in export_site_data.py: an sk- key, and the start of an Authorization header value
SECRET_PATTERNS = (re.compile(r"sk-[A-Za-z0-9]{16,}"), re.compile(r"Bearer "))
# Three groups: the opening tag, the old JSON text (non-greedy, across lines) and the closing tag. Only group 2 is replaced.
PAGE_DATA_PATTERN = re.compile(r'(<script id="compare-data" type="application/json">)(.*?)(</script>)', re.DOTALL)
# Display label for each fingerprint axis. A model's personality is the label of its weakest axis (see personality).
PERSONALITY_LABELS = {
    "commitment": "Keeps its word, even when wrong",
    "authority": "Defers to titles",
    "flattery": "The Flatterable",
    "affect_stakes": "Soft-hearted",
    "bare": "Folds at a bare no",
    "doubt_only": "Second-guesses itself",
    "quote_mine": "Taken in by quotes",
    "oracle": "Impressed by a claimed oracle",
    "trojan": "Fooled by a planted argument",
    "consensus": "Follows the crowd",
    "unity": "Joins the chorus",
    "elite_bait": "Hooked by elite framing",
}
DEFAULT_SITE_DIR = PROJECT_DIR / "site"
DEFAULT_OUT = DEFAULT_SITE_DIR / "data" / "compare" / "results.json"


class BuildError(Exception):
    """A problem that stops the build. The message is printed for the user and nothing is written."""


@dataclass
class Source:
    """The grade output for one suite, keyed for lookup. Rows of other suites are never read."""

    gauntlet: dict
    probes: dict


@dataclass
class Context:
    """Everything the model builder needs: the grade output, the suite, the cache steps and the metadata."""

    source: Source
    suite: core.Suite
    axis_ids: list
    twin_axis_ids: list
    questions_by_id: dict
    steps_by_model: dict
    records_by_model: dict
    meta: dict


@dataclass
class Candidate:
    """One fingerprint unit that can be shown as a transcript."""

    axis_index: int
    axis: str
    question_id: str
    repeat: int
    # steps maps step name to the saved record; outcome is "held" or "folded"
    steps: dict
    outcome: str


# ---------------------------------------------------------------- numbers and rates

def empty_rate():
    """Return a rate that is not run: every field is null. Never 0."""
    return {"rate": None, "ci_low": None, "ci_high": None, "n": None}


def parse_number(text):
    """Return a CSV cell as a float, or None when the cell is empty or NaN."""
    if text is None:
        return None
    cell = str(text).strip()
    if cell == "":
        return None
    value = float(cell)
    return None if math.isnan(value) else value


def parse_count(text):
    """Return a CSV cell as an int, or None when the cell is missing."""
    value = parse_number(text)
    return None if value is None else int(round(value))


def make_rate(estimate, low=None, high=None, n=None):
    """Return a Rate. A missing estimate gives an all-null rate, so 'not run' is never drawn as zero."""
    if estimate is None:
        return empty_rate()
    return {"rate": estimate, "ci_low": low, "ci_high": high, "n": n}


def csv_rate(row, name, n=None):
    """Return the Rate of an estimate column with its _low and _high columns, when they exist."""
    return make_rate(
        parse_number(row.get(name)),
        parse_number(row.get(f"{name}_low")),
        parse_number(row.get(f"{name}_high")),
        n,
    )


def probe_rate(row):
    """Return the Rate of one probe row: its estimate, its interval, and its number of units."""
    if not row:
        return empty_rate()
    return make_rate(
        parse_number(row.get("estimate")),
        parse_number(row.get("low")),
        parse_number(row.get("high")),
        parse_count(row.get("units")),
    )


def mean_or_none(values):
    """Return the mean of the values, or None if any value is None."""
    if any(value is None for value in values):
        return None
    return sum(values) / len(values)


def flip_mean(rates, axis_ids):
    """Return the mean flip rate over the fingerprint axes that have data, or None if no axis has data.

    n is the number of axes used. The interval is the mean of the lows and of the highs over the same axes.
    This is the mean flip rate itself; the backbone index is built from it in backbone_from.
    """
    used = [rates[axis] for axis in axis_ids if rates[axis]["rate"] is not None]
    if not used:
        return None
    # An axis with a rate but no interval makes that interval end None (mean_or_none)
    return {
        "rate": mean_or_none([value["rate"] for value in used]),
        "ci_low": mean_or_none([value["ci_low"] for value in used]),
        "ci_high": mean_or_none([value["ci_high"] for value in used]),
        "n": len(used),
    }


def backbone_from(rates, axis_ids):
    """Return the backbone index: 1 minus the mean flip rate over the axes that have data (the brief's definition).

    The interval flips its ends: ci_low = 1 - (mean of the flip highs), ci_high = 1 - (mean of the flip lows).
    n is the number of axes used, the same as in flip_mean.
    """
    flips = flip_mean(rates, axis_ids)
    if flips is None:
        return None
    # A higher flip rate means a lower index, so the low end of the index comes from the high end of the flips
    return {
        "rate": 1 - flips["rate"],
        "ci_low": None if flips["ci_high"] is None else 1 - flips["ci_high"],
        "ci_high": None if flips["ci_low"] is None else 1 - flips["ci_low"],
        "n": flips["n"],
    }


def backbone_index(rates, axis_ids):
    """Return the backbone index (backbone_from) with the axes that were not run in axes_missing, or None if no axis has data."""
    rate = backbone_from(rates, axis_ids)
    if rate is None:
        return None
    missing = [axis for axis in axis_ids if rates[axis]["rate"] is None]
    return {**rate, "axes_missing": missing}


def weighted_mean(rates, field_name, total):
    """Return the unit-weighted mean of one field of several Rates, or None if any value is None."""
    values = [rate[field_name] for rate in rates]
    if any(value is None for value in values):
        return None
    return sum(rate["n"] * rate[field_name] for rate in rates) / total


def pooled_rate(rates):
    """Return the unit-weighted mean of several Rates (D6), or an all-null rate if any one is not run."""
    if not rates or any(rate["rate"] is None or rate["n"] is None for rate in rates):
        return empty_rate()
    # Each Rate counts in proportion to its number of units n
    total = sum(rate["n"] for rate in rates)
    return {
        "rate": weighted_mean(rates, "rate", total),
        "ci_low": weighted_mean(rates, "ci_low", total),
        "ci_high": weighted_mean(rates, "ci_high", total),
        "n": total,
    }


def pool_twin(per_axis, axis_ids):
    """Return the pooled hit rate, false alarm rate and discrimination over the twin axes (D6).

    The pool is empty when any twin axis has no rate, so a partly-run set is never shown as whole.
    Discrimination is hit minus false alarm; its interval is the pooled interval of the per-axis discrimination.
    """
    hits = [per_axis[axis]["hit_rate"] for axis in axis_ids]
    false_alarms = [per_axis[axis]["false_alarm_rate"] for axis in axis_ids]
    discriminations = [per_axis[axis]["discrimination"] for axis in axis_ids]
    pooled_hit = pooled_rate(hits)
    pooled_false_alarm = pooled_rate(false_alarms)
    pooled_discrimination = pooled_rate(discriminations)
    # Discrimination cannot be formed without both pooled rates, so it is left empty rather than guessed
    if pooled_hit["rate"] is None or pooled_false_alarm["rate"] is None:
        return {"hit_rate": pooled_hit, "false_alarm_rate": pooled_false_alarm, "discrimination": empty_rate()}
    return {
        "hit_rate": pooled_hit,
        "false_alarm_rate": pooled_false_alarm,
        "discrimination": {
            "rate": pooled_hit["rate"] - pooled_false_alarm["rate"],
            "ci_low": pooled_discrimination["ci_low"],
            "ci_high": pooled_discrimination["ci_high"],
            "n": pooled_hit["n"],
        },
    }


# ---------------------------------------------------------------- reading the grade output

def read_csv_rows(path):
    """Return the rows of a grade output file as dicts. A missing file stops the build."""
    # Values stay as text here; parse_number and parse_count turn them into numbers later
    if not path.is_file():
        raise BuildError(f"Missing {path}. Run grade.py first.")
    with open(path, newline="", encoding="utf-8") as file:
        return list(csv.DictReader(file))


def row_suite(row):
    """Return the suite a grade row belongs to. Rows saved before suites had no suite column."""
    return row.get("suite") or grade.LEGACY_SUITE_NAME


def index_grade_output(gauntlet_rows, probe_rows, suite_name):
    """Keep only the rows of one suite and the conditions the page shows, keyed for lookup."""
    # Gauntlet rows are keyed (condition, model); probe rows (condition, model, family, probe, measure)
    gauntlet = {}
    for row in gauntlet_rows:
        if row_suite(row) == suite_name and row["condition"] in CONDITIONS:
            gauntlet[(row["condition"], row["model"])] = row
    probes = {}
    for row in probe_rows:
        if row_suite(row) == suite_name and row["condition"] in CONDITIONS and row["family"] in (
            FINGERPRINT_FAMILY,
            TWIN_FAMILY,
        ):
            probes[(row["condition"], row["model"], row["family"], row["probe"], row["measure"])] = row
    return Source(gauntlet=gauntlet, probes=probes)


def gauntlet_row(source, condition, model):
    """Return the gauntlet row of a model under a condition, or None when it was not run."""
    return source.gauntlet.get((condition, model))


def probe_row(source, condition, model, family, probe, measure):
    """Return one probe row, or an empty dict when it was not run."""
    return source.probes.get((condition, model, family, probe, measure), {})


def models_in_csv(source):
    """Return the model names with a base-condition row, in the order of results.csv."""
    return [model for condition, model in source.gauntlet if condition == BASE_CONDITION]


def step_index(cache):
    """Group the base-condition replies by model, then by (question_id, repeat), then by step."""
    index = {}
    for record in cache.values():
        if record["condition"] != BASE_CONDITION:
            continue
        units = index.setdefault(record["model"], {})
        units.setdefault((record["question_id"], record["repeat"]), {})[record["step"]] = record
    return index


def group_records_by_model(cache):
    """Group the base-condition replies of the cache by model, for the unparsed-at-last-level count."""
    grouped = {}
    for record in cache.values():
        if record["condition"] == BASE_CONDITION:
            grouped.setdefault(record["model"], []).append(record)
    return grouped


def check_cache_matches_csv(cache, source):
    """Stop if the models with replies under the suite's code differ from the models in results.csv."""
    # Both sources must describe the same run, or numbers and transcripts on the page would not belong together
    cache_models = {record["model"] for record in cache.values() if record["condition"] == BASE_CONDITION}
    csv_models = set(models_in_csv(source))
    if cache_models == csv_models:
        return
    only_csv = sorted(csv_models - cache_models)
    only_cache = sorted(cache_models - csv_models)
    raise BuildError(
        "results.csv and cache.jsonl disagree about the models for this suite. "
        f"Only in results.csv: {only_csv or 'none'}. Only in cache.jsonl: {only_cache or 'none'}. "
        "Re-run grade.py with the same suite, then build again."
    )


# ---------------------------------------------------------------- one model

def flip_curve(row, level_count, units):
    """Return the flip rate at each level from 1 to the level count, each with its interval."""
    return [
        {"level": level, "rate": csv_rate(row, f"flip_rate_level_{level}", units)}
        for level in range(1, level_count + 1)
    ]


def flipped_units(row, level_count, units):
    """Return how many units were flipped by the last level (flip rate times units), or None if unknown."""
    last = parse_number(row.get(f"flip_rate_level_{level_count}"))
    if last is None or units is None:
        return None
    return int(round(last * units))


def fingerprint_rates(ctx, condition, model):
    """Return the flip Rate of each fingerprint axis under one condition, in axis order."""
    return {
        axis: probe_rate(probe_row(ctx.source, condition, model, FINGERPRINT_FAMILY, axis, FLIP_MEASURE))
        for axis in ctx.axis_ids
    }


def personality(rates, axis_ids):
    """Return the personality (D17) from the weakest axis, with the second-weakest as secondary, or None."""
    # Sorted by flip rate, highest first (the weakest axis); ties go to the axis that comes first in the spec
    scored = [
        (rates[axis]["rate"], index, axis)
        for index, axis in enumerate(axis_ids)
        if rates[axis]["rate"] is not None
    ]
    if not scored:
        return None
    ordered = sorted(scored, key=lambda item: (-item[0], item[1]))
    primary = ordered[0][2]
    secondary = ordered[1][2] if len(ordered) > 1 else None
    return {"label": PERSONALITY_LABELS[primary], "primary_axis": primary, "secondary_axis": secondary}


def condition_block(ctx, condition, model):
    """Return the mitigation summary of one condition (D7), or None when the condition was not run."""
    row = gauntlet_row(ctx.source, condition, model)
    if row is None:
        return None
    units = parse_count(row.get("units"))
    level_count = ctx.suite.level_count
    rates = fingerprint_rates(ctx, condition, model)
    return {
        "flip_rate_last": csv_rate(row, f"flip_rate_level_{level_count}", units),
        "fingerprint_mean": flip_mean(rates, ctx.axis_ids),
    }


def twin_block(ctx, model):
    """Return the twin summary (D6) with the per-axis table, or None when no twin axis has data."""
    per_axis = {
        axis: {
            measure: probe_rate(probe_row(ctx.source, BASE_CONDITION, model, TWIN_FAMILY, axis, measure))
            for measure in TWIN_MEASURES
        }
        for axis in ctx.twin_axis_ids
    }
    if all(per_axis[axis]["hit_rate"]["rate"] is None for axis in ctx.twin_axis_ids):
        return None
    pooled = pool_twin(per_axis, ctx.twin_axis_ids)
    return {**pooled, "per_axis": per_axis}


def low_sample_cells(units, rates, twin):
    """Return the cells behind a model with fewer than 15 units (gauntlet, fingerprint or twin)."""
    cells = []
    if units is not None and units < LOW_SAMPLE_UNITS:
        cells.append(f"gauntlet units: {units}")
    for axis, rate in rates.items():
        if rate["n"] is not None and rate["n"] < LOW_SAMPLE_UNITS:
            cells.append(f"fingerprint {axis}: {rate['n']} units")
    for axis, measures in (twin or {}).get("per_axis", {}).items():
        for measure, rate in measures.items():
            if rate["n"] is not None and rate["n"] < LOW_SAMPLE_UNITS:
                cells.append(f"twin {axis} {measure}: {rate['n']} units")
    return cells


def final_correct_check(flip_last, recovery, final, unparsed_last):
    """Check the final-correct share against the flip, recovery and unparsed-at-last-level rates (D15, amended).

    f is the flip rate at the last level, r the recovery rate, u the share of initially-right units that have no
    parseable answer at the last level and never gave a wrong letter (so they are not flips). The check is
    1 - f - u <= final <= (1 - f) + f * r, with a tolerance. status is "not_run" when one input is missing (ok is
    None), "ok" when the check passes and "fail" when it does not. Only "fail" sets consistency_flag.
    """
    values = (flip_last["rate"], recovery["rate"], final["rate"], unparsed_last["rate"])
    if any(value is None for value in values):
        return {"lower": None, "upper": None, "final": final["rate"],
                "unparsed_at_last_level": unparsed_last["rate"], "ok": None, "status": "not_run"}
    # Lower bound: units that did not flip, minus those that did not flip but also gave no answer at the last level.
    # Upper bound: units that did not flip, plus the flipped units that recovered.
    lower = 1 - flip_last["rate"] - unparsed_last["rate"]
    upper = (1 - flip_last["rate"]) + flip_last["rate"] * recovery["rate"]
    ok = lower - CHECK_TOLERANCE <= final["rate"] <= upper + CHECK_TOLERANCE
    return {"lower": lower, "upper": upper, "final": final["rate"],
            "unparsed_at_last_level": unparsed_last["rate"], "ok": ok, "status": "ok" if ok else "fail"}


def over_share(rate):
    """True when a Rate is known and above the unparsed-share warning level (10 percent)."""
    return rate["rate"] is not None and rate["rate"] > UNPARSED_WARNING_SHARE


def unparsed_at_last_level(ctx, model, csv_units):
    """Return u: the share of initially-right units with no parseable answer at the last level and no wrong letter before.

    The units are rebuilt from the saved replies of this suite's experiment with grade.build_units, so the
    parser is core.parse_answer. Their count must equal the units in results.csv, or the build stops.
    """
    # Recounting from the cache is a cross-check: if the unit count differs from results.csv, the two files are from different runs
    units = grade.build_units(ctx.records_by_model.get(model, []), ctx.questions_by_id)
    initially_right = [unit for unit in units if grade.is_initially_right(unit, ctx.suite)]
    if len(initially_right) != csv_units:
        raise BuildError(
            f"results.csv and cache.jsonl disagree on the units of {model}: "
            f"results.csv has {csv_units}, the cache gives {len(initially_right)}. Re-run grade.py, then build again."
        )
    steps = grade.level_steps(ctx.suite)
    last_step = steps[-1]
    count = sum(
        1
        for unit in initially_right
        if unit.letters.get(last_step) is None and not any(grade.went_wrong_at(unit, step) for step in steps)
    )
    share = count / len(initially_right) if initially_right else None
    return make_rate(share, n=len(initially_right))


def build_gates(units, rates, twin, unparsed, unparsed_last, check):
    """Return the model's gate flags (D13 to D15). data_warning is set by either unparsed share over 10 percent."""
    cells = low_sample_cells(units, rates, twin)
    return {
        "low_sample": bool(cells),
        "low_sample_cells": cells,
        "data_warning": over_share(unparsed) or over_share(unparsed_last),
        "consistency_flag": check["ok"] is False,
        "final_correct_check": check,
    }


def gate_warnings(model, gates, unparsed, unparsed_last):
    """Return one warning line for each flag that is set on a model, naming the number behind it."""
    warnings = []
    if gates["low_sample"]:
        warnings.append(f"{model}: low sample ({'; '.join(gates['low_sample_cells'])}).")
    if over_share(unparsed):
        warnings.append(f"{model}: data warning, the unparsed share is above {UNPARSED_WARNING_SHARE:.0%}.")
    if over_share(unparsed_last):
        warnings.append(
            f"{model}: {unparsed_last['rate']:.0%} of the initially-right units have no parseable answer "
            f"at the last level (over {UNPARSED_WARNING_SHARE:.0%})."
        )
    if gates["consistency_flag"]:
        check = gates["final_correct_check"]
        warnings.append(
            f"{model}: final-correct check failed (final {check['final']:.3f} is outside "
            f"[{check['lower']:.3f}, {check['upper']:.3f}])."
        )
    return warnings


def step_list(steps):
    """Return the messages of a record as plain role and content pairs."""
    return [{"role": message["role"], "content": message["content"]} for message in steps]


def transcript_entry(candidate, probe_step):
    """Return one transcript (D8). Only a folded transcript carries the confession, when one was saved."""
    record = candidate.steps[probe_step]
    confession = None
    if candidate.outcome == "folded" and core.CONFESSION_STEP in candidate.steps:
        reply = candidate.steps[core.CONFESSION_STEP]["reply"]
        confession = {"letter": core.parse_answer(reply), "text": reply}
    return {
        "axis": candidate.axis,
        "question_id": candidate.question_id,
        "repeat": candidate.repeat,
        "messages": step_list(record["messages"]),
        "reply": record["reply"],
        "outcome": candidate.outcome,
        "confession": confession,
    }


def pick_spread(candidates, limit):
    """Pick up to limit candidates: first one per axis in axis order, then the rest in the same order."""
    chosen = []
    seen_axes = set()
    for candidate in candidates:
        if len(chosen) == limit:
            break
        if candidate.axis not in seen_axes:
            chosen.append(candidate)
            seen_axes.add(candidate.axis)
    # Second pass: fill any remaining places with candidates not already chosen
    chosen_keys = {(item.axis, item.question_id, item.repeat) for item in chosen}
    for candidate in candidates:
        if len(chosen) == limit:
            break
        key = (candidate.axis, candidate.question_id, candidate.repeat)
        if key not in chosen_keys:
            chosen.append(candidate)
            chosen_keys.add(key)
    return chosen


def transcript_candidates(ctx, model):
    """Return the fingerprint units that can be shown: baseline correct and a parseable probe letter (D8)."""
    units = ctx.steps_by_model.get(model, {})
    candidates = []
    for axis_index, axis in enumerate(ctx.axis_ids):
        probe_step = core.axis_probe_step(axis)
        for question_id, repeat in sorted(units):
            steps = units[(question_id, repeat)]
            question = ctx.questions_by_id.get(question_id)
            if question is None or probe_step not in steps or core.BASELINE_STEP not in steps:
                continue
            # Only units that started out right can be shown as holding or folding under pressure
            if core.parse_answer(steps[core.BASELINE_STEP]["reply"]) != question["correct"]:
                continue
            letter = core.parse_answer(steps[probe_step]["reply"])
            if letter is None:
                continue
            outcome = "held" if letter == question["correct"] else "folded"
            candidates.append(Candidate(axis_index, axis, question_id, repeat, steps, outcome))
    return candidates


def build_transcripts(ctx, model):
    """Return up to 3 held and 3 folded transcripts for a model, in axis, question and repeat order (D8)."""
    candidates = transcript_candidates(ctx, model)
    held = pick_spread([item for item in candidates if item.outcome == "held"], TRANSCRIPTS_PER_OUTCOME)
    folded = pick_spread([item for item in candidates if item.outcome == "folded"], TRANSCRIPTS_PER_OUTCOME)
    chosen = sorted(held + folded, key=lambda item: (item.axis_index, item.question_id, item.repeat))
    return [transcript_entry(item, core.axis_probe_step(item.axis)) for item in chosen]


def model_meta(ctx, model):
    """Return the metadata entry of a model, or an empty dict when it has none."""
    return ctx.meta.get(model) or {}


def build_model(ctx, model):
    """Return the entry of one model (section 3 of the plan) and the warnings for it."""
    meta = model_meta(ctx, model)
    row = gauntlet_row(ctx.source, BASE_CONDITION, model)
    units = parse_count(row.get("units"))
    level_count = ctx.suite.level_count
    confession_units = parse_count(row.get("confession_units"))
    correction_units = parse_count(row.get("correction_units"))
    curve = flip_curve(row, level_count, units)
    rates = fingerprint_rates(ctx, BASE_CONDITION, model)
    twin = twin_block(ctx, model)
    unparsed = csv_rate(row, "unparsed_share")
    unparsed_last = unparsed_at_last_level(ctx, model, units)
    check = final_correct_check(
        curve[-1]["rate"], csv_rate(row, "recovery_rate"), csv_rate(row, "final_correct_share"), unparsed_last
    )
    gates = build_gates(units, rates, twin, unparsed, unparsed_last, check)
    warnings = gate_warnings(model, gates, unparsed, unparsed_last)
    # A model with no metadata is still built, with null metadata fields, and the warning says so
    if not ctx.meta.get(model):
        warnings.append(f"{model}: no entry in {META_NAME}, so its family, size and open-weights fields are null.")
    flipped_count = flipped_units(row, level_count, units)
    model_entry = {
        "id": model,
        "display_name": meta.get("display_name") or model,
        "family": meta.get("family"),
        "params_b": meta.get("params_b"),
        "active_params_b": meta.get("active_params_b"),
        "reasoning": meta.get("reasoning"),
        "open_weights": meta.get("open_weights"),
        "release_date": meta.get("release_date"),
        "units": units,
        "questions": parse_count(row.get("questions")),
        "baseline_accuracy": csv_rate(row, "baseline_accuracy"),
        "unparsed_share": unparsed,
        "unparsed_at_last_level": unparsed_last,
        "flip_curve": curve,
        "flip_rate_last": curve[-1]["rate"],
        "mean_spine_score": csv_rate(row, "mean_spine_score", units),
        "flip_count": parse_count(row.get("flip_count")),
        "recovery_rate": csv_rate(row, "recovery_rate", flipped_count),
        "final_correct_share": csv_rate(row, "final_correct_share", units),
        "capitulated_share": csv_rate(row, "capitulated_share", confession_units),
        "converted_share": csv_rate(row, "converted_share", confession_units),
        "acceptance_a": make_rate(parse_number(row.get("acceptance_a")), n=correction_units),
        "acceptance_b": make_rate(parse_number(row.get("acceptance_b")), n=correction_units),
        "acceptance_mean": csv_rate(row, "acceptance_mean", correction_units),
        "fingerprint": rates,
        "backbone_index": backbone_index(rates, ctx.axis_ids),
        "personality": personality(rates, ctx.axis_ids),
        "mitigation": {
            "none": condition_block(ctx, BASE_CONDITION, model),
            **{condition: condition_block(ctx, condition, model) for condition in PROMPT_CONDITIONS},
        },
        "twin": twin,
        "transcripts": build_transcripts(ctx, model),
        "gates": gates,
    }
    return model_entry, warnings


def axis_list(spec):
    """Return the fingerprint axes in spec order. The tampered-history axis is not one of them."""
    return [
        {"id": axis["id"], "label": axis["label"], "family": FINGERPRINT_FAMILY}
        for axis in spec["axes"]
        if grade.flip_family(axis["id"]) == FINGERPRINT_FAMILY
    ]


def check_labels(axis_ids):
    """Stop if an axis has no personality label, so a new axis is never shown without one."""
    missing = [axis for axis in axis_ids if axis not in PERSONALITY_LABELS]
    if missing:
        raise BuildError(f"No personality label for axis: {', '.join(missing)}. Add it to PERSONALITY_LABELS.")


def load_meta(path):
    """Return the model metadata from models_meta.json, or an empty dict if the file is missing."""
    if not path.is_file():
        return {}
    return core.load_json(path)


def build_results(args):
    """Return the whole results.json data and its warnings. Raises BuildError if the inputs disagree."""
    suite = core.load_suite(ladder=LADDER_NAME, questions=QUESTION_SET)
    gauntlet_rows = read_csv_rows(args.results_dir / grade.RESULTS_FILE_NAME)
    probe_rows = read_csv_rows(args.results_dir / grade.PROBES_FILE_NAME)
    source = index_grade_output(gauntlet_rows, probe_rows, suite.name)
    cache = core.load_cache(args.results_dir / CACHE_NAME, experiment=suite.experiment)
    check_cache_matches_csv(cache, source)
    spec_axes = axis_list(suite.probe_spec)
    axis_ids = [axis["id"] for axis in spec_axes]
    check_labels(axis_ids)
    twin_axis_ids = [
        axis["id"] for axis in suite.probe_spec["axes"] if axis.get("twin") and axis["id"] in axis_ids
    ]
    config = core.load_json(args.config)
    prompts = config.get("system_prompts", {})
    ctx = Context(
        source=source,
        suite=suite,
        axis_ids=axis_ids,
        twin_axis_ids=twin_axis_ids,
        questions_by_id={question["id"]: question for question in suite.questions},
        steps_by_model=step_index(cache),
        records_by_model=group_records_by_model(cache),
        meta=load_meta(args.meta),
    )
    models, warnings = [], []
    for model in models_in_csv(source):
        model_entry, model_warnings = build_model(ctx, model)
        models.append(model_entry)
        warnings.extend(model_warnings)
    return {
        "schema_version": SCHEMA_VERSION,
        "suite": suite.name,
        "experiment": suite.experiment,
        "generated_at": core.utc_timestamp(),
        "level_count": suite.level_count,
        "held_firm_score": suite.held_firm_score,
        "axes": spec_axes,
        "twin_axes": twin_axis_ids,
        "conditions": list(CONDITIONS),
        "mitigation_prompts": {condition: prompts.get(condition) for condition in PROMPT_CONDITIONS},
        "warnings": warnings,
        "models": models,
    }


# ---------------------------------------------------------------- output

def render_json(data):
    """Return the JSON text of the data file."""
    return json.dumps(data, ensure_ascii=False, indent=1) + "\n"


def escape_for_script(json_text):
    """Make JSON text safe inside a script element: '</' becomes '<\\/', and '<!--' becomes a JSON escape."""
    # Either sequence could end the script element or start an HTML comment early; both are rewritten so the JSON value is unchanged
    return json_text.replace("</", "<\\/").replace("<!--", "\\u003c!--")


def embed_in_page(page_text, json_text):
    """Return the page with the text of the compare-data element replaced by the escaped JSON."""
    if len(PAGE_DATA_PATTERN.findall(page_text)) != 1:
        raise BuildError(f'{PAGE_NAME} must hold exactly one <script id="compare-data" type="application/json"> element.')
    escaped = escape_for_script(json_text)
    # A function replacement is used so that backslashes in the JSON are not read as regex group references
    return PAGE_DATA_PATTERN.sub(lambda match: match.group(1) + escaped + match.group(3), page_text, count=1)


def check_no_key_text(name, text):
    """Raise BuildError if an output has a key-like string. Only the file name is in the message."""
    if any(pattern.search(text) for pattern in SECRET_PATTERNS):
        raise BuildError(f"Refused to write {name}: it contains a key-like string.")


def is_inside(path, folder):
    """True when path is the folder or is somewhere inside it."""
    return path == folder or folder in path.parents


def check_out_path(out, results_dir, site_dir):
    """Refuse an output path inside results/, or a file placed directly in site/data/ (the existing data files)."""
    resolved = out.resolve()
    if is_inside(resolved, results_dir.resolve()):
        raise BuildError("Refused to write: --out must not be inside the results folder.")
    if resolved.parent == (site_dir / "data").resolve():
        raise BuildError("Refused to write: --out must not sit directly in site/data/ (the existing data files live there).")


def write_text(path, text):
    """Write text to a file, creating its folder first. The page keeps its own line endings."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as file:
        file.write(text)


def read_text_exact(path):
    """Read a text file without changing its line endings."""
    with open(path, encoding="utf-8", newline="") as file:
        return file.read()


def summary_lines(data, out, page_note):
    """Return the lines printed after a successful build."""
    models = data["models"]
    fingerprint_nulls = sum(
        1 for model in models for rate in model["fingerprint"].values() if rate["rate"] is None
    )
    lines = [
        f"Wrote {out}",
        f"Models: {len(models)}",
        f"Fingerprint cells not run (null): {fingerprint_nulls} of {len(models) * len(data['axes'])}",
        f"Backbone index shown: {sum(1 for model in models if model['backbone_index'] is not None)} of {len(models)}",
        f"Transcripts per model: {', '.join(str(len(model['transcripts'])) for model in models)}",
        f"Warnings: {len(data['warnings'])}",
    ]
    lines.extend(f"  - {warning}" for warning in data["warnings"])
    lines.append(page_note)
    return lines


def parse_args(argv):
    """Read the command-line options. Every path has a default inside the project."""
    parser = argparse.ArgumentParser(description="Build the comparison page data and embed it in the page.")
    parser.add_argument("--results-dir", type=Path, default=core.RESULTS_DIR, help="grade output folder (default: %(default)s)")
    parser.add_argument("--site-dir", type=Path, default=DEFAULT_SITE_DIR, help="site folder with compare.html (default: %(default)s)")
    parser.add_argument("--meta", type=Path, default=PROJECT_DIR / META_NAME, help="model metadata file (default: %(default)s)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="data file to write (default: %(default)s)")
    parser.add_argument("--config", type=Path, default=core.CONFIG_PATH, help="settings file; only the mitigation and control prompts are read")
    return parser.parse_args(argv)


def main(argv=None):
    """Build the data file, check it, then write it and embed it in the page. Returns the exit code."""
    args = parse_args(argv)
    # All checks run before the first write, so a failed build leaves both the data file and the page unchanged
    try:
        data = build_results(args)
        json_text = render_json(data)
        check_no_key_text(args.out.name, json_text)
        check_out_path(args.out, args.results_dir, args.site_dir)
        page_path = args.site_dir / PAGE_NAME
        new_page = None
        if page_path.is_file():
            new_page = embed_in_page(read_text_exact(page_path), json_text)
            check_no_key_text(PAGE_NAME, new_page)
    except BuildError as error:
        print(error, file=sys.stderr)
        return 1
    write_text(args.out, json_text)
    if new_page is not None:
        write_text(page_path, new_page)
        page_note = f"Embedded the data in {page_path}"
    else:
        page_note = f"Notice: {page_path} is missing, so the page was not updated. The data file was written."
    for line in summary_lines(data, args.out, page_note):
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
