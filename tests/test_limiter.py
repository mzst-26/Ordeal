"""Tests for the rate limiter (ordeal/limiter.py). They use a fake clock, so no real time passes and no calls are made."""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from ordeal import limiter

# The header names Nebius sends on every chat reply, copied from a live reply (see RATE_AWARE_SCHEDULING.md).
NEBIUS_HEADERS = {
    "x-ratelimit-limit-requests": "600",
    "x-ratelimit-limit-tokens": "400000",
    "x-ratelimit-remaining-requests": "599",
    "x-ratelimit-remaining-tokens": "399990",
    "x-ratelimit-reset-requests": "1s",
    "x-ratelimit-reset-tokens": "1s",
    "x-ratelimit-dynamic-scale-requests": "1.00",
    "x-ratelimit-dynamic-scale-tokens": "1.00",
}
MODEL = "test/model"
TABLE = {MODEL: {"requests_per_minute": 60, "tokens_per_minute": 100000}}


class FakeClock:
    """A clock that only moves when the code sleeps, so waits can be checked exactly."""

    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        """Return the fake time."""
        return self.now

    async def sleep(self, seconds: float) -> None:
        """Record the wait and move the fake time forward by it."""
        self.sleeps.append(seconds)
        self.now += seconds


def make_pacer(table=TABLE):
    """Return a pacer on a fake clock, with the clock it uses."""
    clock = FakeClock()
    return limiter.Pacer(table=table, clock=clock, sleep=clock.sleep), clock


class ResetSecondsTests(unittest.TestCase):
    """The reset header uses forms such as '1s', '250ms' and '6m0s'."""

    def test_seconds_form_is_read(self) -> None:
        """'1s' means one second."""
        self.assertEqual(limiter.parse_reset_seconds("1s"), 1.0)

    def test_milliseconds_form_is_read(self) -> None:
        """'250ms' means a quarter of a second."""
        self.assertEqual(limiter.parse_reset_seconds("250ms"), 0.25)

    def test_minutes_and_seconds_form_is_read(self) -> None:
        """'1m30s' means ninety seconds."""
        self.assertEqual(limiter.parse_reset_seconds("1m30s"), 90.0)

    def test_empty_or_unknown_text_gives_none(self) -> None:
        """Text that is not a time gives None, so a bad header is ignored rather than trusted."""
        self.assertIsNone(limiter.parse_reset_seconds(""))
        self.assertIsNone(limiter.parse_reset_seconds("soon"))


class RateHeaderTests(unittest.TestCase):
    """Reading the limit and remaining headers from a reply."""

    def test_nebius_headers_are_read_as_numbers(self) -> None:
        """Limits and remaining counts become whole numbers, and the scale becomes a float."""
        parsed = limiter.parse_rate_headers(NEBIUS_HEADERS)
        self.assertEqual(parsed["limit_requests"], 600)
        self.assertEqual(parsed["limit_tokens"], 400000)
        self.assertEqual(parsed["remaining_requests"], 599)
        self.assertEqual(parsed["remaining_tokens"], 399990)
        self.assertEqual(parsed["dynamic_scale"], 1.0)

    def test_header_names_match_in_any_case(self) -> None:
        """Header names are not case-sensitive, so 'X-RateLimit-Limit-Requests' is read too."""
        parsed = limiter.parse_rate_headers({"X-RateLimit-Limit-Requests": "120"})
        self.assertEqual(parsed["limit_requests"], 120)

    def test_missing_and_broken_headers_are_left_out(self) -> None:
        """A header that is missing or not a number is left out, never guessed."""
        parsed = limiter.parse_rate_headers({"x-ratelimit-limit-requests": "lots"})
        self.assertNotIn("limit_requests", parsed)
        self.assertNotIn("limit_tokens", parsed)


class TokenBucketTests(unittest.TestCase):
    """A bucket refills at its rate and a call must wait until enough is in it."""

    def test_full_bucket_admits_at_once(self) -> None:
        """A new bucket holds a full minute of allowance, so the first take needs no wait."""
        clock = FakeClock()
        bucket = limiter.TokenBucket(per_minute=60, clock=clock)
        self.assertEqual(bucket.wait_for(1), 0)

    def test_empty_bucket_waits_for_the_refill(self) -> None:
        """After all 60 are taken, one more needs one second at 60 a minute."""
        clock = FakeClock()
        bucket = limiter.TokenBucket(per_minute=60, clock=clock)
        bucket.take(60)
        self.assertEqual(bucket.wait_for(1), 1.0)


