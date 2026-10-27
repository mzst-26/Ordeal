"""Full-scale stub run: 96 questions, 30 model names, all four conditions, and no spend.

This is the largest run the scheduler is asked to make, and it uses the offline stub, so no call reaches a provider.
It checks three things:
- the most calls in flight at once is exactly config["concurrency"]: the shared slots are used fully and never exceeded;
- every (condition, model, question, repeat) unit is saved once, so no cache key is saved twice;
- a run killed part way through, then resumed, saves the same keys as a run that was never interrupted.

Each unit asks only its first question, with no pressure flows. The scheduler is the same either way; the flows
only add more steps to a unit, so the run would just be larger. The 96 questions are the 32 easy questions, each
used three times with its own id (for example c01-1, c01-2, c01-3). The ids are what make the keys distinct.

No network call is made, and the real cache is never written. Only temporary folders are used.
"""

import asyncio
import contextlib
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any

from ordeal import core
from ordeal import limiter
from ordeal import model_client
from ordeal import runner
from ordeal import store
from ordeal.runner import RunSettings
from ordeal.stub_model import StubModel

PROJECT_DIR = Path(__file__).resolve().parent.parent
QUESTION_COUNT = 96
MODEL_COUNT = 30
# The killed child is stopped once its cache file has grown to this size, which is part way through the run.
KILL_AFTER_BYTES = 2_000_000
# Keys are compared as text: the five parts of a key joined with this separator, as the scheduler snapshot does.
KEY_SEPARATOR = "|"
MODELS = [f"stub-{number:02d}" for number in range(1, MODEL_COUNT + 1)]
LADDER_NAME = "gauntlet_v3"
QUESTION_SET = "easy"
SUITE = core.load_suite(ladder=LADDER_NAME, questions=QUESTION_SET)


def make_questions() -> list[dict[str, Any]]:
    """Return 96 questions: the easy questions repeated, each copy with its own id, such as c01-2.

    The copies keep the text and the right answer of their original, so the stub answers each copy the same way.
    """
    originals = SUITE.questions
    questions = []
    for index in range(QUESTION_COUNT):
        copy = dict(originals[index % len(originals)])
        # The round number makes the id unique: index maps to (position, round) one to one.
        copy["id"] = f"{copy['id']}-{index // len(originals) + 1}"
        questions.append(copy)
    return questions


class OverlappingStub(StubModel):
    """The stub, but each call gives up the event loop once, so calls overlap as real network calls do.

    Without the pause, a stub call finishes before the next one starts, and the peak in flight would be 1.
    The counters are read after the run to check the peak and the number of calls.
    """

    def __init__(self, questions: list[dict[str, Any]]) -> None:
        super().__init__(questions)
        self.in_flight = 0
        self.peak_in_flight = 0
        self.calls = 0

    async def complete_detailed(
        self, model: str, messages: list[dict[str, str]], temperature: float, max_tokens: int
    ) -> model_client.Reply:
        """Count the call as in flight while it waits, then answer as the stub does."""
        self.in_flight += 1
        self.calls += 1
        self.peak_in_flight = max(self.peak_in_flight, self.in_flight)
        try:
            await asyncio.sleep(0)
            return await super().complete_detailed(model, messages, temperature, max_tokens)
        finally:
            self.in_flight -= 1


def make_settings(config: dict[str, Any]) -> RunSettings:
    """Build the settings the way main() does for the first condition. run_all gives each other condition its copy."""
    return RunSettings(
        condition=core.NO_SYSTEM_PROMPT,
        system_prompt=core.system_prompt_for(core.NO_SYSTEM_PROMPT, config),
        config=config,
        ladder=SUITE.ladder,
        probe_spec=SUITE.probe_spec,
        families=frozenset(),
        is_retryable=model_client.is_retryable,
        describe_error=model_client.describe_error,
        suite=SUITE,
    )


def run_schedule(
    cache_path: Path, client: OverlappingStub, cache: dict[tuple[Any, ...], dict[str, Any]] | None = None
) -> None:
    """Run the full schedule into cache_path. Replies in 'cache' are reused, so a resumed run makes only missing calls."""
    config = core.load_config()
    # run_all prints one progress line per unit. The output is hidden so the test output stays readable.
    with contextlib.redirect_stdout(io.StringIO()):
        asyncio.run(runner.run_all(
            client, cache or {}, cache_path, make_questions(), MODELS, config["repeats"], make_settings(config),
            pacer=limiter.Pacer(paced=False), conditions=list(core.CONDITIONS),
        ))


