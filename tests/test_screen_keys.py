"""Tests for the flag rule and the summary in scripts/screen_keys.py.

These tests use plain letters and counts, so they never touch the network or the question text.
A question is flagged when a screen answer differs from the key, or when the screen answers disagree
with each other. The summary counts verified, unchecked and flagged questions.
"""

import sys
import unittest
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = PROJECT_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))
sys.path.insert(0, str(PROJECT_DIR))

import screen_keys  # noqa: E402


def make_question(question_id="q1", correct="B"):
    """Return a minimal question with only the fields the flag rule needs."""
    return {"id": question_id, "correct": correct}


class FlagReasonTests(unittest.TestCase):
    """The flag rule: flag when a screen letter differs from the key, or the screen letters disagree."""

    def test_all_letters_match_the_key_is_not_flagged(self):
        self.assertEqual(screen_keys.flag_reasons("B", ["B", "B", "B"]), [])

    def test_one_letter_different_from_key_is_flagged(self):
        reasons = screen_keys.flag_reasons("B", ["B", "C", "B"])
        self.assertIn("differs from key", reasons)

    def test_screen_disagreeing_with_itself_is_flagged(self):
        reasons = screen_keys.flag_reasons("A", ["A", "C", "A"])
        self.assertIn("screen answers disagree", reasons)
        self.assertIn("differs from key", reasons)

    def test_missing_answers_are_not_counted_as_a_letter(self):
        self.assertEqual(screen_keys.flag_reasons("B", ["B", None, "B"]), [])

    def test_all_missing_answers_give_no_flag(self):
        self.assertEqual(screen_keys.flag_reasons("B", [None, None, None]), [])


class FlaggedQuestionsTests(unittest.TestCase):
    """Only flagged questions appear in the result, with their key and their screen letters."""

    def test_only_flagged_questions_are_returned(self):
        questions = [make_question("q1", "B"), make_question("q2", "C")]
        screen = {
            "q1": {"model-a": [{"letter": "B"}, {"letter": "B"}]},
            "q2": {"model-a": [{"letter": "A"}, {"letter": "C"}]},
        }
        flagged = screen_keys.flagged_questions(questions, screen)
        self.assertEqual(list(flagged), ["q2"])
        self.assertEqual(flagged["q2"]["key"], "C")
        self.assertEqual(flagged["q2"]["screen"], ["A", "C"])

    def test_letters_from_all_models_are_pooled(self):
        questions = [make_question("q1", "B")]
        screen = {"q1": {"model-a": [{"letter": "B"}], "model-b": [{"letter": "D"}]}}
        flagged = screen_keys.flagged_questions(questions, screen)
        self.assertEqual(flagged["q1"]["screen"], ["B", "D"])


class SummaryTests(unittest.TestCase):
    """The summary counts verified, unchecked and flagged questions."""

    def test_counts_verified_unchecked_and_flagged(self):
        checks = [
            {"id": "q1", "status": "verified"},
            {"id": "q2", "status": "unchecked"},
            {"id": "q3", "status": "unchecked"},
        ]
        summary = screen_keys.summarize_checks(checks, flagged_ids=["q3"])
        self.assertEqual(summary, {"verified": 1, "unchecked": 2, "flagged": 1})

    def test_no_flags_gives_zero_flagged(self):
        checks = [{"id": "q1", "status": "unchecked"}]
        self.assertEqual(screen_keys.summarize_checks(checks, flagged_ids=[])["flagged"], 0)


if __name__ == "__main__":
    unittest.main()
