"""End-to-end tests: run runner.py and grade.py as subprocesses against the local mock server.

No paid call is made. Every request goes to tests/mock_openai.py on 127.0.0.1 with a fake key.
Each run writes to a temporary folder that the test creates and removes. The project's results/
files are only read, and their sizes and modification times are compared again at the end of the module.
"""

import csv
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

from ordeal import core
from tests.mock_openai import MockOpenAIServer
from tests.test_default_codes import DEFAULT_RECORD_KEYS

PROJECT_DIR = Path(__file__).resolve().parent.parent
RUNNER = "ordeal.runner"
GRADER = "ordeal.grade"
FAKE_KEY = "test-key-123"
NO_PROXY_VALUE = "127.0.0.1,localhost"
# Suite fingerprints saved in every record. They are computed from the ladder and question wording, so these
# values must be updated on purpose whenever that wording changes (old saved replies then stop being reused).
V4_HARD_EXPERIMENT = "96efc1daaa50"
V3_EASY_EXPERIMENT = "82f5e58164d9"
# The real results/ files. They are only read; setUpModule and tearDownModule fail the module if any
# of them changes, which proves the tests never wrote to the real results.
RESULTS_FILES = ("cache.jsonl", "results.csv", "probes.csv")
# Matches the per-level flip-rate column names, so the tests can count how many levels a results file has.
FLIP_COLUMN_PATTERN = re.compile(r"flip_rate_level_\d+")
RESULTS_BEFORE: dict[str, tuple[int, int] | None] = {}


def results_snapshot() -> dict[str, tuple[int, int] | None]:
    """Return the size and modification time of each results file, or None when it does not exist."""
    snapshot: dict[str, tuple[int, int] | None] = {}
    for name in RESULTS_FILES:
        path = core.RESULTS_DIR / name
        snapshot[name] = (path.stat().st_size, path.stat().st_mtime_ns) if path.exists() else None
    return snapshot


def setUpModule() -> None:
    """Record the results files before any test runs."""
    RESULTS_BEFORE.update(results_snapshot())


def tearDownModule() -> None:
    """Fail when any results file changed size or modification time during the tests."""
    after = results_snapshot()
    if after != RESULTS_BEFORE:
        raise AssertionError(f"results/ changed during the tests: before {RESULTS_BEFORE}, after {after}")


def child_environment() -> dict[str, str]:
    """Return the environment for a child process: local-only proxy rule and the fake key."""
    environment = dict(os.environ)
    environment["NO_PROXY"] = NO_PROXY_VALUE
    environment["no_proxy"] = NO_PROXY_VALUE
    environment[core.TOKEN_ENV_VAR] = FAKE_KEY
    return environment


def run_script(module: str, args: list[str]) -> subprocess.CompletedProcess:
    """Run a project module with this Python (python -m), from the project folder, and return the finished process."""
    return subprocess.run(
        [sys.executable, "-m", module, *args],
        cwd=PROJECT_DIR,
        env=child_environment(),
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )


def first_model() -> str:
    """Return the first built-in model name from config.json."""
    return core.load_config()["models"][0]


def setup_level_of(ladder: dict[str, Any]) -> int:
    """Return the level number of the entry that has a setup turn."""
    return next(entry["level"] for entry in ladder["levels"] if entry.get("setup_turn"))


# The mock decides which request gets a wrong letter by counting user messages in it. This turns a level
# number into that count: levels from the setup level onward carry one extra user message (the setup turn).
def level_user_turns(level: int, setup_level: int) -> int:
    """Return how many user messages the request for this level holds: question, earlier levels, setup, this level."""
    return level + 1 + (1 if level >= setup_level else 0)


def gauntlet_steps(level_count: int, setup_level: int) -> set[str]:
    """Return the step names of a gauntlet that ends in a confession: baseline, levels, setup and confession."""
    return {core.BASELINE_STEP, *core.pushback_steps(level_count), core.setup_step(setup_level), core.CONFESSION_STEP}


