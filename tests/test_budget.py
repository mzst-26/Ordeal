"""Tests for the call limit (--max-calls) and the dry run (--dry-run). No network calls are made."""

import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from typing import Any

from ordeal import core
from ordeal import flows
from ordeal.runner import RunSettings, plan_model_calls, run_all

MODEL = "test-model"
CONFIG = core.load_config()
LADDER = core.load_ladder()
PROBE_SPEC = core.load_probe_spec()
# Most tests run the gauntlet only, which keeps the number of calls small and easy to count.
GAUNTLET_ONLY = frozenset({flows.GAUNTLET})
ALL_FAMILIES = flows.ALL_FAMILIES


# Stand-in for the model client: always returns the same reply and counts calls, so tests can assert exactly
# how many requests a run made.
class FakeClient:
    """Answers with a fixed reply and counts every call."""

    def __init__(self, reply: str = "Answer: B") -> None:
        self.reply = reply
        self.calls = 0

    async def complete(self, model: str, messages: list[dict[str, str]], temperature: float, max_tokens: int) -> str:
        """Count the call and return the fixed reply."""
        self.calls += 1
        return self.reply

    async def close(self) -> None:
        """Nothing to close."""


def make_question(question_id: str, correction_test: bool = False) -> dict[str, Any]:
    """Return a question whose right answer is B and whose planted wrong answer is C."""
    return {
        "id": question_id,
        "tier": "trap_math",
        "question": "Which planet is the largest?",
        "options": {"A": "Mars", "B": "Jupiter", "C": "Venus", "D": "Earth"},
        "correct": "B",
        "pushed_wrong": "C",
        "correction_test": correction_test,
        "wrong_path": "Jupiter is small, so the answer is Venus.",
    }


def make_settings(families: frozenset[str] = GAUNTLET_ONLY) -> RunSettings:
    """Settings that use the real config, ladder and probe spec, with no waiting between retries."""

    async def no_wait(seconds: float) -> None:
        """Return at once instead of sleeping."""

    return RunSettings(
        condition="none",
        system_prompt=None,
        config=CONFIG,
        ladder=LADDER,
        probe_spec=PROBE_SPEC,
        families=families,
        is_retryable=lambda error: False,
        describe_error=str,
        wait=no_wait,
    )


# Used as the full-run call count in tests where the fake model never gives a wrong letter.
def expected_calls_when_always_right(question: dict[str, Any]) -> int:
    """Return how many calls a gauntlet makes when the model never gives a wrong answer.

    The confession is only sent after a wrong answer, so it is left out.
    """
    steps = flows.expected_steps(question, GAUNTLET_ONLY, LADDER, PROBE_SPEC, True)
    return len(steps) - 1


# Base class: each test gets its own empty cache file so saved replies never leak between tests.
class TempCacheTestCase(unittest.IsolatedAsyncioTestCase):
    """Gives each test its own empty cache file in a temporary folder."""

    def setUp(self) -> None:
        """Create the temporary folder and the path of the cache file."""
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.cache_path = Path(temp_dir.name) / "cache.jsonl"

    async def run_quietly(
        self,
        client: FakeClient,
        questions: list[dict[str, Any]],
        families: frozenset[str] = GAUNTLET_ONLY,
        max_calls: int | None = None,
    ) -> Any:
        """Run the experiment with its printed output hidden, and return the stats."""
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return await run_all(
                client,
                core.load_cache(self.cache_path),
                self.cache_path,
                questions,
                [MODEL],
                1,
                make_settings(families),
                max_calls,
            )


