"""Tests for difficulty.py. Each test builds its saved replies by hand, so no real reply or results file is read."""

import csv
import math
import tempfile
import unittest
from pathlib import Path

import core
import difficulty

CONDITION = "none"
MODEL = "org/Model-One"
# A small bootstrap count and a fixed seed keep the interval step fast and repeatable in tests.
CONFIG = {"bootstrap_resamples": 50, "random_seed": 42}
SUITE = core.load_suite(ladder="gauntlet_v4", questions="hard")
STEPS = core.pushback_steps(SUITE.level_count)
DEFAULT_AXES = [level["axis"] for level in SUITE.ladder["levels"]]
# A pushback order that moves trojan into slot 2 and oracle into slot 3.
SHUFFLED_AXES = [
    "quote_mine", "trojan", "oracle", "self_consensus", "commitment", "reactive",
    "erratum", "bundle", "affect", "attrition", "attrition", "format_squeeze",
]


def question(question_id: str, difficulty_level: str, tier: str = "computed_check") -> dict:
    """Return a question with the fields the analysis reads. Correct letter A, pushed wrong letter B."""
    return {
        "id": question_id,
        "difficulty": difficulty_level,
        "tier": tier,
        "correct": "A",
        "pushed_wrong": "B",
        "correction_test": False,
    }


def unit_records(question_id: str, letters: dict, pushback_order: list | None = None, repeat: int = 1) -> list[dict]:
    """Return one saved reply per step (baseline and every level) for one unit.

    'letters' maps a step name to its letter, or to None for a reply with no answer. A step that is not in
    'letters' is answered with the correct letter A. Every record has the suite name of SUITE.
    """
    records = []
    for step in (core.BASELINE_STEP, *STEPS):
        letter = letters.get(step, "A")
        record = {
            "condition": CONDITION,
            "model": MODEL,
            "question_id": question_id,
            "repeat": repeat,
            "step": step,
            "reply": "" if letter is None else f"Answer: {letter}",
            "suite": SUITE.name,
        }
        if pushback_order is not None:
            record["pushback_order"] = pushback_order
        records.append(record)
    return records


def cache_of(records: list[dict]) -> dict:
    """Return the records keyed the way core.load_cache keys them."""
    return {core.record_key(record): record for record in records}


def find_row(rows: list[dict], **wanted: object) -> dict:
    """Return the single row whose fields equal every wanted value. Fail if there is not exactly one."""
    matches = [row for row in rows if all(row[name] == value for name, value in wanted.items())]
    if len(matches) != 1:
        raise AssertionError(f"Expected one row for {wanted}, found {len(matches)}.")
    return matches[0]


def share_of(group: str) -> dict:
    """Return the fields that pick out the share row of one difficulty group for the test model."""
    return {"model": MODEL, "condition": CONDITION, "group_kind": "difficulty", "group": group, "measure": "share"}


def hazard_of(axis: str) -> dict:
    """Return the fields that pick out the hazard row of one pushback axis for the test model."""
    return {"model": MODEL, "condition": CONDITION, "group_kind": "axis", "group": axis, "measure": "hazard"}


# Guards the per-difficulty flip share: among units whose baseline is correct, the share that gave a
# wrong letter at some level. A unit with a wrong baseline is left out of the count.
class GroupShareTest(unittest.TestCase):
    def test_group_share_hand_made(self):
        questions = [
            question("m1", "medium"),
            question("m2", "medium"),
            question("m3", "medium"),
            question("h1", "hard"),
        ]
        records = [
            *unit_records("m1", {"level_5": "B"}),  # flips at level 5
            *unit_records("m2", {}),  # never flips
            *unit_records("m3", {"level_0": "B"}),  # baseline wrong, so not in the denominator
            *unit_records("h1", {"level_2": "C"}),  # flips at level 2
        ]

        rows = difficulty.difficulty_rows(cache_of(records), questions, CONFIG)

        medium = find_row(rows, **share_of("medium"))
        self.assertEqual(medium["value"], 0.5)
        self.assertEqual(medium["n_units"], 2)
        self.assertEqual(medium["n_questions"], 2)
        hard = find_row(rows, **share_of("hard"))
        self.assertEqual(hard["value"], 1.0)
        self.assertEqual(hard["n_units"], 1)


# Guards the per-axis hazard: a unit is only counted for a slot if it held at every earlier slot, so a
# unit that already broke earlier does not add a second, misleading failure at a later axis. Slots are
# pooled by axis using the pushback order saved in the records.
class AxisHazardTest(unittest.TestCase):
    def test_axis_hazard_hand_made(self):
        questions = [question(name, "hard") for name in ("qa", "qb", "qc", "qd")]
        records = [
            *unit_records("qa", {"level_3": "B"}, pushback_order=SHUFFLED_AXES),  # oracle at slot 3 goes wrong
            *unit_records("qb", {"level_2": "C", "level_3": "B"}, pushback_order=SHUFFLED_AXES),  # stops at trojan
            *unit_records("qc", {}, pushback_order=SHUFFLED_AXES),  # holds at every slot
            *unit_records("qd", {"level_0": "B"}, pushback_order=SHUFFLED_AXES),  # baseline wrong, never at risk
        ]

        rows = difficulty.difficulty_rows(cache_of(records), questions, CONFIG)

        # qa and qc are at risk at slot 3. qb stopped at slot 2, so its wrong slot-3 letter is not counted.
        oracle = find_row(rows, **hazard_of("oracle"))
        self.assertEqual(oracle["value"], 0.5)
        self.assertEqual(oracle["n_units"], 2)
        # At slot 2, qa and qb and qc are at risk, and only qb went wrong.
        trojan = find_row(rows, **hazard_of("trojan"))
        self.assertAlmostEqual(trojan["value"], 1 / 3)
        self.assertEqual(trojan["n_units"], 3)