def read_rows(path: Path) -> list[dict[str, Any]]:
    """Return every saved record in a cache file, one dict per line."""
    with open(path, encoding="utf-8") as file:
        return [json.loads(line) for line in file if line.strip()]


def steps_by_question(rows: list[dict[str, Any]]) -> dict[str, set[str]]:
    """Map each question id to the set of step names saved for it."""
    grouped: dict[str, set[str]] = {}
    for row in rows:
        grouped.setdefault(row["question_id"], set()).add(row["step"])
    return grouped


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    """Return the rows of a CSV file as dicts keyed by the header."""
    with open(path, newline="", encoding="utf-8") as file:
        return list(csv.DictReader(file))


# Scripted fake model for the mock server. It answers correctly (so every unit passes its baseline)
# except on the one request that has wrong_turn_count user messages, which makes the flip level exact.
# With baseline_correct=False the first request is wrong, which ends the unit early.
class PressureResponder:
    """Answers with the correct letter, except for the pushed wrong letter on the chosen request."""

    def __init__(self, questions: list[dict[str, Any]], wrong_turn_count: int | None = None,
                 baseline_correct: bool = True) -> None:
        """Index questions by first user message. Requests with 'wrong_turn_count' user turns get a wrong letter."""
        self.by_first_message = {core.format_question(question): question for question in questions}
        self.wrong_turn_count = wrong_turn_count
        self.baseline_correct = baseline_correct

    def __call__(self, request: dict[str, Any]) -> str:
        """Return the reply text for one request body."""
        messages = request["messages"]
        question = self.by_first_message.get(messages[0]["content"])
        if question is None:
            return "Answer: A"
        return f"Answer: {self.letter_for(question, messages)}"

    def letter_for(self, question: dict[str, Any], messages: list[dict[str, Any]]) -> str:
        """Return the pushed wrong letter on the baseline (when it should be wrong) or the chosen turn count."""
        user_turns = sum(1 for message in messages if message["role"] == "user")
        if user_turns == 1 and not self.baseline_correct:
            return question["pushed_wrong"]
        if user_turns == self.wrong_turn_count:
            return question["pushed_wrong"]
        return question["correct"]


# Guards the full 12-level path through the real runner.py and grade.py processes: every step is saved
# under the v4 fingerprint with one request per saved row, and grading a copy of the cache gives numeric
# flip_rate_level_12 values and the Breaking Point table.
class GauntletV4HardTests(unittest.TestCase):
    """A v4 hard run with a flip at level 11, and grade.py on its cache."""

    def setUp(self) -> None:
        """Create the temporary folder for this test. It is removed when the test ends."""
        self.workdir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.cache_path = self.workdir / "cache.jsonl"
        self.suite = core.load_suite(ladder="gauntlet_v4", questions="hard")

    def run_flipping_hard_run(self) -> MockOpenAIServer:
        """Run runner.py on five v4 hard questions, with a wrong letter at level 11 only. Return the mock."""
        setup_level = setup_level_of(self.suite.ladder)
        responder = PressureResponder(self.suite.questions, wrong_turn_count=level_user_turns(11, setup_level))
        mock = self.enterContext(MockOpenAIServer(responder=responder))
        result = run_script(RUNNER, [
            "--ladder", "gauntlet_v4", "--questions", "hard", "--models", first_model(),
            "--limit", "5", "--repeats", "1", "--probes", "gauntlet",
            "--base-url", mock.base_url, "--cache", str(self.cache_path),
        ])
        self.assertEqual(result.returncode, 0, result.stderr)
        return mock

    def test_every_step_is_saved_under_the_v4_fingerprint(self) -> None:
        """Each question writes every v4 step under the v4 fingerprint, with one request per saved row."""
        self.assertEqual(self.suite.experiment, V4_HARD_EXPERIMENT)
        mock = self.run_flipping_hard_run()
        rows = read_rows(self.cache_path)
        expected_ids = {question["id"] for question in self.suite.questions[:5]}
        expected = gauntlet_steps(self.suite.level_count, setup_level_of(self.suite.ladder))
        self.assertEqual(steps_by_question(rows).keys(), expected_ids)
        for question_id, steps in steps_by_question(rows).items():
            self.assertEqual(steps, expected, question_id)
        self.assertTrue(all(row["experiment"] == V4_HARD_EXPERIMENT for row in rows))
        self.assertEqual(len(rows), len(expected_ids) * len(expected))
        self.assertEqual(len(mock.requests), len(rows))

    def test_grade_writes_flip_rate_level_12_and_prints_breaking_point(self) -> None:
        """grade.py on a copy of the cache writes numeric flip_rate_level_12 values and prints the table."""
        self.run_flipping_hard_run()
        cache_copy = self.workdir / "grade_cache.jsonl"
        shutil.copy(self.cache_path, cache_copy)
        out_dir = self.workdir / "grade_out"
        out_dir.mkdir()
        result = run_script(GRADER, [
            "--suite", "gauntlet_v4+hard", "--cache", str(cache_copy), "--out-dir", str(out_dir),
        ])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Breaking Point", result.stdout)
        csv_rows = read_csv_rows(out_dir / "results.csv")
        self.assertTrue(csv_rows)
        self.assertIn("flip_rate_level_12", csv_rows[0])
        for csv_row in csv_rows:
            self.assertTrue(math.isfinite(float(csv_row["flip_rate_level_12"])))


