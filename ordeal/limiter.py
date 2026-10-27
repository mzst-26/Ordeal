"""Pace the calls to each model so that it stays inside the limits its endpoint reports.

Why this exists: each model has its own limit on requests and on tokens per minute, and the limits differ
a lot (from 100 to 10,000 requests a minute on the Nebius console). One fixed number of calls at once suits
none of them. Too many for a slow model and the provider refuses calls; too few for a fast one and the run
waits for nothing. So each model gets two buckets that refill at its limit, and a call waits until both have
room for it.

Where the limits come from, most trusted first:
  1. The rate-limit headers on the latest reply from that model. The provider changes them, so they win.
  2. ordeal/data/rate_limits.json, the table copied from the provider's console.
  3. DEFAULT_LIMITS, for a model in neither. It is deliberately low, so an unknown model starts slowly.

Every limit is used at HEADROOM (85%) of its value, so a burst of retries does not reach the real ceiling.
The provider's own scale factor (dynamic-scale headers) is applied on top of that.
"""

import asyncio
import json
import math
import re
import time
from pathlib import Path
from typing import Any, Callable

# The table of limits that ships with the project. A missing file is allowed: every model then uses the default.
RATE_LIMITS_PATH = Path(__file__).resolve().parent / "data" / "rate_limits.json"
# Used for a model with no limits from the headers or the table. Low on purpose, so an unknown model starts slowly.
DEFAULT_LIMITS = {"requests_per_minute": 60, "tokens_per_minute": 100000}
# Only this share of each limit is used, so retries and small surges do not reach the provider's real ceiling.
HEADROOM = 0.85
# Calls in flight are allowed to exceed the rate times the latency by this much, to absorb slow replies.
SAFETY_FACTOR = 1.5
# The smallest and largest number of calls one model may have in flight at once.
MIN_IN_FLIGHT = 2
MAX_IN_FLIGHT = 64
# Before any reply has been measured, a model is assumed to answer in this many seconds...
START_LATENCY_SECONDS = 5.0
# ...and to write this many tokens. A call reserves input plus this estimate before it is sent.
START_OUTPUT_TOKENS = 512
# How much each new measurement counts in the running average. 0.2 means 20% new, 80% old.
SMOOTHING = 0.2
# How often a call waiting for a free slot checks again, in seconds.
IN_FLIGHT_POLL_SECONDS = 0.05
# Rough conversion for the input estimate: about four characters make one token in English text.
CHARS_PER_TOKEN = 4
SECONDS_PER_MINUTE = 60.0
# Float rounding can leave a bucket a hair under a whole token. This tolerance stops that from causing a wait.
EPSILON = 1e-9

# The header names the provider sends on every reply, and the field each one fills in parse_rate_headers.
HEADER_FIELDS = {
    "x-ratelimit-limit-requests": "limit_requests",
    "x-ratelimit-limit-tokens": "limit_tokens",
    "x-ratelimit-remaining-requests": "remaining_requests",
    "x-ratelimit-remaining-tokens": "remaining_tokens",
    "x-ratelimit-reset-requests": "reset_requests_seconds",
    "x-ratelimit-reset-tokens": "reset_tokens_seconds",
    "x-ratelimit-dynamic-scale-requests": "dynamic_scale_requests",
    "x-ratelimit-dynamic-scale-tokens": "dynamic_scale_tokens",
}
# Reset times look like "1s", "250ms", "6m0s" or "1m30s". Each part is optional, and at least one must be present.
RESET_PATTERN = re.compile(r"^(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$")


def parse_reset_seconds(text: str) -> float | None:
    """Return the number of seconds in a reset header such as '1s' or '1m30s', or None if it is not a time.

    A missing or unreadable reset is None, so the caller falls back to its own refill rate rather than
    trusting a wrong number.
    """
    text = str(text).strip()
    match = RESET_PATTERN.match(text)
    if not text or match is None:
        return None
    minutes, seconds, milliseconds = match.groups()
    total = 0.0
    if minutes is not None:
        total += int(minutes) * SECONDS_PER_MINUTE
    if seconds is not None:
        total += float(seconds)
    if milliseconds is not None:
        total += int(milliseconds) / 1000
    return total