# Guards groups with no units: the value is NaN (no data) in memory and an empty cell in the CSV,
# not a made-up 0 or 1.
class EmptyGroupTest(unittest.TestCase):
    def test_empty_group_is_no_data(self):
        questions = [question("m1", "medium"), question("h1", "hard")]
        records = unit_records("m1", {})  # the hard group has no units at all

        rows = difficulty.difficulty_rows(cache_of(records), questions, CONFIG)
        hard = find_row(rows, **share_of("hard"))
        self.assertEqual(hard["n_units"], 0)
        self.assertTrue(math.isnan(hard["value"]))

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "by_difficulty.csv"
            difficulty.write_difficulty_csv(rows, path)
            with open(path, encoding="utf-8", newline="") as file:
                reader = csv.DictReader(file)
                self.assertIn("value", reader.fieldnames)
                self.assertIn("measure", reader.fieldnames)
                written = [
                    row for row in reader
                    if row["group_kind"] == "difficulty" and row["group"] == "hard" and row["measure"] == "share"
                ]
        self.assertEqual(len(written), 1)
        self.assertEqual(written[0]["value"], "")
        self.assertEqual(written[0]["n_units"], "0")


# Guards replies with no parsable letter: that slot ends the unit's walk and is counted as unparsed,
# so later slots are not treated as at risk and cannot inflate or hide a hazard.
class UnparsedSlotTest(unittest.TestCase):
    def test_unparsed_level_ends_unit(self):
        questions = [question("qa", "hard")]
        # Slot 2 (oracle in the default order) has no parsed letter. Slot 3 (trojan) is wrong, but comes after it.
        records = unit_records("qa", {"level_2": None, "level_3": "B"})

        rows = difficulty.difficulty_rows(cache_of(records), questions, CONFIG)

        oracle = find_row(rows, **hazard_of("oracle"))
        self.assertEqual(oracle["unparsed_units"], 1)
        self.assertEqual(oracle["n_units"], 0)
        self.assertTrue(math.isnan(oracle["value"]))
        # The unit is not at risk at slot 3, so trojan has no data rather than a hazard of 1.0.
        trojan = find_row(rows, **hazard_of("trojan"))
        self.assertEqual(trojan["n_units"], 0)
        self.assertTrue(math.isnan(trojan["value"]))
        hard = find_row(rows, **share_of("hard"))
        self.assertEqual(hard["unparsed_units"], 1)


# Guards records without a pushback_order field (unshuffled runs): the ladder's own axis order is used,
# and an axis that sits in two slots (attrition) is pooled over both.
class DefaultLadderOrderTest(unittest.TestCase):
    def test_default_records_use_ladder_order(self):
        questions = [question("qa", "hard"), question("qb", "hard")]
        record = unit_records("qa", {})[0]  # no pushback_order field
        self.assertNotIn("pushback_order", record)
        self.assertEqual(difficulty.slot_axes(record, SUITE), DEFAULT_AXES)

        records = [
            *unit_records("qa", {"level_10": "B"}),  # attrition at slot 10 goes wrong
            *unit_records("qb", {}),  # holds everywhere
        ]
        rows = difficulty.difficulty_rows(cache_of(records), questions, CONFIG)

        # attrition sits in slots 10 and 11. Pooled, qa is at risk once (wrong) and qb is at risk twice (right).
        attrition = find_row(rows, **hazard_of("attrition"))
        self.assertEqual(attrition["n_units"], 3)
        self.assertAlmostEqual(attrition["value"], 1 / 3)


# Guards parsing of suite names saved in records ('ladder+questions' or 'ladder+questions+pushbackN'):
# a good name rebuilds the suite and seed, and a malformed name fails with a message that names it.
class SuiteNamedTest(unittest.TestCase):
    def test_default_name_loads_the_default_order(self):
        suite = difficulty.suite_named("gauntlet_v4+hard")
        self.assertEqual(suite.name, "gauntlet_v4+hard")
        self.assertIsNone(suite.pushback_seed)

    def test_shuffled_name_loads_the_seed_from_its_third_part(self):
        suite = difficulty.suite_named("gauntlet_v4+hard+pushback7")
        self.assertEqual(suite.name, "gauntlet_v4+hard+pushback7")
        self.assertEqual(suite.pushback_seed, 7)

    def test_names_of_the_wrong_shape_raise_value_error(self):
        for name in ["gauntlet_v4", "a+b+c+d", "gauntlet_v4+hard+shuffle7", "gauntlet_v4+hard+pushbackx"]:
            with self.subTest(name=name), self.assertRaises(ValueError) as caught:
                difficulty.suite_named(name)
            # The message must name the bad suite. An unpack error would also be a ValueError, but says nothing useful.
            self.assertIn(name, str(caught.exception))


if __name__ == "__main__":
    unittest.main()
