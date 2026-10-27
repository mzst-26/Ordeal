"""Tests for the model health guard: the rule that pauses a model whose calls keep failing or come back unparsed.

The decision tests here use plain counts and a plain config dict, so no client, file or network is involved.
"""

import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from ordeal import core
from ordeal import grade
from ordeal import model_client
from ordeal import runner
from tests.test_runner import FatalError, make_question, make_settings

# The thresholds the guard uses, written out here so the tests do not depend on config.json.
THRESHOLDS = {"health_max_failure_rate": 0.2, "health_max_unparsed_rate": 0.2, "health_min_calls": 30}
BAD_MODEL = "bad-model"
GOOD_MODEL = "good-model"
# Three calls decide the pause here: three failures are 100 percent, above the 50 percent limit. One call at a
# time keeps the order of the calls the same on every run, so the counts below are exact.
PAUSE_CONFIG = dict(core.load_config(), concurrency=1, health_min_calls=3, health_max_failure_rate=0.5)


# The guard must not judge a model on a handful of calls, and must pause one whose failure or unparsed
# rate is above its limit. A rate exactly at the limit is not above it, so it does not pause the model.
class HealthDecisionTests(unittest.TestCase):
    """model_is_unhealthy decides from the counts alone, using the thresholds in the config."""

    def test_model_below_minimum_calls_is_never_paused(self) -> None:
        """With 29 calls, all of them failed and all replies unparsed, the model still has too few calls to judge."""
        counts = runner.HealthCounts(calls=29, failures=29, graded_replies=29, unparsed_replies=29)
        self.assertFalse(runner.model_is_unhealthy(counts, THRESHOLDS))

    def test_failure_rate_below_threshold_is_healthy(self) -> None:
        """Five failures in 30 calls is about 17 percent, under the 20 percent limit."""
        counts = runner.HealthCounts(calls=30, failures=5)
        self.assertFalse(runner.model_is_unhealthy(counts, THRESHOLDS))

    def test_failure_rate_above_threshold_is_paused(self) -> None:
        """Seven failures in 30 calls is about 23 percent, above the 20 percent limit."""
        counts = runner.HealthCounts(calls=30, failures=7)
        self.assertTrue(runner.model_is_unhealthy(counts, THRESHOLDS))

    def test_failure_rate_exactly_at_threshold_is_healthy(self) -> None:
        """Six failures in 30 calls is exactly 20 percent, which is not above the limit."""
        counts = runner.HealthCounts(calls=30, failures=6)
        self.assertFalse(runner.model_is_unhealthy(counts, THRESHOLDS))

    def test_unparsed_rate_above_threshold_is_paused(self) -> None:
        """Three unparsed graded replies out of ten is 30 percent, above the 20 percent limit."""
        counts = runner.HealthCounts(calls=30, graded_replies=10, unparsed_replies=3)
        self.assertTrue(runner.model_is_unhealthy(counts, THRESHOLDS))

    def test_unparsed_rate_below_threshold_is_healthy(self) -> None:
        """One unparsed graded reply out of ten is 10 percent, under the limit."""
        counts = runner.HealthCounts(calls=30, graded_replies=10, unparsed_replies=1)
        self.assertFalse(runner.model_is_unhealthy(counts, THRESHOLDS))

    def test_no_graded_replies_gives_no_unparsed_rate(self) -> None:
        """When the model has no graded reply yet, its unparsed rate is zero, not a division by zero."""
        counts = runner.HealthCounts(calls=30, failures=0, graded_replies=0, unparsed_replies=0)
        self.assertFalse(runner.model_is_unhealthy(counts, THRESHOLDS))

    def test_reason_names_the_rule_that_fired(self) -> None:
        """The reason says 'failed' for a failure problem and 'Answer' for an unparsed one, so the line is clear."""
        failing = runner.HealthCounts(calls=30, failures=7)
        unparsed = runner.HealthCounts(calls=30, graded_replies=10, unparsed_replies=3)
        self.assertIn("failed", runner.health_problem(failing, THRESHOLDS))
        self.assertIn("Answer", runner.health_problem(unparsed, THRESHOLDS))

    def test_no_reason_when_healthy(self) -> None:
        """A healthy model has no problem to report."""
        self.assertIsNone(runner.health_problem(runner.HealthCounts(calls=30), THRESHOLDS))


# The shipped thresholds are read from config.json, so that a run can be tuned without editing code.
# These are the defaults: a model is judged after 30 calls, and paused above 20 percent failed or unparsed.
class ShippedThresholdTests(unittest.TestCase):
    """config.json holds the three health thresholds, with the defaults the README describes."""

    def test_config_holds_the_default_thresholds(self) -> None:
        """The three keys are present with the defaults 0.2, 0.2 and 30."""
        config = core.load_config()
        self.assertEqual(config["health_max_failure_rate"], 0.2)
        self.assertEqual(config["health_max_unparsed_rate"], 0.2)
        self.assertEqual(config["health_min_calls"], 30)


