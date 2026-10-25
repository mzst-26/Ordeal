"""Shape checks for the v3 data files: ladder_v3.json, wrappers_v3.json and questions.json."""

import json
import unittest
from pathlib import Path

# These are structure checks on the shipped data files. The expected counts below are the design of the
# v3 experiment, so changing a ladder, a wrapper axis or the question set on purpose means updating them.
PROJECT_FOLDER = Path(__file__).resolve().parent.parent
LADDER_PATH = PROJECT_FOLDER / "ordeal" / "data" / "ladder_v3.json"
WRAPPERS_PATH = PROJECT_FOLDER / "ordeal" / "data" / "wrappers_v3.json"
QUESTIONS_PATH = PROJECT_FOLDER / "ordeal" / "data" / "questions.json"

EXPECTED_LEVEL_COUNT = 10
# The score for a model that never flips: one more than the number of levels.
EXPECTED_HELD_FIRM_SCORE = 11
# Probe axes in wrappers_v3.json, of which EXPECTED_TWIN_COUNT are twins (they have a matched twin probe).
EXPECTED_AXIS_COUNT = 13
EXPECTED_TWIN_COUNT = 9
# The four dose-response dials and how many strength levels each has, in the same order.
EXPECTED_DOSE_DIALS = ["consensus", "authority", "stated_confidence", "stakes"]
EXPECTED_DOSE_LEVEL_COUNTS = [5, 5, 4, 4]
# The mitigation arms compared against each other.
EXPECTED_ARM_IDS = ["anti_syc", "third_person", "control"]
EXPECTED_QUESTION_COUNT = 32


def load_json(path):
    """Read one JSON file and return its contents."""
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def find_level(levels, number):
    """Return the ladder level with the given level number."""
    for level in levels:
        if level.get("level") == number:
            return level
    raise KeyError(number)


def find_axis(axes, axis_id):
    """Return the wrapper axis with the given id."""
    for axis in axes:
        if axis.get("id") == axis_id:
            return axis
    raise KeyError(axis_id)


# Guards the ladder file the runner reads: ten levels numbered in order, each tagged with a type and an axis,
# level 4 as the only setup turn (with its message and required start text), and the held-firm score.
class LadderFileTests(unittest.TestCase):
    """Checks on ladder_v3.json."""

    @classmethod
    def setUpClass(cls):
        """Load the ladder file once for this class."""
        cls.ladder = load_json(LADDER_PATH)

    def test_has_ten_levels(self):
        """The ladder has exactly 10 levels."""
        self.assertEqual(len(self.ladder["levels"]), EXPECTED_LEVEL_COUNT)

    def test_level_numbers_run_one_to_ten_in_order(self):
        """Level numbers are 1 to 10 in order."""
        numbers = [level["level"] for level in self.ladder["levels"]]
        self.assertEqual(numbers, list(range(1, EXPECTED_LEVEL_COUNT + 1)))

    def test_every_level_has_type(self):
        """Every level has a type."""
        for level in self.ladder["levels"]:
            self.assertIn("type", level, f"level {level.get('level')} has no type")

    def test_every_level_has_axis(self):
        """Every level has an axis."""
        for level in self.ladder["levels"]:
            self.assertIn("axis", level, f"level {level.get('level')} has no axis")

    def test_setup_turn_is_true_only_on_level_four(self):
        """Only level 4 has setup_turn set to true."""
        flagged = [level["level"] for level in self.ladder["levels"] if level.get("setup_turn") is True]
        self.assertEqual(flagged, [4])

    def test_level_four_has_setup_message(self):
        """Level 4 has a setup_message."""
        self.assertIn("setup_message", find_level(self.ladder["levels"], 4))

    def test_level_four_has_setup_must_start_with(self):
        """Level 4 has setup_must_start_with."""
        self.assertIn("setup_must_start_with", find_level(self.ladder["levels"], 4))

    def test_held_firm_score_is_eleven(self):
        """held_firm_score is 11."""
        self.assertEqual(self.ladder["held_firm_score"], EXPECTED_HELD_FIRM_SCORE)

    def test_oracle_by_tier_has_default(self):
        """oracle_by_tier has a default key."""
        self.assertIn("default", self.ladder["oracle_by_tier"])

    def test_confession_probe_has_message(self):
        """confession_probe has a message key."""
        self.assertIn("message", self.ladder["confession_probe"])


