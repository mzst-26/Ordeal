"""Tests for the shared scheduler: one run across several models and several system-prompt conditions.

Before this change, runner.main ran one condition per process, and run_all ran one model's units at a time.
Now one run takes a list of conditions and one queue of units, served round-robin across the models.
The cache keys and the version codes do not change, so a condition's replies are saved exactly as before.

No network call is made. The client used here only records what it was sent, and the cache is a temporary file.
"""

import asyncio
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from ordeal import core
from ordeal import limiter
from ordeal import model_client
from ordeal import runner
from ordeal.runner import RunSettings

LADDER_NAME = "gauntlet_v3"
QUESTION_SET = "easy"
CONFIG = core.load_config()
SUITE = core.load_suite(ladder=LADDER_NAME, questions=QUESTION_SET)


def make_settings(condition: str, config: dict[str, Any] | None = None) -> RunSettings:
    """Build the settings for one condition, the same way main() builds them. No family is run unless a test asks."""
    chosen_config = config or CONFIG
    return RunSettings(
        condition=condition,
        system_prompt=core.system_prompt_for(condition, chosen_config),
        config=chosen_config,
        ladder=SUITE.ladder,
        probe_spec=SUITE.probe_spec,
        families=frozenset(),
        is_retryable=model_client.is_retryable,
        describe_error=model_client.describe_error,
        suite=SUITE,
    )


class RecordingClient:
    """Answers every call with the right letter and remembers which model and messages each call was sent."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, list[dict[str, str]]]] = []

    async def complete_detailed(
        self, model: str, messages: list[dict[str, str]], temperature: float, max_tokens: int
    ) -> model_client.Reply:
        """Record the model and the messages, then answer with no headers and no usage counts."""
        self.calls.append((model, messages))
        return model_client.Reply(text="Answer: " + SUITE.questions[0]["correct"], headers={}, prompt_tokens=None,
                                  completion_tokens=None)

    async def close(self) -> None:
        """Nothing to close. This exists so the recording client can stand in for the real one."""


def run_quietly(
    client: RecordingClient,
    models: list[str],
    settings: RunSettings,
    cache_path: Path,
    repeats: int = 1,
    conditions: list[str] | None = None,
) -> None:
    """Run the schedule with its printed output hidden. The stub-style pacer is unpaced, so no time is spent waiting."""
    with contextlib.redirect_stdout(io.StringIO()):
        asyncio.run(runner.run_all(
            client, {}, cache_path, SUITE.questions[:2], models, repeats, settings,
            pacer=limiter.Pacer(paced=False), conditions=conditions,
        ))


class InterleaveTests(unittest.TestCase):
    """The round-robin helper takes one item from each list in turn."""

    def test_items_are_taken_in_turn_and_short_lists_are_skipped(self) -> None:
        """Each round takes the next item of every list that still has one."""
        merged = runner.interleave([["a1", "a2", "a3"], ["b1"], ["c1", "c2"]])
        self.assertEqual(merged, ["a1", "b1", "c1", "a2", "c2", "a3"])

    def test_no_lists_or_only_empty_lists_give_an_empty_queue(self) -> None:
        """Nothing to take turns with means nothing is queued."""
        self.assertEqual(runner.interleave([]), [])
        self.assertEqual(runner.interleave([[], []]), [])


class ConditionSettingsTests(unittest.TestCase):
    """Each condition in a run gets its own system prompt, and the first one keeps the settings it was given."""

    def test_the_settings_condition_is_returned_as_it_is(self) -> None:
        """The condition the caller built the settings for keeps those exact settings."""
        settings = make_settings(core.NO_SYSTEM_PROMPT)
        self.assertIs(runner.settings_for_condition(settings, core.NO_SYSTEM_PROMPT), settings)

    def test_another_condition_takes_its_own_prompt_from_config(self) -> None:
        """A different condition gets its own name and the prompt config.json gives it."""
        settings = make_settings(core.NO_SYSTEM_PROMPT)
        other = runner.settings_for_condition(settings, "mitigation")
        self.assertEqual(other.condition, "mitigation")
        self.assertEqual(other.system_prompt, CONFIG["system_prompts"]["mitigation"])
        # The original settings are not changed, because another condition is only a copy.
        self.assertEqual(settings.condition, core.NO_SYSTEM_PROMPT)


class MakeRunQueueTests(unittest.TestCase):
    """The queue holds every unit of every model and condition, and the models take turns."""

    def test_models_take_turns_in_the_queue(self) -> None:
        """With two models and two questions, the queue alternates the models unit by unit."""
        context = self.context_for(core.NO_SYSTEM_PROMPT)
        queue = runner.make_run_queue([context], ["m1", "m2"], SUITE.questions[:2], 1, {}, None)
        self.assertEqual([unit.model for _, unit in queue], ["m1", "m2", "m1", "m2"])

    def test_every_condition_gets_its_own_units(self) -> None:
        """Two conditions double the number of units, and each unit carries its own condition's context."""
        contexts = [self.context_for(core.NO_SYSTEM_PROMPT), self.context_for("mitigation")]
        queue = runner.make_run_queue(contexts, ["m1", "m2"], SUITE.questions[:2], 2, {}, None)
        # 2 models x 2 questions x 2 repeats x 2 conditions.
        self.assertEqual(len(queue), 16)
        conditions = {context.settings.condition for context, _ in queue}
        self.assertEqual(conditions, {core.NO_SYSTEM_PROMPT, "mitigation"})

    def context_for(self, condition: str) -> runner.RunContext:
        """Return a context for one condition. Only its settings matter for building the queue."""
        return runner.RunContext(
            client=RecordingClient(), cache={}, cache_path=Path("unused.jsonl"), semaphore=asyncio.Semaphore(1),
            pacer=limiter.Pacer(paced=False), settings=make_settings(condition), stats=runner.RunStats(),
            budget=runner.CallBudget(None),
        )


