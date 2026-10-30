"""Parity check for the browser grader, seen from the Python side.

The browser grader (frontend/js/engine/grade.js) must give the same numbers as grade.py for the same saved
replies. This file grades the shared fixture in tests/fixtures/grader-parity with grade.py and compares the
result with expected.json. The JavaScript test reads the same two files, so both graders are held to one
set of numbers. The scenario tests check a few values that can be worked out by hand from the fixture.
"""

import json
import math
import unittest
from pathlib import Path

from ordeal import difficulty
from ordeal import grade

# The fixture folder sits at tests/fixtures/grader-parity, two levels above this file's folder.
FIXTURE_FOLDER = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "grader-parity"
EXPECTED_PATH = FIXTURE_FOLDER / "expected.json"
# The two conditions in the fixture. 'mitigation' has fewer models, so one model has no rows there.
CONDITIONS = ["none", "mitigation"]
# The estimates whose 95 percent intervals are compared. Each one also has _low and _high columns.
ESTIMATES = [
    *[f"flip_rate_level_{level}" for level in range(1, 11)],
    "mean_spine_score",
    "final_correct_share",
    "capitulated_share",
    "converted_share",
    "recovery_rate",
    "test_retest_agreement",
    "acceptance_mean",
]
# Every value compared between the graders. Interval ends get a tolerance because they come from random
# resampling; every other value is a plain count or a plain share, so it must match exactly.
PARITY_FIELDS = [
    "suite",
    "questions",
    "units",
    "baseline_accuracy",
    "unparsed_share",
    *[column for name in ESTIMATES for column in grade.with_interval(name)],
    "acceptance_a",
    "acceptance_b",
    "correction_units",
    "confession_units",
    "flip_count",
    "flip_count_units",
]
# Interval ends are the only values that come from the bootstrap, so only they get a tolerance.
INTERVAL_TOLERANCE = 1e-9


def read_fixture_json(name: str):
    """Read one JSON file from the fixture folder."""
    return json.loads((FIXTURE_FOLDER / name).read_text(encoding="utf-8"))


def comparable(value):
    """Return a value the way the expected file stores it: NaN becomes None, anything else stays the same."""
    if isinstance(value, float) and math.isnan(value):
        return None
    return value


def gauntlet_values(row: dict) -> dict:
    """Return only the fields that both graders are compared on, with NaN written as None."""
    return {name: comparable(row[name]) for name in PARITY_FIELDS}


def grade_all_conditions() -> dict:
    """Grade the fixture replies with grade.py for each condition. Returns {condition: {model: values}}."""
    records = read_fixture_json("replies.json")
    questions = read_fixture_json("questions.json")
    config = read_fixture_json("config.json")
    graded = {}
    for condition in CONDITIONS:
        rows = grade.grade_condition(records, questions, config, condition)
        graded[condition] = {row["model"]: gauntlet_values(row) for row in rows}
    return graded


def write_expected() -> None:
    """Grade the fixture with grade.py and write expected.json.

    Run this only when the fixture or the grading rules change on purpose:
    python -c "import tests.python.test_grader_parity as t; t.write_expected()"
    """
    document = {
        "description": "Gauntlet rows from grade.py for the shared parity fixture. Written by write_expected().",
        "conditions": grade_all_conditions(),
    }
    EXPECTED_PATH.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def assert_same_values(test: unittest.TestCase, actual: dict, expected: dict) -> None:
    """Check that every expected field matches the actual one. Interval ends may differ by INTERVAL_TOLERANCE."""
    test.assertEqual(sorted(actual), sorted(expected), "the two rows have different fields")
    for name, expected_value in expected.items():
        actual_value = actual[name]
        if expected_value is None or actual_value is None:
            test.assertEqual(actual_value, expected_value, name)
        elif name.endswith(("_low", "_high")):
            test.assertTrue(
                math.isclose(actual_value, expected_value, rel_tol=0, abs_tol=INTERVAL_TOLERANCE),
                f"{name}: expected {expected_value}, got {actual_value}",
            )
        else:
            test.assertEqual(actual_value, expected_value, name)


class GraderParityFixtureTests(unittest.TestCase):
    """grade.py must reproduce expected.json, which the JavaScript grader is checked against too."""

    @classmethod
    def setUpClass(cls):
        cls.expected = read_fixture_json("expected.json")["conditions"]
        cls.actual = grade_all_conditions()

    def test_each_condition_has_the_expected_models(self):
        for condition in CONDITIONS:
            with self.subTest(condition=condition):
                self.assertEqual(sorted(self.actual[condition]), sorted(self.expected[condition]))

    def test_every_model_row_matches_expected(self):
        for condition in CONDITIONS:
            for model, expected_values in self.expected[condition].items():
                with self.subTest(condition=condition, model=model):
                    assert_same_values(self, self.actual[condition][model], expected_values)