# Guards backward compatibility: with no suite arguments the runner and grader still use the 10-level v3
# ladder and easy questions, with their own fingerprint and ten flip columns.
class GauntletV3EasyDefaultTests(unittest.TestCase):
    """The default v3 easy run with a flip at level 9, and grade.py with its default suite."""

    def setUp(self) -> None:
        """Create the temporary folder for this test. It is removed when the test ends."""
        self.workdir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.cache_path = self.workdir / "cache.jsonl"
        self.suite = core.load_suite()

    def test_default_run_saves_v3_steps_and_grade_writes_ten_flip_columns(self) -> None:
        """The default run saves v3 easy steps under the v3 fingerprint, and grade.py writes ten flip columns."""
        self.assertEqual(self.suite.experiment, V3_EASY_EXPERIMENT)
        setup_level = setup_level_of(self.suite.ladder)
        responder = PressureResponder(self.suite.questions, wrong_turn_count=level_user_turns(9, setup_level))
        with MockOpenAIServer(responder=responder) as mock:
            result = run_script(RUNNER, [
                "--models", first_model(), "--limit", "3", "--repeats", "1", "--probes", "gauntlet",
                "--base-url", mock.base_url, "--cache", str(self.cache_path),
            ])
            request_count = len(mock.requests)
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = read_rows(self.cache_path)
        expected_ids = {question["id"] for question in self.suite.questions[:3]}
        expected = {
            "level_0", *(f"level_{n}" for n in range(1, 11)), "setup_4", "confession",
        }
        self.assertEqual(expected, gauntlet_steps(self.suite.level_count, setup_level))
        self.assertEqual(steps_by_question(rows).keys(), expected_ids)
        for question_id, steps in steps_by_question(rows).items():
            self.assertEqual(steps, expected, question_id)
        self.assertTrue(all(row["experiment"] == V3_EASY_EXPERIMENT for row in rows))
        self.assertEqual(request_count, len(rows))
        self.grade_default_suite()

    def grade_default_suite(self) -> None:
        """Run grade.py with the default suite on a copy of the cache and check the ten flip columns."""
        cache_copy = self.workdir / "grade_cache.jsonl"
        shutil.copy(self.cache_path, cache_copy)
        out_dir = self.workdir / "grade_out"
        out_dir.mkdir()
        result = run_script(GRADER, ["--cache", str(cache_copy), "--out-dir", str(out_dir)])
        self.assertEqual(result.returncode, 0, result.stderr)
        csv_rows = read_csv_rows(out_dir / "results.csv")
        self.assertTrue(csv_rows)
        flip_columns = [name for name in csv_rows[0] if FLIP_COLUMN_PATTERN.fullmatch(name)]
        self.assertEqual(len(flip_columns), 10)


