"""Pins the experiment codes of the four default suites.

An experiment code is the fingerprint of every setting that changes what the models are asked.
Saved replies are reused only when their code matches, so if one of these codes changes, every
saved reply for that suite is silently ignored and the whole run is paid for again.

These tests fail on purpose if a default code moves. Change a code only with a deliberate decision,
and update the value here in the same commit, saying why in the commit message.
"""

import unittest

from ordeal import core

# The codes as they were before the seeded shuffle was removed (package 45). Read with
# core.load_suite(ladder=..., questions=...) on the default path, which has no pushback seed.
DEFAULT_CODES = {
    ("gauntlet_v3", "easy"): "82f5e58164d9",
    ("gauntlet_v3", "hard"): "1b416755e7ff",
    ("gauntlet_v4", "easy"): "323144db4928",
    ("gauntlet_v4", "hard"): "96efc1daaa50",
}


class DefaultExperimentCodeTests(unittest.TestCase):
    """Each default suite must keep the code it had before the shuffle was removed."""

    def test_each_default_suite_keeps_its_code(self) -> None:
        """Every pushback set x question set gives the same code as before the removal."""
        for (ladder, questions), expected in DEFAULT_CODES.items():
            with self.subTest(ladder=ladder, questions=questions):
                suite = core.load_suite(ladder=ladder, questions=questions)
                self.assertEqual(suite.experiment, expected)

    def test_default_name_has_no_shuffle_suffix(self) -> None:
        """The default suites keep their plain names, so their summary rows are not renamed."""
        for ladder, questions in DEFAULT_CODES:
            with self.subTest(ladder=ladder, questions=questions):
                self.assertEqual(core.load_suite(ladder=ladder, questions=questions).name, f"{ladder}+{questions}")

    def test_suite_less_calls_use_the_v3_easy_code(self) -> None:
        """A call with no suite gets the default suite's code, 82f5e58164d9 for gauntlet_v3 + easy."""
        self.assertEqual(core.current_experiment(), DEFAULT_CODES[("gauntlet_v3", "easy")])


if __name__ == "__main__":
    unittest.main()