class SharedRunTests(unittest.TestCase):
    """A run with several conditions makes one schedule and saves each condition under its own key."""

    def setUp(self) -> None:
        """Create a temporary folder, so the real cache is never touched."""
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.folder = Path(temp_dir.name)

    def test_first_calls_of_every_model_are_made_before_any_second_call(self) -> None:
        """With one call slot, the models alternate: no model makes a second call before the others make a first."""
        config = dict(CONFIG, concurrency=1)
        client = RecordingClient()
        settings = make_settings(core.NO_SYSTEM_PROMPT, config)
        run_quietly(client, ["m1", "m2", "m3"], settings, self.folder / "cache.jsonl", repeats=2)
        called_models = [model for model, _ in client.calls]
        # Two questions and two repeats make 4 units per model, so each round of the queue is one unit per model.
        self.assertEqual(called_models, ["m1", "m2", "m3"] * 4)

    def test_conditions_share_one_run_and_save_under_their_own_keys(self) -> None:
        """Two conditions give two saved lines per unit, each with its own condition in the key and prompt."""
        client = RecordingClient()
        settings = make_settings(core.NO_SYSTEM_PROMPT)
        cache_path = self.folder / "cache.jsonl"
        run_quietly(client, ["m1"], settings, cache_path, conditions=[core.NO_SYSTEM_PROMPT, "mitigation"])
        saved = [json.loads(line) for line in cache_path.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(sorted(record["condition"] for record in saved), ["mitigation", "mitigation", "none", "none"])
        # The mitigation calls carry the mitigation prompt, and the none calls carry no system message at all.
        mitigation_prompt = CONFIG["system_prompts"]["mitigation"]
        system_messages = [
            message["content"] for _, messages in client.calls for message in messages if message["role"] == "system"
        ]
        self.assertIn(mitigation_prompt, system_messages)
        self.assertEqual(len(system_messages), 2)

    def test_without_conditions_only_the_settings_condition_is_run(self) -> None:
        """The default keeps the old behaviour: one condition, the one the settings name."""
        client = RecordingClient()
        cache_path = self.folder / "cache.jsonl"
        run_quietly(client, ["m1"], make_settings("mitigation"), cache_path)
        saved = [json.loads(line) for line in cache_path.read_text(encoding="utf-8").splitlines()]
        self.assertEqual({record["condition"] for record in saved}, {"mitigation"})


class ArgumentTests(unittest.TestCase):
    """The --condition option takes one or more names, and defaults to the no-prompt condition."""

    def test_default_is_the_single_none_condition(self) -> None:
        """A command with no --condition runs one condition, as before."""
        self.assertEqual(runner.parse_args([]).conditions, [core.NO_SYSTEM_PROMPT])

    def test_several_conditions_are_read_in_order(self) -> None:
        """Naming several conditions gives a list of them, in the order given."""
        args = runner.parse_args(["--condition", "mitigation", "third_person"])
        self.assertEqual(args.conditions, ["mitigation", "third_person"])

    def test_a_condition_named_twice_is_refused(self) -> None:
        """A repeated name would run and save every unit twice, so the parser exits with code 2."""
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            runner.parse_args(["--condition", "mitigation", "mitigation"])
        self.assertEqual(caught.exception.code, 2)


class CountingTests(unittest.TestCase):
    """The dry run and the finished count add up over every condition."""

    def test_dry_run_plan_is_the_sum_over_conditions(self) -> None:
        """Two conditions with an empty cache need twice the calls of one condition."""
        one = runner.plan_model_calls("m1", SUITE.questions[:2], 1, {}, core.NO_SYSTEM_PROMPT, frozenset(), SUITE.ladder,
                                      SUITE.probe_spec)
        both = runner.plan_model_calls_for_conditions(
            "m1", SUITE.questions[:2], 1, {}, [core.NO_SYSTEM_PROMPT, "mitigation"], frozenset(), SUITE.ladder,
            SUITE.probe_spec,
        )
        self.assertEqual(both.at_most_new, 2 * one.at_most_new)

    def test_a_question_counts_as_finished_only_when_every_condition_is_saved(self) -> None:
        """One saved condition is not enough: a question with a missing condition is not finished."""
        question = SUITE.questions[0]
        cache = {runner.step_key(core.NO_SYSTEM_PROMPT, unit, core.BASELINE_STEP): {"reply": "Answer: B"}
                 for unit in runner.make_units(["m1"], [question], 1)}
        conditions = [core.NO_SYSTEM_PROMPT, "mitigation"]
        self.assertEqual(runner.count_finished_questions(cache, conditions, ["m1"], 1, [question], {}, {}), 0)
        self.assertEqual(
            runner.count_finished_questions(cache, [core.NO_SYSTEM_PROMPT], ["m1"], 1, [question], {}, {}), 1
        )


if __name__ == "__main__":
    unittest.main()