def read_key_lines(cache_path: Path) -> tuple[list[str], int]:
    """Return the key of every saved line, in file order, and the number of damaged lines.

    The keys are read from the file, not from the in-memory dict, because the dict hides duplicate lines.
    """
    keys = []
    damaged = 0
    for line in cache_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            damaged += 1
            continue
        keys.append(KEY_SEPARATOR.join(str(part) for part in core.record_key(record)))
    return keys, damaged


def expected_keys(config: dict[str, Any]) -> list[str]:
    """Return the key every unit must save, in sorted order: each condition, model, question and repeat, once."""
    keys = []
    questions = make_questions()
    for condition in core.CONDITIONS:
        for model in MODELS:
            for question in questions:
                for repeat in range(1, config["repeats"] + 1):
                    keys.append(KEY_SEPARATOR.join((condition, model, question["id"], str(repeat), core.BASELINE_STEP)))
    return sorted(keys)


def run_child_until_killed(cache_path: Path) -> int:
    """Start the full run in a child process, kill it with SIGKILL once its cache is big enough, and return its exit code.

    A SIGKILL gives the child no chance to clean up, the same as a crash or a closed laptop. Each reply is written
    as one line, so the file can end with at most one cut-off line, which load_cache skips.
    """
    child = subprocess.Popen(
        [sys.executable, "-m", "tests.test_full_scale_stub", "--child", str(cache_path)],
        cwd=PROJECT_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        while child.poll() is None:
            if cache_path.exists() and cache_path.stat().st_size >= KILL_AFTER_BYTES:
                child.send_signal(signal.SIGKILL)
                break
            time.sleep(0.01)
    finally:
        child.wait()
    return child.returncode


class FullScaleStubTests(unittest.TestCase):
    """The 96 x 30 x 4 run uses every call slot, saves each unit once, and resumes to the same keys."""

    def setUp(self) -> None:
        """Create a temporary folder for the cache, so the real cache is never touched."""
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.folder = Path(temp_dir.name)

    def test_peak_in_flight_is_the_concurrency_cap_and_each_unit_is_saved_once(self) -> None:
        """The run uses exactly config["concurrency"] slots at its busiest, and no key is saved twice."""
        config = core.load_config()
        client = OverlappingStub(make_questions())
        cache_path = self.folder / "cache.jsonl"
        run_schedule(cache_path, client)
        keys, damaged = read_key_lines(cache_path)
        self.assertEqual(client.peak_in_flight, config["concurrency"])
        self.assertEqual(damaged, 0)
        self.assertEqual(len(keys), len(set(keys)), "a cache key was saved twice")
        self.assertEqual(client.calls, len(keys))
        self.assertEqual(sorted(keys), expected_keys(config))

    def test_a_run_killed_part_way_resumes_to_the_same_keys(self) -> None:
        """A killed run is resumed from its cache, and the finished file has the same keys as an uninterrupted run."""
        config = core.load_config()
        cache_path = self.folder / "cache.jsonl"
        return_code = run_child_until_killed(cache_path)
        # If the child had finished first, there would be nothing to resume. The run is sized so that does not happen.
        self.assertEqual(return_code, -signal.SIGKILL, "the run finished before it could be killed")
        partial_keys, _ = read_key_lines(cache_path)
        self.assertLess(len(partial_keys), len(expected_keys(config)))
        saved = core.load_cache(cache_path, experiment=SUITE.experiment)
        # runner.main repairs the file before it resumes. This test calls run_all directly, so it does the same step.
        store.repair_jsonl_from_store(cache_path)
        run_schedule(cache_path, OverlappingStub(make_questions()), cache=saved)
        keys, damaged = read_key_lines(cache_path)
        self.assertEqual(damaged, 0)
        self.assertEqual(len(keys), len(set(keys)), "a cache key was saved twice after the resume")
        self.assertEqual(sorted(keys), expected_keys(config))


if __name__ == "__main__":
    # A child process started by run_child_until_killed runs the schedule and is then killed by its parent.
    if len(sys.argv) == 3 and sys.argv[1] == "--child":
        run_schedule(Path(sys.argv[2]), OverlappingStub(make_questions()))
    else:
        unittest.main()
