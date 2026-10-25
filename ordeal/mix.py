"""Build the mixed run: easy and hard questions in one seeded order, each with its own pushback set.

A mixed run asks the 32 easy questions and the 59 hard questions in a single random order. The order
is chosen by a seed, so the same seed always gives the same order and a run can be repeated or checked.
Each question keeps its own pushback set for the whole run: easy questions always use gauntlet_v3 and
hard questions always use gauntlet_v4. The rules here do no file reading or writing, so the same code can
be checked by tests and used to make the files the browser reads.
"""

import random

# The two question sets, in the order they are counted and printed.
SET_NAMES = ("easy", "hard")
# The pushback set that goes with each question set. It is fixed, so a question never changes its pushbacks mid-run.
PUSHBACK_FOR_SET = {"easy": "gauntlet_v3", "hard": "gauntlet_v4"}


def build_mixed_order(easy_questions: list[dict], hard_questions: list[dict], seed: int) -> list[dict]:
    """Return one slot per question, in the seeded order. Position 1 is the first question asked.

    Each slot holds the question itself, the set it came from, the pushback set it uses, and its
    1-based position. The two input lists are not changed: the pool is a new list built from them.
    """
    # Pair each question with its set first, so the set survives the shuffle without a lookup later.
    pool = [(question, "easy") for question in easy_questions] + [(question, "hard") for question in hard_questions]
    # A private generator, seeded once, so the shuffle does not depend on any other random code in the program.
    generator = random.Random(seed)
    generator.shuffle(pool)
    return [
        {
            "question": question,
            "question_set": question_set,
            "pushback_set": PUSHBACK_FOR_SET[question_set],
            "position": position,
        }
        for position, (question, question_set) in enumerate(pool, start=1)
    ]


def mix_counts(slots: list[dict]) -> dict:
    """Return how many questions each set has, and each set's share as a percent to one decimal.

    The result looks like {"total": 91, "easy": {"count": 32, "percent": 35.2}, "hard": {...}}.
    A total of zero is refused, because a percent of nothing has no meaning and would divide by zero.
    """
    total = len(slots)
    if total == 0:
        raise ValueError("A mixed run needs at least one question, but the total is zero.")
    counts = {name: sum(1 for slot in slots if slot["question_set"] == name) for name in SET_NAMES}
    result = {"total": total}
    running_percent = 0.0
    # The last set takes the rest of the 100, so the rounded percents always add up to exactly 100.
    for index, name in enumerate(SET_NAMES):
        if index < len(SET_NAMES) - 1:
            percent = round(100 * counts[name] / total, 1)
            running_percent += percent
        else:
            percent = round(100 - running_percent, 1)
        result[name] = {"count": counts[name], "percent": percent}
    return result


def order_rows(slots: list[dict]) -> list[dict]:
    """Return the order as plain rows (no question text), for saving in a run record or a file."""
    return [
        {
            "position": slot["position"],
            "id": slot["question"]["id"],
            "question_set": slot["question_set"],
            "pushback_set": slot["pushback_set"],
        }
        for slot in slots
    ]


def order_document(seed: int, easy_questions: list[dict], hard_questions: list[dict]) -> dict:
    """Return the file content for one seed: the seed, its counts and the full order as plain rows.

    The site's exported files and the tests use this, so both are made by the same rule.
    """
    slots = build_mixed_order(easy_questions, hard_questions, seed)
    return {"seed": seed, "counts": mix_counts(slots), "order": order_rows(slots)}