# Guards retries: one injected 429 (rate limit) is retried, so the run still finishes with no failures
# and makes exactly one request more than the number of saved replies.
class RetryTests(unittest.TestCase):
    """A rate-limited first request is retried, and the run still finishes."""

    def setUp(self) -> None:
        """Create the temporary folder for this test. It is removed when the test ends."""
        self.workdir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.cache_path = self.workdir / "cache.jsonl"
        self.suite = core.load_suite()

    def test_rate_limited_first_request_is_retried_and_the_run_finishes(self) -> None:
        """After one injected 429 the run exits 0, saves one row per unit, and sends one extra request."""
        responder = PressureResponder(self.suite.questions, baseline_correct=False)
        with MockOpenAIServer(responder=responder) as mock:
            mock.add_failure(429, 1)
            result = run_script(RUNNER, [
                "--models", first_model(), "--limit", "2", "--repeats", "1", "--probes", "gauntlet",
                "--base-url", mock.base_url, "--cache", str(self.cache_path),
            ])
            request_count = len(mock.requests)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("Failed:", result.stderr)
        rows = read_rows(self.cache_path)
        expected_ids = {question["id"] for question in self.suite.questions[:2]}
        self.assertEqual(steps_by_question(rows).keys(), expected_ids)
        self.assertEqual(len(rows), 2)
        self.assertEqual(request_count, len(rows) + 1)


# Guards the safety rule that --base-url may only point at this machine: a remote URL is refused with exit
# code 2 before any request is made or any cache file is created, so a key can never be sent elsewhere.
class LocalhostRuleTests(unittest.TestCase):
    """A base URL that is not localhost is refused before any request is made."""

    def test_non_local_base_url_exits_with_code_2_and_sends_nothing(self) -> None:
        """runner.py with --base-url https://example.com exits 2, names the rule, and never makes a request."""
        workdir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        cache_path = workdir / "cache.jsonl"
        with MockOpenAIServer() as mock:
            result = run_script(RUNNER, [
                "--models", first_model(), "--limit", "1", "--base-url", "https://example.com",
                "--cache", str(cache_path),
            ])
            request_count = len(mock.requests)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("127.0.0.1 or localhost", result.stderr)
        self.assertEqual(request_count, 0)
        self.assertFalse(cache_path.exists())


# Guards the default run end to end with the offline stub model: with --limit the first N questions of the
# file run in file order, and every saved record has the default keys and no shuffle fields.
class DefaultStubRunTests(unittest.TestCase):
    """A default stub run with --limit saves the first N questions and the default record keys."""

    def setUp(self) -> None:
        """Create the temporary folder for this test. It is removed when the test ends."""
        self.workdir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.cache_path = self.workdir / "c.jsonl"
        self.suite = core.load_suite("gauntlet_v4", "hard")

    def test_default_stub_run_keeps_file_order_and_default_keys(self) -> None:
        """The run saves the first 3 questions of the file, under the default code and with no shuffle fields."""
        result = run_script(RUNNER, [
            "--stub", "--limit", "3", "--ladder", "gauntlet_v4", "--questions", "hard",
            "--cache", str(self.cache_path),
        ])
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = read_rows(self.cache_path)
        self.assertTrue(rows)
        self.assertEqual({row["question_id"] for row in rows}, {question["id"] for question in self.suite.questions[:3]})
        for row in rows:
            with self.subTest(question_id=row["question_id"], step=row["step"]):
                self.assertEqual(row["experiment"], self.suite.experiment)
                self.assertEqual(set(row), DEFAULT_RECORD_KEYS | {"suite"})


if __name__ == "__main__":
    unittest.main()
