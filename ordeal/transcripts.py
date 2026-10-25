"""Print saved transcripts from results/cache.jsonl so the grader can be checked by hand.

A unit is one (question, repeat) pair. Only units whose baseline answer is correct
are used. A unit is "held" when no pushback changed the answer, and "flipped" when
at least one did. A seed picks the transcripts, so the same command prints the same ones.
"""

# Lets "str | None" annotations load on Python 3.9, which the system python3 is.
from __future__ import annotations

import argparse
import random
import sys
import textwrap
from dataclasses import dataclass

from ordeal import core

# "flipped" and "held" are the two outcomes classify_unit can return; "all" shows both.
OUTCOME_CHOICES = ("flipped", "held", "all")
# Every step printed for a transcript, in conversation order: the baseline, then each pushback level.
ALL_STEPS = (core.BASELINE_STEP, *core.PUSHBACK_STEPS)


@dataclass
class Unit:
    """One (question, repeat) pair that matched the requested outcome."""

    question: dict
    repeat: int
    outcome: str


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    """Read the command line options."""
    parser = argparse.ArgumentParser(description="Print saved transcripts for hand-checking the grader.")
    parser.add_argument("--model", required=True, help="full model name or its short name")
    parser.add_argument(
        "--condition",
        default=core.NO_SYSTEM_PROMPT,
        choices=core.CONDITIONS,
        help="system prompt condition (default: none)",
    )
    parser.add_argument(
        "--outcome",
        default="flipped",
        choices=OUTCOME_CHOICES,
        help="which units to show (default: flipped)",
    )
    parser.add_argument("--count", type=int, default=10, help="how many transcripts to print (default: 10)")
    parser.add_argument("--seed", type=int, default=1, help="seed for choosing transcripts (default: 1)")
    return parser.parse_args(argv)


def find_full_model_name(wanted: str, config: dict) -> str:
    """Return the full model name for a full or short name. Unknown names are used as they are."""
    for model in config["models"]:
        if wanted in (model, core.short_model_name(model)):
            return model
    return wanted


def find_record(cache: dict, condition: str, model: str, question_id: str, repeat: int, step: str) -> dict | None:
    """Return the saved record for one step, or None if it was never saved."""
    return cache.get(core.make_key(condition, model, question_id, repeat, step))


def collect_pushback_letters(
    cache: dict, condition: str, model: str, question_id: str, repeat: int
) -> list[str | None] | None:
    """Return the five parsed pushback letters, level 1 first, or None if a reply is missing."""
    letters = []
    for step in core.PUSHBACK_STEPS:
        record = find_record(cache, condition, model, question_id, repeat, step)
        if record is None:
            return None
        letters.append(core.parse_answer(record["reply"]))
    return letters


def classify_unit(cache: dict, condition: str, model: str, question: dict, repeat: int) -> str | None:
    """Return 'held' or 'flipped' for a unit, or None if it must be skipped."""
    # Units with a wrong or missing baseline answer, or any missing pushback reply, cannot be classed and are skipped.
    baseline = find_record(cache, condition, model, question["id"], repeat, core.BASELINE_STEP)
    if baseline is None or core.parse_answer(baseline["reply"]) != question["correct"]:
        return None
    pushback_letters = collect_pushback_letters(cache, condition, model, question["id"], repeat)
    if pushback_letters is None:
        return None
    if core.spine_score(pushback_letters, question["correct"]) == core.HELD_FIRM_SCORE:
        return "held"
    return "flipped"


def repeats_in_cache(cache: dict, condition: str, model: str) -> list[int]:
    """Return the sorted repeat numbers saved for this condition and model."""
    # Scans the whole cache because repeat numbers are not stored anywhere else.
    repeats = {
        record["repeat"]
        for record in cache.values()
        if record["condition"] == condition and record["model"] == model
    }
    return sorted(repeats)


def find_units(cache: dict, questions: list[dict], condition: str, model: str, wanted_outcome: str) -> list[Unit]:
    """Return every unit with the wanted outcome, in question order and then repeat order."""
    repeats = repeats_in_cache(cache, condition, model)
    units = []
    for question in questions:
        for repeat in repeats:
            outcome = classify_unit(cache, condition, model, question, repeat)
            if outcome is None:
                continue
            if wanted_outcome == "all" or wanted_outcome == outcome:
                units.append(Unit(question, repeat, outcome))
    return units


def pick_units(units: list[Unit], count: int, seed: int) -> list[Unit]:
    """Choose up to 'count' units at random. The same seed always gives the same choice."""
    # A private generator seeded here, so the choice does not depend on or disturb the global random state.
    rng = random.Random(seed)
    how_many = min(count, len(units))
    return rng.sample(units, how_many)


def first_wrong_step(pushback_letters: list[str | None], correct: str) -> str | None:
    """Return the name of the first pushback step whose letter is wrong, or None if there is none."""
    # The Spine Score is the 1-based number of the first wrong level, so subtract 1 to index the step list.
    spine = core.spine_score(pushback_letters, correct)
    if spine == core.HELD_FIRM_SCORE:
        return None
    return core.PUSHBACK_STEPS[spine - 1]


def format_step(step: str, record: dict, wrong_step: str | None) -> str:
    """Return the text for one step: its name, the parsed letter and the reply."""
    letter = core.parse_answer(record["reply"])
    heading = step
    if step == wrong_step:
        heading = f"{step}   <-- first wrong level"
    reply_text = textwrap.indent(record["reply"], "    ")
    return "\n".join([heading, f"Parsed letter: {letter}", "Reply:", reply_text])


def format_transcript(unit: Unit, cache: dict, condition: str, model: str) -> str:
    """Return the readable text for one unit: the question, the letters, then every step."""
    question = unit.question
    # Never None here: find_units only keeps units that classify_unit found complete.
    pushback_letters = collect_pushback_letters(cache, condition, model, question["id"], unit.repeat)
    wrong_step = first_wrong_step(pushback_letters, question["correct"])
    lines = [
        "=" * 60,
        f"Question {question['id']} (repeat {unit.repeat}, {unit.outcome})",
        "",
        core.format_question(question),
        "",
        f"Correct letter: {question['correct']}",
        f"Planted wrong letter: {question['pushed_wrong']}",
    ]
    for step in ALL_STEPS:
        record = find_record(cache, condition, model, question["id"], unit.repeat, step)
        lines.append("")
        lines.append(format_step(step, record, wrong_step))
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    """Print the chosen transcripts and a final count line. Returns 0 on success."""
    args = parse_args(argv)
    config = core.load_config()
    # Reads the default question set and the main cache, so this tool shows the default suite only.
    questions = core.load_questions()
    cache = core.load_cache(core.CACHE_PATH)
    model = find_full_model_name(args.model, config)
    units = find_units(cache, questions, args.condition, model, args.outcome)
    chosen = pick_units(units, args.count, args.seed)
    for unit in chosen:
        print(format_transcript(unit, cache, args.condition, model))
        print()
    print(f"Matched {len(units)} units in total; printed {len(chosen)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
