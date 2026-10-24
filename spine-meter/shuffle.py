"""Seeded shuffles for the question set and for the pushback ladder.

Everything here is a pure function: it takes data and a seed, and returns new data.
The input is never changed, so the same seed always gives the same order and the
saved data on disk is never reordered by accident.
"""

import copy
import random


# Only these six axes can move to another slot, because each one is a self-contained
# pushback that still makes sense in any position. The other axes stay in their slots,
# because their wording refers to earlier turns:
#   quote_mine      needs the model's own hedge from the baseline reply.
#   reactive        reads the model's previous reply.
#   affect          refers to earlier turns.
#   attrition       wording like "I will not ask again" refers to earlier turns.
#   format_squeeze  wording like "Still" and "No more working" refers to earlier turns.
SHUFFLABLE_AXES = frozenset({"oracle", "trojan", "self_consensus", "erratum", "bundle", "commitment"})


def shuffled_questions(questions, seed):
    """Return a new list with the same questions in a seeded random order.

    The list is copied before shuffling, so the caller's list keeps its original order.
    Questions are copied too, so a later change to the result cannot reach the input.
    """
    order = copy.deepcopy(questions)
    # A private Random object, not the global one, so other code that uses random is not affected.
    random.Random(seed).shuffle(order)
    return order


def shuffle_ladder(ladder, seed):
    """Return (new_ladder, axis_order) with the movable pushbacks put in a seeded random order.

    Only the slots whose axis is in SHUFFLABLE_AXES are permuted, so the fixed axes stay
    where they are. Each entry's "level" is set to its new slot number (1-based), because the
    rest of the code reads level N as slot N. Each entry also keeps "default_level", its level
    number in the input ladder, which is its difficulty rank: the default ladder runs from the
    gentlest pushback to the strongest.

    axis_order lists the axis id of each slot in order, so a run can record which pushback sat
    where. A ladder with no movable axes, or with one, comes back in the same order.
    """
    new_ladder = copy.deepcopy(ladder)
    entries = new_ladder["levels"]

    # Record each entry's input level before any renumbering below.
    for entry in entries:
        entry["default_level"] = entry["level"]

    movable_slots = [slot for slot, entry in enumerate(entries) if entry["axis"] in SHUFFLABLE_AXES]
    movable_entries = [entries[slot] for slot in movable_slots]
    random.Random(seed).shuffle(movable_entries)
    for slot, entry in zip(movable_slots, movable_entries):
        entries[slot] = entry

    for slot, entry in enumerate(entries):
        entry["level"] = slot + 1

    axis_order = [entry["axis"] for entry in entries]
    return new_ladder, axis_order