# Guards the probe wrappers file: axis ids are unique, the tampered_history axis uses the current
# forged_reply and final_ask fields (not the old forge field), and the dose dials and mitigation
# arms are exactly the expected sets.
class WrapperFileTests(unittest.TestCase):
    """Checks on wrappers_v3.json."""

    @classmethod
    def setUpClass(cls):
        """Load the wrappers file once for this class."""
        cls.wrappers = load_json(WRAPPERS_PATH)

    def test_has_thirteen_axes(self):
        """There are 13 probe axes."""
        self.assertEqual(len(self.wrappers["axes"]), EXPECTED_AXIS_COUNT)

    def test_axis_ids_are_unique(self):
        """Every axis id appears only once."""
        ids = [axis["id"] for axis in self.wrappers["axes"]]
        self.assertEqual(len(ids), len(set(ids)))

    def test_exactly_nine_axes_are_twins(self):
        """Exactly 9 axes have twin set to true."""
        twins = [axis["id"] for axis in self.wrappers["axes"] if axis.get("twin") is True]
        self.assertEqual(len(twins), EXPECTED_TWIN_COUNT)

    def test_tampered_history_has_forged_reply(self):
        """The tampered_history axis has forged_reply."""
        self.assertIn("forged_reply", find_axis(self.wrappers["axes"], "tampered_history"))

    def test_tampered_history_has_final_ask(self):
        """The tampered_history axis has final_ask."""
        self.assertIn("final_ask", find_axis(self.wrappers["axes"], "tampered_history"))

    def test_tampered_history_has_no_forge_field(self):
        """The tampered_history axis has no old forge field."""
        self.assertNotIn("forge", find_axis(self.wrappers["axes"], "tampered_history"))

    def test_doses_have_exactly_the_four_dials(self):
        """The doses block has exactly the four expected dial keys."""
        self.assertEqual(sorted(self.wrappers["doses"].keys()), sorted(EXPECTED_DOSE_DIALS))

    def test_each_dose_dial_has_non_empty_levels(self):
        """Each dose dial has a non-empty levels list."""
        for name in EXPECTED_DOSE_DIALS:
            levels = self.wrappers["doses"][name].get("levels")
            self.assertIsInstance(levels, list, f"dial {name} has no levels list")
            self.assertTrue(levels, f"dial {name} has an empty levels list")

    def test_dose_level_counts_are_five_five_four_four(self):
        """The dose dials have 5, 5, 4 and 4 levels in that order."""
        counts = [len(self.wrappers["doses"][name]["levels"]) for name in EXPECTED_DOSE_DIALS]
        self.assertEqual(counts, EXPECTED_DOSE_LEVEL_COUNTS)

    def test_mitigation_arm_ids_are_as_expected(self):
        """The mitigation arms are anti_syc, third_person and control."""
        ids = [arm["id"] for arm in self.wrappers["mitigation_arms"]]
        self.assertEqual(ids, EXPECTED_ARM_IDS)


# Guards the question set: 32 questions, each with a wrong_path (a worked solution with a hidden wrong step, used by the trojan pushback).
class QuestionFileTests(unittest.TestCase):
    """Checks on questions.json."""

    @classmethod
    def setUpClass(cls):
        """Load the questions file once for this class."""
        cls.questions = load_json(QUESTIONS_PATH)

    def test_has_thirty_two_questions(self):
        """There are 32 questions."""
        self.assertEqual(len(self.questions), EXPECTED_QUESTION_COUNT)

    def test_every_question_has_wrong_path(self):
        """Every question has a wrong_path."""
        for question in self.questions:
            self.assertIn("wrong_path", question, f"question {question.get('id')} has no wrong_path")


if __name__ == "__main__":
    unittest.main()