class GraderParityScenarioTests(unittest.TestCase):
    """Values worked out by hand from the fixture. Each model is named for the scenario it covers."""

    @classmethod
    def setUpClass(cls):
        cls.none = grade_all_conditions()["none"]
        cls.mitigation = grade_all_conditions()["mitigation"]

    def test_all_correct_model_has_no_flips(self):
        # org/alpha-steady gives the right letter at every step, so nothing flips.
        row = self.none["org/alpha-steady"]
        self.assertEqual(row["units"], 8)
        self.assertEqual(row["baseline_accuracy"], 1.0)
        self.assertEqual(row["flip_rate_level_10"], 0.0)
        self.assertEqual(row["mean_spine_score"], 11.0)
        self.assertEqual(row["final_correct_share"], 1.0)
        self.assertEqual(row["flip_count"], 0)

    def test_all_wrong_model_has_no_initially_right_units_and_nan_estimates(self):
        # org/delta-always-wrong is wrong at baseline everywhere, so no unit is initially right.
        row = self.none["org/delta-always-wrong"]
        self.assertEqual(row["units"], 0)
        self.assertEqual(row["baseline_accuracy"], 0.0)
        self.assertIsNone(row["flip_rate_level_1"])
        self.assertIsNone(row["mean_spine_score"])
        # Acceptance uses the correction units, which do not need a correct baseline, so it is a real number.
        self.assertEqual(row["acceptance_mean"], 0.0)

    def test_mixed_model_matches_hand_counts(self):
        # org/beta-mixed has 5 initially right units: 4 flip and 1 holds firm at level 10.
        row = self.none["org/beta-mixed"]
        self.assertEqual(row["units"], 5)
        self.assertEqual(row["questions"], 4)
        self.assertAlmostEqual(row["flip_rate_level_1"], 0.2)
        self.assertAlmostEqual(row["flip_rate_level_3"], 0.8)
        self.assertAlmostEqual(row["mean_spine_score"], 3.8)
        self.assertAlmostEqual(row["final_correct_share"], 0.8)
        self.assertEqual(row["flip_count"], 5)
        self.assertAlmostEqual(row["recovery_rate"], 0.75)
        self.assertAlmostEqual(row["capitulated_share"], 0.5)
        self.assertAlmostEqual(row["converted_share"], 0.5)
        self.assertEqual(row["correction_units"], 4)
        self.assertAlmostEqual(row["acceptance_mean"], 0.5)

    def test_unparseable_replies_count_as_unparsed_but_not_as_flips(self):
        # org/gamma-unparseable answers the baseline correctly, then gives no letter at any later step.
        row = self.none["org/gamma-unparseable"]
        self.assertEqual(row["units"], 8)
        self.assertEqual(row["flip_rate_level_10"], 0.0)
        self.assertEqual(row["mean_spine_score"], 11.0)
        self.assertEqual(row["final_correct_share"], 0.0)
        # Graded replies: 104, of which 96 are unparsed. The setup and probe replies are not graded, so they
        # are not counted, even though they are unparsed too.
        self.assertAlmostEqual(row["unparsed_share"], 96 / 104)

    def test_two_conditions_give_different_numbers_for_the_same_model(self):
        # The mitigation condition holds the pressure levels right, so the mixed model never flips at level 1.
        self.assertAlmostEqual(self.none["org/beta-mixed"]["flip_rate_level_1"], 0.2)
        self.assertEqual(self.mitigation["org/beta-mixed"]["flip_rate_level_1"], 0.0)

    def test_model_with_no_replies_under_a_condition_has_no_row(self):
        # The three models that were only run under 'none' have no row under 'mitigation'.
        self.assertEqual(sorted(self.mitigation), ["org/alpha-steady", "org/beta-mixed"])
        self.assertEqual(len(self.none), 5)

    def test_difficulty_groups_match_hand_counts(self):
        # Difficulty groups use the same flip rate at the top level. Easy: 3 of 3 flip. Hard: 1 of 2 flips.
        cache = {index: record for index, record in enumerate(read_fixture_json("replies.json"))}
        rows = difficulty.difficulty_rows(cache, read_fixture_json("questions.json"), read_fixture_json("config.json"))
        beta = {
            (row["group_kind"], row["group"]): row["value"]
            for row in rows
            if row["model"] == "org/beta-mixed" and row["condition"] == "none" and row["measure"] == "share"
        }
        self.assertAlmostEqual(beta[("difficulty", "easy")], 1.0)
        self.assertAlmostEqual(beta[("difficulty", "hard")], 0.5)


if __name__ == "__main__":
    unittest.main()
