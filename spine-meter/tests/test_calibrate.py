"""Tests for calibrate.py, run against the local mock in tests/mock_openai.py. No outbound calls are made.

The calibration subprocesses use --base-url pointing at 127.0.0.1 and write only to a temp folder.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

import calibrate
import core
from tests.mock_openai import DEFAULT_KEY, MockOpenAIServer

PROJECT_DIR = Path(__file__).resolve().parent.parent
CALIBRATE = PROJECT_DIR / "calibrate.py"
# Small, fast settings: the v4 hard suite, only 3 questions, 2 repeats.
LADDER = "gauntlet_v4"
QUESTIONS = "hard"
QUESTION_LIMIT = 3
REPEATS = 2


# Used by the responder below to give a reliably wrong reply.
def wrong_letter(question):
    """Return an option letter that is not the correct one."""
    return next(letter for letter in question["options"] if letter != question["correct"])


# Baseline asks (a single message) are right the first time per question and wrong after that; any longer conversation (a probe) is wrong.
# So the calibration has some questions that look baseline-correct and probes that flip.
def make_responder(questions):
    """Return a mock responder: the first baseline ask of each question is right, later asks and probes are wrong."""
    by_prompt = {core.format_question(question): question for question in questions}
    asked = Counter()

    def respond(request_json):
        messages = request_json["messages"]
        question = by_prompt[messages[0]["content"]]
        if len(messages) == 1:
            asked[question["id"]] += 1
            letter = question["correct"] if asked[question["id"]] == 1 else wrong_letter(question)
        else:
            letter = wrong_letter(question)
        return f"Answer: {letter}"

    return respond


def calibrate_command(mode, out_dir, base_url=None):
    """Return the command line for one mode, with a temp out-dir and the test flags."""
    command = [
        sys.executable, str(CALIBRATE), mode,
        "--ladder", LADDER, "--questions", QUESTIONS,
        "--limit", str(QUESTION_LIMIT), "--repeats", str(REPEATS),
        "--out-dir", str(out_dir),
    ]
    if base_url is not None:
        command += ["--base-url", base_url]
    return command


def run_calibrate(command, key):
    """Run calibrate.py in a subprocess with the given key, and no proxy for localhost.

    key=None sets TOKEN_FACTORY_TOKEN to an empty string. core.load_env_file() only fills variables that are
    missing, so an empty value stops a .env file from supplying the real key.
    """
    env = {name: value for name, value in os.environ.items() if name != core.TOKEN_ENV_VAR}
    env["NO_PROXY"] = "127.0.0.1,localhost"
    env[core.TOKEN_ENV_VAR] = "" if key is None else key
    return subprocess.run(command, cwd=PROJECT_DIR, env=env, capture_output=True, text=True, timeout=300)


# Group: runs calibrate.py as a subprocess against the mock. Proves baseline and screen write their files with one row per axis sent,
# the API key never appears in any output or file, a missing key stops before any call, the cache key depends on the endpoint,
# the default output folder is scratch/, and a non-local --base-url is refused.
class CalibrateTests(unittest.TestCase):
    """Baseline and screen modes against the mock, plus the missing-key refusal."""

    def setUp(self):
        """Start a fresh mock and a temp folder for each test."""
        self.suite = core.load_suite(ladder=LADDER, questions=QUESTIONS)
        self.mock = MockOpenAIServer(responder=make_responder(self.suite.questions), api_key=DEFAULT_KEY)
        self.mock.__enter__()
        self.temp = tempfile.TemporaryDirectory()
        self.out_dir = Path(self.temp.name)

    def tearDown(self):
        """Stop the mock and remove the temp folder."""
        self.mock.__exit__(None, None, None)
        self.temp.cleanup()

    def test_baseline_then_screen_write_files_and_one_row_per_axis(self):
        """Baseline writes calibration files; screen writes screen.json with one row per axis sent."""
        baseline = run_calibrate(calibrate_command("baseline", self.out_dir, self.mock.base_url), DEFAULT_KEY)
        self.assertEqual(baseline.returncode, 0, baseline.stderr)
        self.assertTrue((self.out_dir / "calibration.json").exists())
        keep = json.loads((self.out_dir / "calibration_keep.json").read_text(encoding="utf-8"))
        self.assertEqual(len(keep), QUESTION_LIMIT)
        self.assertTrue((self.out_dir / "calib_cache.jsonl").exists())

        requests_before = len(self.mock.requests)
        screen = run_calibrate(calibrate_command("screen", self.out_dir, self.mock.base_url), DEFAULT_KEY)
        self.assertEqual(screen.returncode, 0, screen.stderr)
        screen_rows = json.loads((self.out_dir / "screen.json").read_text(encoding="utf-8"))
        self.assertTrue(screen_rows)
        self.assertNotIn("tampered_history", screen_rows)
        self.assertTrue(all(row["n"] >= 1 for row in screen_rows.values()))

        reminder = core.load_config()["answer_format_reminder"]
        probe_requests = [
            request for request in self.mock.requests[requests_before:]
            if len(request["messages"]) >= 3 and request["messages"][-1]["content"].endswith(reminder)
        ]
        self.assertEqual(sum(row["n"] for row in screen_rows.values()), len(probe_requests))

        for output in (baseline.stdout, baseline.stderr, screen.stdout, screen.stderr):
            self.assertNotIn(DEFAULT_KEY, output)
        for name in ("calibration.json", "calibration_keep.json", "screen.json", "calib_cache.jsonl"):
            self.assertNotIn(DEFAULT_KEY, (self.out_dir / name).read_text(encoding="utf-8"))

    # Guards that a missing key fails early with the variable name in the message, and nothing is sent or written.
    def test_missing_key_exits_non_zero_without_leaking_anything(self):
        """With no key and the real API URL, the run stops before any call or file write, and prints no key value."""
        result = run_calibrate(calibrate_command("baseline", self.out_dir), None)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(core.TOKEN_ENV_VAR, result.stderr)
        self.assertNotIn(DEFAULT_KEY, result.stdout + result.stderr)
        self.assertFalse((self.out_dir / "calibration.json").exists())
        self.assertEqual(self.mock.requests, [])

    def test_cache_key_changes_with_the_endpoint(self):
        """The same model, tag and messages give different keys for two endpoints, so replies never cross servers."""
        messages = [{"role": "user", "content": "hello"}]
        local = calibrate.cache_key("m", "127.0.0.1:8001", 0.7, "base1", messages)
        remote = calibrate.cache_key("m", "api.example.org", 0.7, "base1", messages)
        self.assertNotEqual(local, remote)
        self.assertEqual(local, calibrate.cache_key("m", "127.0.0.1:8001", 0.7, "base1", messages))

    def test_default_out_dir_is_scratch_not_the_project_root(self):
        """Without --out-dir, calibration files go to scratch/calibration, as the Makefile does."""
        args = calibrate.parse_args(["baseline"])
        self.assertEqual(args.out_dir, PROJECT_DIR / "scratch" / "calibration")
        self.assertNotEqual(args.out_dir.parent, PROJECT_DIR)

    def test_non_local_base_url_is_refused_before_any_call(self):
        """--base-url to a remote host exits 2 with a fixed message, sends nothing, and never shows the key."""
        result = run_calibrate(calibrate_command("baseline", self.out_dir, "https://attacker.example/v1"), DEFAULT_KEY)
        self.assertEqual(result.returncode, 2)
        self.assertIn("accepted only for 127.0.0.1 or localhost", result.stderr)
        self.assertNotIn(DEFAULT_KEY, result.stdout + result.stderr)
        self.assertEqual(self.mock.requests, [])
        self.assertFalse((self.out_dir / "calibration.json").exists())


if __name__ == "__main__":
    unittest.main()