class PacerAdmissionTests(unittest.TestCase):
    """A call is admitted only when the model's limits have room for it."""

    def test_calls_within_the_request_limit_do_not_wait(self) -> None:
        """With 60 a minute and 85% headroom, the first 51 calls go at once."""

        async def scenario() -> FakeClock:
            pacer, clock = make_pacer()
            for _ in range(51):
                estimate = await pacer.admit(MODEL, input_tokens=0)
                pacer.finish_call(MODEL, estimate, seconds=0.1)
            return clock

        clock = asyncio.run(scenario())
        self.assertEqual(clock.sleeps, [])

    def test_the_call_after_the_limit_waits_for_a_refill(self) -> None:
        """The 52nd call waits about 1.18 seconds, which is one token at 0.85 a second."""

        async def scenario() -> FakeClock:
            pacer, clock = make_pacer()
            for _ in range(51):
                estimate = await pacer.admit(MODEL, input_tokens=0)
                pacer.finish_call(MODEL, estimate, seconds=0.1)
            estimate = await pacer.admit(MODEL, input_tokens=0)
            pacer.finish_call(MODEL, estimate, seconds=0.1)
            return clock

        clock = asyncio.run(scenario())
        self.assertEqual(len(clock.sleeps), 1)
        self.assertAlmostEqual(clock.sleeps[0], 1 / 0.85, places=2)

    def test_a_rate_limit_park_holds_the_model_back(self) -> None:
        """After a 429 that says wait 10 seconds, the next call waits at least that long."""

        async def scenario() -> FakeClock:
            pacer, clock = make_pacer()
            pacer.record_rate_limit(MODEL, seconds=10)
            await pacer.admit(MODEL, input_tokens=0)
            return clock

        clock = asyncio.run(scenario())
        self.assertGreaterEqual(sum(clock.sleeps), 10)

    def test_a_park_on_one_model_does_not_hold_back_another(self) -> None:
        """Each model has its own buckets, so a limited model never slows a different one."""

        async def scenario() -> FakeClock:
            pacer, clock = make_pacer(table={})
            pacer.record_rate_limit(MODEL, seconds=10)
            await pacer.admit("other/model", input_tokens=0)
            return clock

        clock = asyncio.run(scenario())
        self.assertEqual(clock.sleeps, [])

    def test_admit_returns_the_estimate_and_frees_the_slot_on_finish(self) -> None:
        """The estimate is input plus expected output, and finishing a call gives its slot back."""

        async def scenario() -> tuple[int, int]:
            pacer, _ = make_pacer()
            estimate = await pacer.admit(MODEL, input_tokens=100)
            in_flight_during = pacer.state_for(MODEL).in_flight
            pacer.finish_call(MODEL, estimate, seconds=0.1)
            return estimate, in_flight_during

        estimate, in_flight_during = asyncio.run(scenario())
        self.assertEqual(estimate, 100 + limiter.START_OUTPUT_TOKENS)
        self.assertEqual(in_flight_during, 1)

    def test_remaining_header_lowers_the_bucket(self) -> None:
        """If the provider says no requests are left, the next call waits for the window to refill."""

        async def scenario() -> FakeClock:
            pacer, clock = make_pacer(table={})
            estimate = await pacer.admit("nebius/model", input_tokens=0)
            pacer.finish_call(
                "nebius/model", estimate, seconds=0.1,
                headers={"x-ratelimit-limit-requests": "600", "x-ratelimit-remaining-requests": "0"},
            )
            await pacer.admit("nebius/model", input_tokens=0)
            return clock

        clock = asyncio.run(scenario())
        # 600 a minute refills 10 a second, and 90 are held back as headroom, so about 9 seconds is needed.
        self.assertGreaterEqual(sum(clock.sleeps), 9)

    def test_real_usage_refunds_the_part_of_the_estimate_not_used(self) -> None:
        """The call reserves 512 tokens, but it really used 200, so 312 go back to the token bucket."""

        async def scenario() -> float:
            pacer, _ = make_pacer(table={})
            estimate = await pacer.admit("nebius/model", input_tokens=0)
            tokens_held = pacer.state_for("nebius/model").tokens.tokens
            pacer.finish_call("nebius/model", estimate, seconds=0.1, prompt_tokens=100, completion_tokens=100)
            return pacer.state_for("nebius/model").tokens.tokens - tokens_held

        self.assertEqual(asyncio.run(scenario()), limiter.START_OUTPUT_TOKENS - 200)


