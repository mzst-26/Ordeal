"""Tests for the mixed easy and hard run order (ordeal/mix.py) and its exported files.

These check the rules the mixed run depends on: the same seed gives the same order, every question
appears once, the two sets keep their fixed pushback sets, and the percents add up to 100.
"""

import unittest

from ordeal import core
from ordeal import mix

EASY = core.load_questions(core.DATA_DIR / "questions.json")
HARD = core.load_questions(core.DATA_DIR / "questions_hard.json")


def ids_in_order(slots: list[dict]) -> list[str]:
    """Return the question ids of the slots, in slot order."""
    return [slot["question"]["id"] for slot in slots]


class SameSeedTests(unittest.TestCase):
    """The same seed must always give the same order, so a run can be repeated and checked."""

    def test_same_seed_gives_the_same_order(self) -> None:
        """Two calls with seed 3 give the same ids in the same positions."""
        first = mix.build_mixed_order(EASY, HARD, 3)
        second = mix.build_mixed_order(EASY, HARD, 3)
        self.assertEqual(ids_in_order(first), ids_in_order(second))
        self.assertEqual([slot["question_set"] for slot in first], [slot["question_set"] for slot in second])

    def test_different_seeds_give_different_orders(self) -> None:
        """Seeds 1 to 10 all give a different order, so no two exported files are the same."""
        orders = {tuple(ids_in_order(mix.build_mixed_order(EASY, HARD, seed))) for seed in range(1, 11)}
        self.assertEqual(len(orders), 10)


class OrderContentTests(unittest.TestCase):
    """The order holds every question once, from the right set, with the right pushback set."""

    def setUp(self) -> None:
        """Build the order for seed 1 once for every test in this class."""
        self.slots = mix.build_mixed_order(EASY, HARD, 1)

    def test_all_91_questions_appear_exactly_once(self) -> None:
        """Every easy and hard question is in the order, and none is repeated."""
        expected = sorted(question["id"] for question in EASY + HARD)
        self.assertEqual(len(self.slots), 91)
        self.assertEqual(sorted(ids_in_order(self.slots)), expected)

    def test_counts_are_32_easy_and_59_hard(self) -> None:
        """The easy set has 32 questions and the hard set 59, and the order keeps both totals."""
        easy_slots = [slot for slot in self.slots if slot["question_set"] == "easy"]
        hard_slots = [slot for slot in self.slots if slot["question_set"] == "hard"]
        self.assertEqual(len(easy_slots), 32)
        self.assertEqual(len(hard_slots), 59)

    def test_positions_run_from_1_to_91(self) -> None:
        """Positions are 1-based and in order, so the first slot is position 1."""
        self.assertEqual([slot["position"] for slot in self.slots], list(range(1, 92)))

    def test_pairing_never_changes(self) -> None:
        """Easy questions always use gauntlet_v3 and hard questions always use gauntlet_v4."""
        for slot in self.slots:
            with self.subTest(question=slot["question"]["id"]):
                expected = "gauntlet_v3" if slot["question_set"] == "easy" else "gauntlet_v4"
                self.assertEqual(slot["pushback_set"], expected)

    def test_input_lists_are_not_changed(self) -> None:
        """Building the order leaves the easy and hard lists in their file order."""
        before = [question["id"] for question in EASY]
        mix.build_mixed_order(EASY, HARD, 7)
        self.assertEqual([question["id"] for question in EASY], before)


class CountTests(unittest.TestCase):
    """The counts and percents shown before a run starts."""

    def test_counts_for_the_full_order(self) -> None:
        """32 easy and 59 hard out of 91, with the percents rounded to one decimal."""
        counts = mix.mix_counts(mix.build_mixed_order(EASY, HARD, 1))
        self.assertEqual(counts["total"], 91)
        self.assertEqual(counts["easy"], {"count": 32, "percent": 35.2})
        self.assertEqual(counts["hard"], {"count": 59, "percent": 64.8})

    def test_percents_sum_to_100(self) -> None:
        """The two percents add up to exactly 100.0 for the full order and for a short one."""
        for slots in (mix.build_mixed_order(EASY, HARD, 2), mix.build_mixed_order(EASY[:1], HARD[:2], 2)):
            counts = mix.mix_counts(slots)
            self.assertEqual(round(counts["easy"]["percent"] + counts["hard"]["percent"], 1), 100.0)

    def test_zero_total_is_refused(self) -> None:
        """An empty order has no percents, so counting it is refused with a clear message."""
        with self.assertRaises(ValueError):
            mix.mix_counts([])
        with self.assertRaisesRegex(ValueError, "zero"):
            mix.mix_counts(mix.build_mixed_order([], [], 1))


if __name__ == "__main__":
    unittest.main()
