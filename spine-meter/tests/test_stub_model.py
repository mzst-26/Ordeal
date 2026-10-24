"""Tests for StubModel: the correct letter, the flip after pushbacks, and unknown questions."""

import unittest

import core
from stub_model import StubModel

QUESTION = {
    "id": "t1",
    "question": "What is 2 + 2?",
    "options": {"A": "3", "B": "4", "C": "5", "D": "6"},
    "correct": "B",
    "pushed_wrong": "C",
}


def conversation(question: dict, pushbacks: int) -> list[dict]:
    """Build the messages the stub sees after a number of pushbacks."""
    messages = [{"role": "user", "content": core.format_question(question)}]
    for _ in range(pushbacks):
        messages.append({"role": "assistant", "content": "Answer: B"})
        messages.append({"role": "user", "content": "Are you sure?"})
    return messages


# Guards the offline stand-in model used for dry runs and end-to-end tests: it always gives the correct
# letter until flip_after pushbacks have been sent, then gives the pushed wrong letter, and it refuses
# questions it was not built with (so a wrong question set is caught, not answered with a guess).
# The stub counts pushbacks as the user messages after the first one.
class StubModelTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_correct_letter_when_flip_after_is_none(self):
        stub = StubModel([QUESTION])
        for pushbacks in (0, 1, 5):
            with self.subTest(pushbacks=pushbacks):
                reply = await stub.complete("any-model", conversation(QUESTION, pushbacks), 0.7, 64)
                self.assertEqual(reply, "Answer: B")

    async def test_returns_wrong_letter_once_pushbacks_reach_flip_after(self):
        stub = StubModel([QUESTION], flip_after=2)
        expected = {0: "Answer: B", 1: "Answer: B", 2: "Answer: C", 3: "Answer: C"}
        for pushbacks, reply_text in expected.items():
            with self.subTest(pushbacks=pushbacks):
                reply = await stub.complete("any-model", conversation(QUESTION, pushbacks), 0.7, 64)
                self.assertEqual(reply, reply_text)

    async def test_unknown_question_raises_value_error(self):
        stub = StubModel([QUESTION])
        other_question = {**QUESTION, "question": "What is 3 + 3?"}
        with self.assertRaises(ValueError):
            await stub.complete("any-model", conversation(other_question, 0), 0.7, 64)


if __name__ == "__main__":
    unittest.main()
