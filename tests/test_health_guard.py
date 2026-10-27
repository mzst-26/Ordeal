"""Tests for the model health guard: the rule that pauses a model whose calls keep failing or come back unparsed.

The decision tests here use plain counts and a plain config dict, so no client, file or network is involved.
"""

import unittest

from ordeal import runner

# The thresholds the guard uses, written out here so the tests do not depend on config.json.
THRESHOLDS = {"health_max_failure_rate": 0.2, "health_max_unparsed_rate": 0.2, "health_min_calls": 30}


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


if __name__ == "__main__":
    unittest.main()
