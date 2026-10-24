"""Tests for shuffle.py: seeded question order and seeded pushback order on the ladder.

The ladder checks use the real ladder files, so a change to a ladder that moves a fixed axis fails here.
"""

import copy
import json
import unittest
from pathlib import Path

import shuffle


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def load_real_ladder(name):
    """Return the ladder dict from a real ladder file in the project root, read with json.load."""
    with open(PROJECT_ROOT / name, encoding="utf-8") as handle:
        return json.load(handle)


def make_questions(count):
    """Return count question dicts with ids q0, q1, ... for order checks."""
    return [{"id": f"q{number}"} for number in range(count)]


def make_ladder(axes):
    """Return a small ladder whose levels 1..N have the given axis ids, in order."""
    return {
        "levels": [
            {"level": number, "axis": axis, "message": f"message {number}"}
            for number, axis in enumerate(axes, start=1)
        ]
    }


class ShuffledQuestionsTests(unittest.TestCase):
    def test_same_seed_same_order(self):
        questions = make_questions(32)
        original = copy.deepcopy(questions)

        first = shuffle.shuffled_questions(questions, 5)
        second = shuffle.shuffled_questions(questions, 5)

        self.assertEqual(first, second)
        self.assertEqual(questions, original)

    def test_different_seed_usually_differs(self):
        questions = make_questions(32)

        first = shuffle.shuffled_questions(questions, 1)
        second = shuffle.shuffled_questions(questions, 2)

        self.assertNotEqual(first, second)

    def test_question_order_is_a_permutation(self):
        questions = make_questions(32)

        shuffled = shuffle.shuffled_questions(questions, 9)

        self.assertEqual(sorted(q["id"] for q in shuffled), sorted(q["id"] for q in questions))


class ShuffleLadderTests(unittest.TestCase):
    def test_pushback_same_seed_same_order(self):
        ladder = load_real_ladder("ladder_v4.json")

        _, first_axes = shuffle.shuffle_ladder(ladder, 7)
        _, second_axes = shuffle.shuffle_ladder(ladder, 7)

        self.assertEqual(first_axes, second_axes)

    def test_fixed_axes_keep_their_slot(self):
        # These slots hold axes whose wording refers to earlier turns, so they must not move.
        # The slot numbers are the level numbers in ladder_v4.json.
        fixed_slots = {
            1: "quote_mine",
            6: "reactive",
            9: "affect",
            10: "attrition",
            11: "attrition",
            12: "format_squeeze",
        }
        ladder = load_real_ladder("ladder_v4.json")

        for seed in range(1, 21):
            with self.subTest(seed=seed):
                _, axes = shuffle.shuffle_ladder(ladder, seed)
                for slot, expected_axis in fixed_slots.items():
                    self.assertEqual(axes[slot - 1], expected_axis)

    def test_movable_slots_hold_the_movable_axes(self):
        ladder = load_real_ladder("ladder_v4.json")
        original_axes = [entry["axis"] for entry in ladder["levels"]]
        movable_slots = [i for i, axis in enumerate(original_axes) if axis in shuffle.SHUFFLABLE_AXES]

        _, axes = shuffle.shuffle_ladder(ladder, 7)
        movable_axes = [axes[i] for i in movable_slots]

        self.assertTrue(all(axis in shuffle.SHUFFLABLE_AXES for axis in movable_axes))
        self.assertEqual(sorted(movable_axes), sorted(original_axes[i] for i in movable_slots))
        self.assertNotEqual(movable_axes, [original_axes[i] for i in movable_slots])

    def test_levels_are_renumbered_to_slots(self):
        ladder = load_real_ladder("ladder_v4.json")

        shuffled, _ = shuffle.shuffle_ladder(ladder, 7)

        for slot, entry in enumerate(shuffled["levels"], start=1):
            with self.subTest(slot=slot):
                self.assertEqual(entry["level"], slot)
                # The default level points back to the entry's place in the input, and every
                # field other than the two level numbers travels with the entry unchanged.
                original = ladder["levels"][entry["default_level"] - 1]
                without_numbers = {k: v for k, v in entry.items() if k not in ("level", "default_level")}
                expected = {k: v for k, v in original.items() if k != "level"}
                self.assertEqual(without_numbers, expected)

    def test_input_ladder_is_not_mutated(self):
        ladder = load_real_ladder("ladder_v4.json")
        original = copy.deepcopy(ladder)

        shuffle.shuffle_ladder(ladder, 7)

        self.assertEqual(ladder, original)

    def test_no_movable_axes_is_unchanged(self):
        ladder = make_ladder(["quote_mine", "reactive", "affect"])

        shuffled, axes = shuffle.shuffle_ladder(ladder, 3)

        self.assertEqual(axes, ["quote_mine", "reactive", "affect"])
        for new_entry, old_entry in zip(shuffled["levels"], ladder["levels"]):
            new_without_default = {k: v for k, v in new_entry.items() if k != "default_level"}
            self.assertEqual(new_without_default, old_entry)

    def test_single_movable_axis(self):
        ladder = make_ladder(["quote_mine", "oracle", "reactive"])

        shuffled, axes = shuffle.shuffle_ladder(ladder, 3)

        self.assertEqual(axes, ["quote_mine", "oracle", "reactive"])
        self.assertEqual(shuffled["levels"][1]["axis"], "oracle")
        self.assertEqual(shuffled["levels"][1]["level"], 2)


if __name__ == "__main__":
    unittest.main()