def parse_rate_headers(headers: Any) -> dict[str, Any]:
    """Return the rate-limit fields found in a reply's headers. Fields that are missing or unreadable are left out.

    Header names are not case-sensitive, so the names are lower-cased before they are matched.
    The result has the keys in HEADER_FIELDS, plus 'dynamic_scale', the smaller of the two scale headers.
    """
    lowered = {str(name).lower(): str(value).strip() for name, value in headers.items()}
    parsed: dict[str, Any] = {}
    for header, field in HEADER_FIELDS.items():
        if header not in lowered:
            continue
        value = _read_field(field, lowered[header])
        if value is not None:
            parsed[field] = value
    scales = [parsed[name] for name in ("dynamic_scale_requests", "dynamic_scale_tokens") if name in parsed]
    if scales:
        parsed["dynamic_scale"] = min(scales)
    return parsed


def _read_field(field: str, text: str) -> float | int | None:
    """Turn one header's text into its number. A reset becomes seconds, a scale a float, the rest whole numbers."""
    if field.startswith("reset_"):
        return parse_reset_seconds(text)
    if field.startswith("dynamic_scale"):
        return _positive_float(text)
    return _whole_number(text)


def _whole_number(text: str) -> int | None:
    """Return the text as a whole number that is zero or more, or None if it is not one."""
    try:
        number = int(text)
    except ValueError:
        return None
    return number if number >= 0 else None


def _positive_float(text: str) -> float | None:
    """Return the text as a number above zero, or None if it is not one."""
    try:
        number = float(text)
    except ValueError:
        return None
    return number if number > 0 else None


def estimate_input_tokens(messages: list[dict[str, Any]]) -> int:
    """Return a rough token count for the messages, from their characters.

    It is only used to reserve room before a call. The real count comes back with the reply and corrects the
    bucket, so an estimate that is a little low does not add up over a run.
    """
    characters = sum(len(str(message.get("content") or "")) for message in messages)
    return math.ceil(characters / CHARS_PER_TOKEN)


def load_rate_table(path: Path = RATE_LIMITS_PATH) -> dict[str, dict[str, int]]:
    """Return the model limits from the table file, keyed by model name. A missing file gives an empty table."""
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as file:
        return json.load(file)["models"]


class TokenBucket:
    """A bucket that holds up to one minute of allowance and refills at a steady rate.

    Taking from the bucket can make it negative. That is a debt: the next call then waits until the bucket is
    back above zero. Debt is how a call that was bigger than the room left still gets sent, later, not never.
    """

    def __init__(self, per_minute: float, clock: Callable[[], float]) -> None:
        """Start the bucket full, filled to the given rate per minute."""
        self.clock = clock
        self.capacity = float(per_minute)
        self.refill_per_second = self.capacity / SECONDS_PER_MINUTE
        self.tokens = self.capacity
        self.last_time = clock()

    def set_rate(self, per_minute: float) -> None:
        """Change the rate, for example when the provider sends new limits. The level is kept, but never above the new size."""
        self._refill()
        self.capacity = float(per_minute)
        self.refill_per_second = self.capacity / SECONDS_PER_MINUTE
        self.tokens = min(self.tokens, self.capacity)

    def wait_for(self, amount: float) -> float:
        """Return how many seconds to wait before 'amount' is available. Zero means it can be taken now.

        An amount bigger than the whole bucket only needs the bucket to be full, so it is never waited on forever.
        """
        self._refill()
        needed = min(amount, self.capacity)
        if self.tokens + EPSILON >= needed:
            return 0.0
        return (needed - self.tokens) / self.refill_per_second

    def take(self, amount: float) -> None:
        """Remove 'amount' from the bucket. It may go negative (see the class note)."""
        self._refill()
        self.tokens -= amount

    def refund(self, amount: float) -> None:
        """Put back 'amount', for example the part of a token reservation that a reply did not use."""
        self._refill()
        self.tokens = min(self.capacity, self.tokens + amount)

    def limit_remaining(self, remaining: float, reserve: float) -> None:
        """Lower the level to what the provider says is left, keeping 'reserve' back for other callers."""
        self._refill()
        self.tokens = min(self.tokens, remaining - reserve)

    def _refill(self) -> None:
        """Add the allowance earned since the last change, up to the capacity."""
        now = self.clock()
        earned = (now - self.last_time) * self.refill_per_second
        self.tokens = min(self.capacity, self.tokens + earned)
        self.last_time = now


