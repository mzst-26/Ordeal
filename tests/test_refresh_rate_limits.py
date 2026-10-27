"""Tests for the pure part of scripts/refresh_rate_limits.py: how one model's table entry is merged with a reply.

Everything here is offline. The header dictionaries copy the names the provider really sends, and
no test makes a network call. The real run is the only check of the live calls.
"""

import sys
import unittest
from pathlib import Path

from ordeal.limiter import parse_rate_headers

# scripts/ is not a package, so it is added to the import path to make refresh_rate_limits importable.
SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import refresh_rate_limits  # noqa: E402  (needs scripts/ on sys.path first)

# The entry the console table holds for one model before any refresh.
OLD_ENTRY = {"requests_per_minute": 600, "tokens_per_minute": 400000}


class MergeModelLimitsTests(unittest.TestCase):
    """merge_model_limits: a reply's limits replace the table's, or the old values stay with a reason."""

    def test_matching_values_are_refreshed_and_marked_as_headers(self):
        """When the live limits equal the table, the status is refreshed and the source becomes headers."""
        parsed = {"limit_requests": 600, "limit_tokens": 400000}
        new_entry, status = refresh_rate_limits.merge_model_limits(OLD_ENTRY, parsed)
        self.assertEqual(status, "refreshed")
        self.assertEqual(new_entry, {"requests_per_minute": 600, "tokens_per_minute": 400000, "source": "headers"})

    def test_changed_values_replace_the_old_ones(self):
        """When the provider reports new limits, they are written in place of the old ones."""
        parsed = {"limit_requests": 900, "limit_tokens": 500000}
        new_entry, status = refresh_rate_limits.merge_model_limits(OLD_ENTRY, parsed)
        self.assertEqual(status, "refreshed")
        self.assertEqual(new_entry["requests_per_minute"], 900)
        self.assertEqual(new_entry["tokens_per_minute"], 500000)
        self.assertEqual(new_entry["source"], "headers")

    def test_old_entry_is_not_changed_in_place(self):
        """The table entry passed in is left as it was, so a failed write never half-changes the table."""
        parsed = {"limit_requests": 900, "limit_tokens": 500000}
        refresh_rate_limits.merge_model_limits(OLD_ENTRY, parsed)
        self.assertEqual(OLD_ENTRY, {"requests_per_minute": 600, "tokens_per_minute": 400000})

    def test_real_header_parse_feeds_the_merge(self):
        """Headers parsed by ordeal/limiter.py, with their usual capitals, merge the same way."""
        headers = {"X-RateLimit-Limit-Requests": "120", "X-RateLimit-Limit-Tokens": "200000"}
        new_entry, status = refresh_rate_limits.merge_model_limits(OLD_ENTRY, parse_rate_headers(headers))
        self.assertEqual(status, "refreshed")
        self.assertEqual(new_entry["requests_per_minute"], 120)
        self.assertEqual(new_entry["tokens_per_minute"], 200000)

    def test_missing_header_keeps_old_values_with_reason(self):
        """A reply without the token limit header keeps the old values and says which header is missing."""
        parsed = {"limit_requests": 900}
        new_entry, status = refresh_rate_limits.merge_model_limits(OLD_ENTRY, parsed)
        self.assertTrue(status.startswith("failed: "), status)
        self.assertIn("x-ratelimit-limit-tokens", status)
        self.assertEqual(new_entry, OLD_ENTRY)

    def test_zero_limit_is_not_used(self):
        """A limit of zero is not a real limit, so the old values stay and the reason says it was zero."""
        parsed = {"limit_requests": 0, "limit_tokens": 400000}
        new_entry, status = refresh_rate_limits.merge_model_limits(OLD_ENTRY, parsed)
        self.assertTrue(status.startswith("failed: "), status)
        self.assertIn("x-ratelimit-limit-requests", status)
        self.assertEqual(new_entry, OLD_ENTRY)

    def test_failed_call_keeps_old_values_with_its_reason(self):
        """A call that failed passes its short reason through, and the entry stays exactly as it was."""
        new_entry, status = refresh_rate_limits.merge_model_limits(
            OLD_ENTRY, {}, failure="the server answered 429"
        )
        self.assertEqual(status, "failed: the server answered 429")
        self.assertEqual(new_entry, OLD_ENTRY)
        self.assertNotIn("source", new_entry)


class CheckModelTests(unittest.TestCase):
    """check_model with no client (no key set): nothing is called, and the old entry is kept with 'needs a key'."""

    def test_no_key_gives_needs_a_key_and_keeps_the_entry(self):
        """Without a client the status is 'needs a key' and the entry is the same as before."""
        new_entry, status = refresh_rate_limits.check_model(None, "some/model", OLD_ENTRY)
        self.assertEqual(status, "needs a key")
        self.assertEqual(new_entry, OLD_ENTRY)
        self.assertIsNot(new_entry, OLD_ENTRY)


if __name__ == "__main__":
    unittest.main()