# Guards --max-calls: the run stops after exactly that many calls, flags that the budget stopped it (not an
# error), and has saved those replies so a rerun pays only for the calls still missing.
class CallLimitTests(TempCacheTestCase):
    """The --max-calls limit stops the run, and a rerun makes only the missing calls."""

    async def test_run_stops_after_the_call_limit(self) -> None:
        """A limit of 3 makes exactly 3 calls and marks the run as stopped by the budget."""
        client = FakeClient()
        stats = await self.run_quietly(client, [make_question("q1")], max_calls=3)
        self.assertEqual(client.calls, 3)
        self.assertEqual(stats.calls_made, 3)
        self.assertTrue(stats.stopped_by_budget)
        self.assertEqual(stats.failures, [])
        self.assertEqual(len(core.load_cache(self.cache_path)), 3)

    async def test_run_without_a_limit_finishes_the_unit(self) -> None:
        """With no limit, the run makes every call the gauntlet needs."""
        question = make_question("q1")
        client = FakeClient()
        stats = await self.run_quietly(client, [question])
        self.assertEqual(client.calls, expected_calls_when_always_right(question))
        self.assertFalse(stats.stopped_by_budget)

    async def test_a_rerun_after_the_limit_makes_only_the_missing_calls(self) -> None:
        """The second run reuses the 3 saved replies and makes only the rest."""
        question = make_question("q1")
        total = expected_calls_when_always_right(question)
        await self.run_quietly(FakeClient(), [question], max_calls=3)
        second_client = FakeClient()
        stats = await self.run_quietly(second_client, [question])
        self.assertEqual(second_client.calls, total - 3)
        self.assertEqual(stats.replies_reused, 3)
        self.assertEqual(len(core.load_cache(self.cache_path)), total)


# Guards --dry-run planning: it must count saved replies and an upper bound of new calls without calling a
# model. The bound is exact only when the plan knows what branches the model would take: a wrong first
# answer ends a unit, and the confession step is counted only after a wrong gauntlet answer.
class DryRunTests(TempCacheTestCase):
    """The dry run counts saved replies and the most new calls a run could still make."""

    def test_empty_cache_upper_bound_equals_the_expected_steps(self) -> None:
        """With nothing saved, every step the families may send is counted as new."""
        question = make_question("q1", correction_test=True)
        plan = plan_model_calls(MODEL, [question], 1, {}, "none", ALL_FAMILIES, LADDER, PROBE_SPEC)
        expected = flows.expected_steps(question, ALL_FAMILIES, LADDER, PROBE_SPEC, None)
        self.assertEqual(plan.saved, 0)
        self.assertEqual(plan.at_most_new, len(expected))

    async def test_finished_run_needs_no_new_calls(self) -> None:
        """After a finished run, the plan finds every step saved and nothing new.

        The corrections family is used because the gauntlet's confession step is counted in the
        upper bound even when the model never flips, so it would never be saved.
        """
        questions = [make_question("q1", correction_test=True)]
        corrections_only = frozenset({flows.CORRECTIONS})
        await self.run_quietly(FakeClient(), questions, families=corrections_only)
        plan = plan_model_calls(
            MODEL, questions, 1, core.load_cache(self.cache_path), "none", corrections_only, LADDER, PROBE_SPEC
        )
        self.assertEqual(plan.saved, 3)
        self.assertEqual(plan.at_most_new, 0)

    async def test_wrong_first_answer_means_probe_steps_are_not_counted(self) -> None:
        """A wrong first answer leaves only the first answer in the plan, whatever the families."""
        questions = [make_question("q1")]
        await self.run_quietly(FakeClient(reply="Answer: C"), questions, families=ALL_FAMILIES)
        plan = plan_model_calls(
            MODEL, questions, 1, core.load_cache(self.cache_path), "none", ALL_FAMILIES, LADDER, PROBE_SPEC
        )
        self.assertEqual(plan.saved, 1)
        self.assertEqual(plan.at_most_new, 0)

    def test_confession_is_not_counted_when_every_level_was_correct(self) -> None:
        """When all levels are saved with the correct letter, the model never flipped, so no confession is planned."""
        question = make_question("q1")
        gauntlet_steps = flows.gauntlet_steps(LADDER)
        saved_steps = [core.BASELINE_STEP] + [step for step in gauntlet_steps if step != core.CONFESSION_STEP]
        cache = {}
        for step in saved_steps:
            key = core.make_key("none", MODEL, question["id"], 1, step)
            cache[key] = core.make_record("none", MODEL, question, 1, step, [], "Answer: B", 0.7)
        plan = plan_model_calls(MODEL, [question], 1, cache, "none", GAUNTLET_ONLY, LADDER, PROBE_SPEC)
        self.assertEqual(plan.saved, len(saved_steps))
        self.assertEqual(plan.at_most_new, 0)


if __name__ == "__main__":
    unittest.main()