class ModelState:
    """What the pacer knows about one model: its limits, its two buckets, and how many calls are running."""

    def __init__(self, name: str, table_limits: dict[str, int] | None, clock: Callable[[], float]) -> None:
        """Start with the table's limits, or the default when the table has none for this model."""
        self.name = name
        self.clock = clock
        self.table_limits = table_limits
        # Filled from the provider's headers when a reply arrives. Empty until then.
        self.header_limits: dict[str, int] = {}
        self.remaining: dict[str, int] = {}
        self.dynamic_scale = 1.0
        self.in_flight = 0
        self.latency_seconds = START_LATENCY_SECONDS
        self.output_tokens = START_OUTPUT_TOKENS
        self.parked_until = 0.0
        self.calls = 0
        self.rate_limited = 0
        rpm, tpm = self.effective_rates()
        self.requests = TokenBucket(rpm, clock)
        self.tokens = TokenBucket(tpm, clock)

    def real_limits(self) -> dict[str, int]:
        """Return the provider's limits before headroom. Each one comes from the headers, else the table, else the default."""
        limits = {}
        for key in ("requests_per_minute", "tokens_per_minute"):
            limits[key] = self._header_or_table(key)
        return limits

    def _header_or_table(self, key: str) -> int:
        """Return one limit: the header value if the provider sent one, else the table's, else the default."""
        header_key = "limit_requests" if key == "requests_per_minute" else "limit_tokens"
        if header_key in self.header_limits:
            return self.header_limits[header_key]
        if self.table_limits and key in self.table_limits:
            return self.table_limits[key]
        return DEFAULT_LIMITS[key]

    def source(self) -> str:
        """Say where the limits came from: 'headers', 'table' or 'default'. The page shows this, so readers can tell them apart."""
        if self.header_limits:
            return "headers"
        if self.table_limits:
            return "table"
        return "default"

    def effective_rates(self) -> tuple[float, float]:
        """Return (requests, tokens) per minute that the pacer actually uses: the limit, times the scale, times the headroom."""
        real = self.real_limits()
        scale = self.dynamic_scale * HEADROOM
        return real["requests_per_minute"] * scale, real["tokens_per_minute"] * scale

    def sync_rates(self) -> None:
        """Apply the current effective rates to both buckets. Called after anything that changes a limit."""
        rpm, tpm = self.effective_rates()
        self.requests.set_rate(rpm)
        self.tokens.set_rate(tpm)

    def absorb_headers(self, parsed: dict[str, Any]) -> None:
        """Take the limits and the remaining counts from a reply's headers, and apply them to the buckets."""
        if "limit_requests" in parsed:
            self.header_limits["limit_requests"] = parsed["limit_requests"]
        if "limit_tokens" in parsed:
            self.header_limits["limit_tokens"] = parsed["limit_tokens"]
        if "dynamic_scale" in parsed:
            self.dynamic_scale = parsed["dynamic_scale"]
        self.sync_rates()
        if "remaining_requests" in parsed:
            self.remaining["requests"] = parsed["remaining_requests"]
            self.requests.limit_remaining(parsed["remaining_requests"], self._reserve("requests_per_minute"))
        if "remaining_tokens" in parsed:
            self.remaining["tokens"] = parsed["remaining_tokens"]
            self.tokens.limit_remaining(parsed["remaining_tokens"], self._reserve("tokens_per_minute"))

    def _reserve(self, key: str) -> float:
        """Return the part of a limit kept back from our own use, so the provider's count can be trusted."""
        return self.real_limits()[key] * (1 - HEADROOM)

    def in_flight_cap(self) -> int:
        """Return how many calls may be in flight at once: requests per second times latency, with a safety factor.

        Little's law: if replies take L seconds and requests are allowed R a second, about R times L calls are
        waiting on the provider at any time. More than that only queues on the provider's side.
        """
        requests_per_second = self.effective_rates()[0] / SECONDS_PER_MINUTE
        wanted = math.ceil(requests_per_second * self.latency_seconds * SAFETY_FACTOR)
        return max(MIN_IN_FLIGHT, min(MAX_IN_FLIGHT, wanted))

    def seconds_until_free(self, estimate: float) -> float:
        """Return how long a new call must wait: the longest of a 429 park and the two buckets."""
        parked = max(0.0, self.parked_until - self.clock())
        return max(parked, self.requests.wait_for(1), self.tokens.wait_for(estimate))

    def start_call(self, estimate: float) -> None:
        """Take one request and the estimated tokens from the buckets, and count the call as in flight."""
        self.requests.take(1)
        self.tokens.take(estimate)
        self.in_flight += 1
        self.calls += 1