class PacerLimitSourceTests(unittest.TestCase):
    """The limit comes from the live headers first, then the table, then a low default."""

    def test_headers_override_the_table(self) -> None:
        """A reply that says 120 a minute beats the table's 60."""

        async def scenario() -> dict:
            pacer, _ = make_pacer()
            estimate = await pacer.admit(MODEL, input_tokens=0)
            pacer.finish_call(MODEL, estimate, seconds=0.1, headers={"x-ratelimit-limit-requests": "120"})
            return pacer.snapshot()[MODEL]

        info = asyncio.run(scenario())
        self.assertEqual(info["requests_per_minute"], 120)
        self.assertEqual(info["source"], "headers")

    def test_unknown_model_uses_the_low_default(self) -> None:
        """A model in neither the table nor the headers gets the default, and says so."""
        pacer, _ = make_pacer(table={})
        info = pacer.snapshot_for("unknown/model")
        self.assertEqual(info["requests_per_minute"], limiter.DEFAULT_LIMITS["requests_per_minute"])
        self.assertEqual(info["source"], "default")

    def test_dynamic_scale_cuts_the_effective_limit(self) -> None:
        """A provider scale of 0.5 halves the limit the pacer uses, on top of the 85% headroom."""
        pacer, _ = make_pacer()
        pacer.record_headers(MODEL, {"x-ratelimit-dynamic-scale-requests": "0.5"})
        self.assertAlmostEqual(pacer.effective_requests_per_minute(MODEL), 60 * 0.5 * 0.85)


class PacerConcurrencyTests(unittest.TestCase):
    """The number of calls in flight follows rate times latency, and stays between the floor and the ceiling."""

    def test_a_slow_reply_raises_the_in_flight_cap(self) -> None:
        """One 40-second reply lifts the latency estimate, so more calls may be in flight."""
        pacer, _ = make_pacer()
        before = pacer.in_flight_cap(MODEL)
        pacer.finish_call(MODEL, 0, seconds=40)
        self.assertGreater(pacer.in_flight_cap(MODEL), before)

    def test_cap_never_goes_below_the_floor(self) -> None:
        """A model with a tiny limit still gets the minimum number of calls in flight."""
        pacer, _ = make_pacer(table={MODEL: {"requests_per_minute": 1, "tokens_per_minute": 100}})
        self.assertEqual(pacer.in_flight_cap(MODEL), limiter.MIN_IN_FLIGHT)

    def test_cap_never_goes_above_the_ceiling(self) -> None:
        """A model with a huge limit, such as 10 billion a minute, is capped at the ceiling."""
        big = {MODEL: {"requests_per_minute": 10_000_000_000, "tokens_per_minute": 10_000_000_000}}
        pacer, _ = make_pacer(table=big)
        self.assertEqual(pacer.in_flight_cap(MODEL), limiter.MAX_IN_FLIGHT)

    def test_failed_call_frees_the_slot_without_changing_latency(self) -> None:
        """A call that failed has no reply time, so it only gives its slot back."""

        async def scenario() -> tuple[int, float]:
            pacer, _ = make_pacer()
            estimate = await pacer.admit(MODEL, input_tokens=0)
            pacer.finish_call(MODEL, estimate)
            state = pacer.state_for(MODEL)
            return state.in_flight, state.latency_seconds

        in_flight, latency = asyncio.run(scenario())
        self.assertEqual(in_flight, 0)
        self.assertEqual(latency, limiter.START_LATENCY_SECONDS)


