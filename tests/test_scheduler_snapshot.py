"""Snapshot test for the scheduler: which units runner.run_all saves, and under which keys.

runner.run_all decides which (model, question, repeat) units run and which steps each unit saves.
This test runs it on the easy questions with the gauntlet family only, using the offline StubModel
and a temporary cache file. The sorted cache keys are kept in tests/fixtures/scheduler_keys.json.
The tests check that a rerun gives the same keys, that no key is saved twice, and that no unit is missing.

No network call is made and the real cache is never written.

To accept an intended change, write the fixture again and review the diff:
    .venv-spine/bin/python -m tests.test_scheduler_snapshot --write
"""

import asyncio
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

from ordeal import core
from ordeal import flows
from ordeal import model_client
from ordeal import runner
from ordeal.stub_model import StubModel

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "scheduler_keys.json"
LADDER_NAME = "gauntlet_v3"
QUESTION_SET = "easy"
# The model name the stub is run under. It is saved as the model field of every key.
MODEL_NAME = "stub"
# Only the gauntlet family is run, so the snapshot covers the pressure ladder and nothing else.
FAMILIES = frozenset({flows.GAUNTLET})
# The stub answers correctly until this many pushbacks, then gives the wrong letter.
# Using 3 means the confession check is sent too, so its key is in the snapshot.
FLIP_AFTER = 3
# Keys are saved as one text line each: the five parts of the key joined with this separator.
KEY_SEPARATOR = "|"
DESCRIPTION = (
    "Sorted cache keys saved by runner.run_all with the stub model, the gauntlet family and the easy questions. "
    "Each key is condition|model|question_id|repeat|step."
)


def run_schedule(cache_path):
    """Run runner.run_all on the easy questions into cache_path, and return its stats."""
    # Everything the run needs is read from disk, the same way main() reads it, so the snapshot follows the real settings.
    config = core.load_config()
    suite = core.load_suite(ladder=LADDER_NAME, questions=QUESTION_SET)
    condition = core.NO_SYSTEM_PROMPT
    settings = runner.RunSettings(
        condition=condition,
        system_prompt=core.system_prompt_for(condition, config),
        config=config,
        ladder=suite.ladder,
        probe_spec=suite.probe_spec,
        families=FAMILIES,
        is_retryable=model_client.is_retryable,
        describe_error=model_client.describe_error,
        suite=suite,
    )
    client = StubModel(suite.questions, flip_after=FLIP_AFTER)
    # run_all prints a progress line for every unit. The test keeps stdout quiet so its output stays readable.
    with contextlib.redirect_stdout(io.StringIO()):
        return asyncio.run(runner.run_all(
            client, {}, cache_path, suite.questions, [MODEL_NAME], config["repeats"], settings,
        ))


def read_key_lines(cache_path):
    """Return the key of every saved line in the cache file, in file order. A key saved twice appears twice."""
    # The keys are read from the file, not from the in-memory dict, because the dict hides duplicate lines.
    keys = []
    for line in cache_path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            keys.append(KEY_SEPARATOR.join(str(part) for part in core.record_key(json.loads(line))))
    return keys


def collect_key_lines():
    """Run the schedule into a temporary cache and return the key of every saved line."""
    with tempfile.TemporaryDirectory() as folder:
        cache_path = Path(folder) / "cache.jsonl"
        run_schedule(cache_path)
        return read_key_lines(cache_path)


def expected_units():
    """Return every (question id, repeat) pair the schedule must cover, as text."""
    config = core.load_config()
    suite = core.load_suite(ladder=LADDER_NAME, questions=QUESTION_SET)
    return {
        KEY_SEPARATOR.join((question["id"], str(repeat)))
        for question in suite.questions
        for repeat in range(1, config["repeats"] + 1)
    }


def units_in(keys):
    """Return the (question id, repeat) pair of each key, as text, without duplicates."""
    # The key parts are condition, model, question id, repeat and step, so parts 2 and 3 name the unit.
    return {KEY_SEPARATOR.join(key.split(KEY_SEPARATOR)[2:4]) for key in keys}


def build_snapshot():
    """Return the snapshot payload: the sorted keys, one entry per saved line."""
    keys = sorted(collect_key_lines())
    return {"description": DESCRIPTION, "keys": keys}


def write_fixture():
    """Write the scheduler fixture from the current code. Run this only after an intended change."""
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Indent 1 and a final newline keep the file stable, so a diff shows only the keys that changed.
    text = json.dumps(build_snapshot(), indent=1, ensure_ascii=False) + "\n"
    FIXTURE_PATH.write_text(text, encoding="utf-8")


class SchedulerSnapshotTests(unittest.TestCase):
    """The schedule saves the same keys on every run, with each unit saved once and none missing."""

    def test_rerun_gives_the_snapshot_keys(self) -> None:
        # The saved keys are sorted, so the order of the parallel units does not change the result.
        expected = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["keys"]
        self.assertEqual(sorted(collect_key_lines()), expected)

    def test_no_key_is_saved_twice(self) -> None:
        # A duplicate would mean two calls were paid for and saved under one key, so the file would hold both.
        keys = collect_key_lines()
        self.assertEqual(len(keys), len(set(keys)))

    def test_every_unit_is_saved(self) -> None:
        # Every question and repeat must have at least one saved key. A missing unit would be skipped silently.
        keys = collect_key_lines()
        self.assertEqual(units_in(keys), expected_units())


if __name__ == "__main__":
    # Only the --write flag is handled here; every other run is a normal unittest run.
    if "--write" in sys.argv:
        write_fixture()
        print(f"Wrote {FIXTURE_PATH}")
    else:
        unittest.main()