class Pacer:
    """Decides when each model may be called, and learns its limits from the replies.

    Each model has its own state, so a model that is limited, or that is slow, never holds back another model.
    The clock and the sleep are passed in, so the tests can run without waiting.
    """

    def __init__(
        self,
        table: dict[str, dict[str, int]] | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Any] = asyncio.sleep,
    ) -> None:
        """Use the given table of limits, or the shipped one when none is given."""
        self.table = load_rate_table() if table is None else table
        self.clock = clock
        self.sleep = sleep
        self.states: dict[str, ModelState] = {}

    def state_for(self, model: str) -> ModelState:
        """Return the state of one model, creating it the first time the model is seen."""
        if model not in self.states:
            self.states[model] = ModelState(model, self.table.get(model), self.clock)
        return self.states[model]

    async def admit(self, model: str, input_tokens: int) -> float:
        """Wait until the model has room for one more call, then take the room. Return the token estimate used.

        The caller must call finish_call with the returned estimate when the call ends, so the slot is given back.
        """
        state = self.state_for(model)
        estimate = input_tokens + state.output_tokens
        while True:
            wait = state.seconds_until_free(estimate)
            if wait <= 0 and state.in_flight < state.in_flight_cap():
                state.start_call(estimate)
                return estimate
            # Either a limit needs time to refill or the in-flight cap is full. Both wait, but a full cap has no
            # refill time to wait for, so it polls again soon.
            await self.sleep(max(wait, IN_FLIGHT_POLL_SECONDS))

    def finish_call(
        self,
        model: str,
        estimate: float,
        seconds: float | None = None,
        headers: dict[str, Any] | None = None,
        prompt_tokens: int | None = None,
        completion_tokens: int | None = None,
    ) -> None:
        """Give back the slot of a call that has ended, and learn from what it returned.

        A failed call has no 'seconds' and no usage, so it only frees its slot. The reserved tokens stay spent,
        which is the safe side: a failed call may still have used the provider's allowance.
        """
        state = self.state_for(model)
        state.in_flight = max(0, state.in_flight - 1)
        if seconds is not None:
            state.latency_seconds = SMOOTHING * seconds + (1 - SMOOTHING) * state.latency_seconds
        if prompt_tokens is not None and completion_tokens is not None:
            # Give back the part of the reservation that the reply did not use, and learn the real output size.
            state.tokens.refund(estimate - (prompt_tokens + completion_tokens))
            state.output_tokens = SMOOTHING * completion_tokens + (1 - SMOOTHING) * state.output_tokens
        if headers:
            state.absorb_headers(parse_rate_headers(headers))

    def record_headers(self, model: str, headers: dict[str, Any]) -> None:
        """Learn the limits from headers that came without a call, for example from a refresh."""
        self.state_for(model).absorb_headers(parse_rate_headers(headers))

    def record_rate_limit(self, model: str, seconds: float) -> None:
        """Park one model for the time a 429 asked for. Other models keep running."""
        state = self.state_for(model)
        state.parked_until = max(state.parked_until, self.clock() + seconds)
        state.rate_limited += 1

    def in_flight_cap(self, model: str) -> int:
        """Return the number of calls this model may have in flight at once."""
        return self.state_for(model).in_flight_cap()

    def effective_requests_per_minute(self, model: str) -> float:
        """Return the requests per minute the pacer uses for this model, after headroom and scale."""
        return self.state_for(model).effective_rates()[0]

    def snapshot_for(self, model: str) -> dict[str, Any]:
        """Return what is known about one model, in plain numbers and words that can be written to a file."""
        state = self.state_for(model)
        real = state.real_limits()
        return {
            "requests_per_minute": real["requests_per_minute"],
            "tokens_per_minute": real["tokens_per_minute"],
            "source": state.source(),
            "dynamic_scale": state.dynamic_scale,
            "in_flight_cap": state.in_flight_cap(),
            "latency_seconds": round(state.latency_seconds, 3),
            "calls": state.calls,
            "rate_limited": state.rate_limited,
        }

    def snapshot(self) -> dict[str, dict[str, Any]]:
        """Return the snapshot of every model seen so far, keyed by model name."""
        return {model: self.snapshot_for(model) for model in self.states}


def write_snapshot(pacer: Pacer, path: Path) -> None:
    """Write what the pacer learned about each model to a JSON file, creating the folder if it is missing.

    The file is for people to read after a run: the limits each model ended with, where they came from, and how
    many calls and rate-limit errors it had. Keys are sorted and indented, so the file reads the same way from run
    to run. It holds only the numbers from snapshot_for, never a key or a header value.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as file:
        json.dump(pacer.snapshot(), file, indent=2, sort_keys=True)
        file.write("\n")