# The guard counts only graded replies. Setup and probe steps have no 'Answer: X' line by design, so counting
# them would pause a healthy model. The runner's rule must match the grader's rule, for every suite.
class GradedStepTests(unittest.TestCase):
    """is_graded_step gives the same answer as grade.graded_steps, for the default suite and the v4 suite."""

    def test_is_graded_step_matches_the_grader_on_both_suites(self) -> None:
        """Every candidate step is graded in the runner exactly when the grader grades it."""
        setup_and_probe_steps = {"setup_4", "setup_turn", "fp_commitment_setup", "twin_commitment_setup"}
        for suite in (core.load_suite(), core.load_suite(ladder="gauntlet_v4", questions="hard")):
            graded = grade.graded_steps(suite)
            candidates = graded | setup_and_probe_steps
            with self.subTest(suite=suite.name):
                self.assertEqual({step for step in candidates if runner.is_graded_step(step)}, graded)


# The run must stop sending calls to a model that is unhealthy, keep the other model going, and say so once.
# The bad model's remaining units are counted as skipped, not as failures, because they were never sent.
class PauseRunTests(unittest.IsolatedAsyncioTestCase):
    """A model whose calls keep failing, or come back unparsed, is paused for this run only."""

    def setUp(self) -> None:
        """Use a temporary cache file, so the real cache is never touched."""
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.cache_path = Path(temp_dir.name) / "cache.jsonl"

    async def run_two_models(self, client: "SplitClient") -> tuple[runner.RunStats, str]:
        """Run six questions on each model, one repeat, and return the stats and what went to stderr."""
        questions = [make_question(f"q{number}") for number in range(1, 7)]
        errors = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(errors):
            stats = await runner.run_all(
                client, {}, self.cache_path, questions, [BAD_MODEL, GOOD_MODEL], 1,
                make_settings(config=PAUSE_CONFIG),
            )
        return stats, errors.getvalue()

    async def test_failing_model_is_paused_and_its_remaining_calls_are_not_sent(self) -> None:
        """Three failed calls pause the bad model, so only three of its six calls are sent and three are skipped."""
        client = SplitClient(BAD_MODEL)
        stats, _ = await self.run_two_models(client)
        self.assertEqual(client.sent_models.count(BAD_MODEL), 3)
        self.assertEqual(stats.calls_skipped, 3)
        self.assertEqual(set(stats.paused), {BAD_MODEL})

    async def test_skipped_calls_are_not_counted_as_failures(self) -> None:
        """Only the three calls that were sent and failed are failures. The skipped ones are not."""
        stats, _ = await self.run_two_models(SplitClient(BAD_MODEL))
        self.assertEqual(len(stats.failures), 3)
        self.assertTrue(all(failure.model == BAD_MODEL for failure in stats.failures))

    async def test_other_model_finishes_all_its_calls(self) -> None:
        """The good model is not touched by the pause: all six of its calls are sent and saved."""
        client = SplitClient(BAD_MODEL)
        stats, _ = await self.run_two_models(client)
        self.assertEqual(client.sent_models.count(GOOD_MODEL), 6)
        self.assertEqual(stats.calls_made, 6)

    async def test_stderr_names_the_paused_model_once(self) -> None:
        """One line on stderr says which model was paused, and it does not name the other model."""
        _, errors = await self.run_two_models(SplitClient(BAD_MODEL))
        pause_lines = [line for line in errors.splitlines() if line.startswith("Paused")]
        self.assertEqual(len(pause_lines), 1)
        self.assertIn(BAD_MODEL, pause_lines[0])
        self.assertNotIn(GOOD_MODEL, pause_lines[0])

    async def test_unparsed_graded_replies_pause_the_model(self) -> None:
        """Replies with no 'Answer: X' line are not failures, but they still pause the model, and its calls stop."""
        client = SplitClient(BAD_MODEL, bad_text="I think it is B")
        stats, _ = await self.run_two_models(client)
        self.assertEqual(client.sent_models.count(BAD_MODEL), 3)
        self.assertEqual(stats.failures, [])
        self.assertEqual(set(stats.paused), {BAD_MODEL})


# Fake client for the pause tests. It fails every call for one model, or answers it with 'bad_text' when that is
# given, and answers the other model correctly. 'sent_models' records the model of every call actually sent.
class SplitClient:
    """Answers one model badly and the other model correctly, and records which model each sent call was for."""

    def __init__(self, bad_model: str, bad_text: str | None = None) -> None:
        self.bad_model = bad_model
        self.bad_text = bad_text
        self.sent_models: list[str] = []
        self.closed = False

    async def complete_detailed(
        self, model: str, messages: list[dict[str, str]], temperature: float, max_tokens: int
    ) -> model_client.Reply:
        """Record the model, then fail or answer as the bad model's setting says."""
        self.sent_models.append(model)
        if model != self.bad_model:
            return model_client.Reply(text="Answer: B", headers={}, prompt_tokens=None, completion_tokens=None)
        if self.bad_text is None:
            raise FatalError("server error")
        return model_client.Reply(text=self.bad_text, headers={}, prompt_tokens=None, completion_tokens=None)

    async def close(self) -> None:
        """Remember that the client was closed, as the real client must be."""
        self.closed = True


if __name__ == "__main__":
    unittest.main()
