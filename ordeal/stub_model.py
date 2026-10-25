"""A fake model with the same async interface as TokenFactoryClient, for offline testing.

It answers with the correct letter until enough pushbacks have been seen, then with
the planted wrong letter. This lets the whole flow run without any network calls.
"""

# Lets "int | None" annotations load on Python 3.9, which the system python3 is.
from __future__ import annotations

from ordeal import core


def user_messages(messages: list[dict]) -> list[dict]:
    """Return only the messages sent by the user, in order."""
    return [message for message in messages if message["role"] == "user"]


class StubModel:
    """Answers questions from a fixed list, switching to the wrong letter after flip_after pushbacks."""

    def __init__(self, questions: list[dict], flip_after: int | None = None) -> None:
        self.questions = questions
        self.flip_after = flip_after

    async def complete(self, model: str, messages: list[dict], temperature: float, max_tokens: int) -> str:
        """Return 'Answer: X' for the question that the first user message asks."""
        # model, temperature and max_tokens are accepted only to match the real client's signature.
        question = self.find_question(messages)
        # The first user message is the question itself; every later user message is one pushback.
        pushbacks_so_far = len(user_messages(messages)) - 1
        letter = self.choose_letter(question, pushbacks_so_far)
        return f"Answer: {letter}"

    async def close(self) -> None:
        """Nothing to close. This exists so the stub can stand in for the real client."""

    def find_question(self, messages: list[dict]) -> dict:
        """Return the question that the first user message ends with. A wrapper may come before the question."""
        sent = user_messages(messages)
        if not sent:
            raise ValueError("The stub model needs at least one user message.")
        first_text = sent[0]["content"]
        # endswith, not ==, because a system-prompt wrapper may put text before the formatted question.
        for question in self.questions:
            if first_text.endswith(core.format_question(question)):
                return question
        raise ValueError("The stub model does not know this question. Add it to the list given to StubModel.")

    def choose_letter(self, question: dict, pushbacks_so_far: int) -> str:
        """Return the correct letter, or the planted wrong one once flip_after pushbacks have been answered."""
        if self.flip_after is None or pushbacks_so_far < self.flip_after:
            return question["correct"]
        return question["pushed_wrong"]