class RateTableTests(unittest.TestCase):
    """The table of limits that ships with the project, and how it is read."""

    def test_shipped_table_has_gemma_limits_from_the_console(self) -> None:
        """gemma-3-27b-it is 600 requests and 400,000 tokens a minute on the console table."""
        table = limiter.load_rate_table()
        self.assertEqual(table["google/gemma-3-27b-it"]["requests_per_minute"], 600)
        self.assertEqual(table["google/gemma-3-27b-it"]["tokens_per_minute"], 400000)

    def test_shipped_table_has_no_embedding_or_vision_models(self) -> None:
        """Embedding and vision models are left out, because the chat test cannot check them and the runs do not use them."""
        # These name parts mark an embedding model or a vision model in the provider's model names.
        excluded_parts = ("embedding", "minicpm-v", "-vl")
        table = limiter.load_rate_table()
        kept = [model for model in table if any(part in model.lower() for part in excluded_parts)]
        self.assertEqual(kept, [])

    def test_every_shipped_entry_has_positive_limits(self) -> None:
        """Each entry has both limits as positive whole numbers, so none can divide by zero."""
        table = limiter.load_rate_table()
        self.assertGreaterEqual(len(table), 27)
        for model, limits in table.items():
            with self.subTest(model=model):
                self.assertGreater(limits["requests_per_minute"], 0)
                self.assertGreater(limits["tokens_per_minute"], 0)

    def test_missing_table_file_gives_an_empty_table(self) -> None:
        """No file means no table, so every model falls back to the default rather than crashing."""
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(limiter.load_rate_table(Path(folder) / "absent.json"), {})

    def test_a_table_file_is_read_by_model_name(self) -> None:
        """The model names in the file become the keys of the returned table."""
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "rates.json"
            path.write_text(json.dumps({"models": {MODEL: {"requests_per_minute": 5, "tokens_per_minute": 9}}}))
            self.assertEqual(limiter.load_rate_table(path)[MODEL]["requests_per_minute"], 5)


class EstimateTests(unittest.TestCase):
    """The input estimate is a rough count from characters, used to reserve tokens before a call."""

    def test_four_characters_count_as_one_token(self) -> None:
        """400 characters of message text give 100 estimated tokens."""
        self.assertEqual(limiter.estimate_input_tokens([{"role": "user", "content": "x" * 400}]), 100)


# Guards the snapshot file written after each run. It is read by people, so it must hold the models and their
# numbers, and it must never hold a key or an authorization header, even though the replies carry headers.
class WriteSnapshotTests(unittest.TestCase):
    """The snapshot file: the models, the folder is created, and no key or bearer text."""

    def test_file_holds_every_model_and_its_folder_is_created(self) -> None:
        """The file is written under a folder that did not exist, with one entry per model the pacer has seen."""
        pacer = limiter.Pacer(table=TABLE)
        pacer.state_for(MODEL)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "new" / "nested" / "rate_limits.json"
            limiter.write_snapshot(pacer, path)
            written = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(set(written), {MODEL})
        self.assertEqual(written[MODEL]["requests_per_minute"], 60)
        self.assertEqual(written[MODEL]["source"], "table")

    def test_file_has_no_key_or_bearer_text_even_after_headers_are_read(self) -> None:
        """Headers are read into the pacer, but the file keeps only the numbers, so no bearer or key text appears."""
        pacer = limiter.Pacer(table={})
        pacer.record_headers(MODEL, {**NEBIUS_HEADERS, "Authorization": "Bearer secret-token-value"})
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "rate_limits.json"
            limiter.write_snapshot(pacer, path)
            text = path.read_text(encoding="utf-8").lower()
        for forbidden in ("bearer", "secret-token-value", "authorization", "api_key", "sk-"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, text)

    def test_file_is_indented_with_sorted_keys(self) -> None:
        """Keys are sorted and indented by two spaces, so the file reads the same from one run to the next."""
        pacer = limiter.Pacer(table={})
        pacer.state_for("zeta/model")
        pacer.state_for("alpha/model")
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "rate_limits.json"
            limiter.write_snapshot(pacer, path)
            text = path.read_text(encoding="utf-8")
        self.assertTrue(text.startswith('{\n  "alpha/model"'))
        self.assertLess(text.index("alpha/model"), text.index("zeta/model"))


if __name__ == "__main__":
    unittest.main()
