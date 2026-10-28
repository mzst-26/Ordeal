"""Tests for scripts/screen_keys.py: the blind key screen, its flag rule and its summary.

None of these tests touch the network. The screen is tested with a fake ask function that records
the messages it was sent, so we can check that no key-bearing field ever reaches a model.
The flag and summary tests use plain letters and counts, so they never need question text.
"""

import json
import sys
import unittest
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = PROJECT_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))
sys.path.insert(0, str(PROJECT_DIR))

import screen_keys  # noqa: E402
from ordeal import core  # noqa: E402

QUESTIONS_PATH = PROJECT_DIR / "ordeal" / "data" / "questions.json"
KEY_CHECKS_PATH = PROJECT_DIR / "ordeal" / "data" / "key_checks.json"


def make_question(question_id="q1", correct="B"):
    """Return a question shaped like questions.json, with text that must never reach a model."""
    return {
        "id": question_id,
        "question": "Which option is right?",
        "options": {"A": "first", "B": "second", "C": "third", "D": "fourth"},
        "correct": correct,
        "pushed_wrong": "C",
        "trap": "SECRET_TRAP_TEXT",
        "wrong_path": "SECRET_WRONG_PATH_TEXT",
    }


class BlindViewTests(unittest.TestCase):
    """The blind view is the only part of a question that a screen model may see."""

    def test_blind_view_keeps_only_question_and_options(self):
        view = screen_keys.blind_view(make_question())
        self.assertEqual(set(view), {"question", "options"})

    def test_blind_message_has_no_key_or_trap_text(self):
        message = core.format_question(screen_keys.blind_view(make_question()))
        # The fixed example "Answer: B" in the format text is the same for every question, so it is allowed.
        self.assertNotIn("SECRET", message)
        self.assertIn("Which option is right?", message)


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


class RunScreenTests(unittest.TestCase):
    """The screen asks every model the same number of times, with blind messages only."""

    def test_each_model_gets_the_samples_asked_for(self):
        sent = []

        def fake_ask(model, messages):
            sent.append((model, messages))
            return "Answer: B"

        questions = [make_question("q1")]
        results = screen_keys.run_screen(questions, ["model-a", "model-b"], samples=3, ask=fake_ask)
        self.assertEqual(len(sent), 6)
        self.assertEqual([sample["letter"] for sample in results["q1"]["model-a"]], ["B", "B", "B"])

    def test_no_message_carries_key_or_trap_fields(self):
        sent = []

        def fake_ask(model, messages):
            sent.append(messages)
            return "Answer: A"

        screen_keys.run_screen([make_question("q1")], ["model-a"], samples=1, ask=fake_ask)
        text = json.dumps(sent)
        self.assertNotIn("SECRET", text)
        self.assertNotIn('"pushed_wrong"', text)
        self.assertNotIn('"correct"', text)

    def test_a_failed_call_is_recorded_not_raised(self):
        def failing_ask(model, messages):
            raise RuntimeError("the server said no")

        results = screen_keys.run_screen([make_question("q1")], ["model-a"], samples=1, ask=failing_ask)
        sample = results["q1"]["model-a"][0]
        self.assertIsNone(sample["letter"])
        self.assertEqual(sample["error"], "RuntimeError")


class KeyChecksFileTests(unittest.TestCase):
    """The key_checks.json template has one unchecked entry per question, and questions.json is untouched."""

    def test_one_entry_per_question_with_the_fields(self):
        questions = json.loads(QUESTIONS_PATH.read_text(encoding="utf-8"))
        checks = json.loads(KEY_CHECKS_PATH.read_text(encoding="utf-8"))
        self.assertEqual(sorted(entry["id"] for entry in checks), sorted(question["id"] for question in questions))
        for entry in checks:
            self.assertEqual(set(entry), {"id", "checked_by", "checked_on", "source", "status"})
            self.assertIsNone(entry["checked_by"])
            self.assertIsNone(entry["checked_on"])
            self.assertIsNone(entry["source"])
            self.assertEqual(entry["status"], "unchecked")

    def test_questions_file_has_no_key_check_fields(self):
        questions = json.loads(QUESTIONS_PATH.read_text(encoding="utf-8"))
        for question in questions:
            self.assertNotIn("status", question)
            self.assertNotIn("checked_by", question)


if __name__ == "__main__":
    unittest.main()
