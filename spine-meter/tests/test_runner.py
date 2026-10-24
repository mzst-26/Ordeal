"""Tests for runner.py. They use a fake client, so no network call is made and the real cache is never written."""

import argparse
import contextlib
import io
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from typing import Any
from unittest import mock

import adaptive
import core
import flows
import model_client
import shuffle
from model_client import ModelRoute
from runner import (
    RunSettings,
    RunStats,
    backoff_seconds,
    choose_models,
    main,
    make_units,
    parse_args,
    parse_families,
    plan_question_order,
    run_all,
    step_key,
)
from tests.mock_openai import DEFAULT_KEY, MockOpenAIServer

MODEL = "test-model"
CONFIG = core.load_config()
LADDER = core.load_ladder()
PROBE_SPEC = core.load_probe_spec()
REMINDER = CONFIG["answer_format_reminder"]
V4_SUITE = core.load_suite(ladder="gauntlet_v4", questions="hard")
V4_SHUFFLED_ORDER = core.load_suite(ladder="gauntlet_v4", questions="hard", pushback_seed=7).pushback_order


class RetryableError(Exception):
    """Stands in for a rate limit or a timeout."""


class FatalError(Exception):
    """Stands in for an error that must not be retried."""


class FakeClient:
    """Answers from 'script' first, then with 'default_reply'. A scripted exception is raised instead."""

    def __init__(self, script: list[str | Exception] | None = None, default_reply: str = "Answer: B") -> None:
        self.script = list(script or [])
        self.default_reply = default_reply
        self.sent: list[list[dict[str, str]]] = []
        self.closed = False

    async def complete(self, model: str, messages: list[dict[str, str]], temperature: float, max_tokens: int) -> str:
        """Record the call, then return the next scripted reply or raise the scripted error."""
        self.sent.append(list(messages))
        if not self.script:
            return self.default_reply
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    async def close(self) -> None:
        """Remember that the client was closed."""
        self.closed = True


def is_retryable(error: Exception) -> bool:
    """Only RetryableError is worth another try in these tests."""
    return isinstance(error, RetryableError)


def describe_error(error: Exception) -> str:
    """Describe an error the same way the real client does: class name and message."""
    return f"{type(error).__name__}: {error}"


def make_question(question_id: str) -> dict[str, Any]:
    """Return a small question whose right answer is B and whose planted wrong answer is A."""
    return {
        "id": question_id,
        "tier": "trap_math",
        "question": "Which planet is the largest?",
        "options": {"A": "Mars", "B": "Jupiter", "C": "Venus", "D": "Earth"},
        "correct": "B",
        "pushed_wrong": "A",
        "correction_test": False,
        "wrong_path": "Jupiter is small, so the answer is Mars.",
    }


def make_settings(
    families: frozenset[str] = frozenset(),
    config: dict[str, Any] | None = None,
    waits: list[float] | None = None,
) -> RunSettings:
    """Build the settings for a test run. Backoff waits are appended to 'waits' instead of really sleeping."""
    recorded_waits = waits if waits is not None else []

    async def record_wait(seconds: float) -> None:
        """Remember how long the run wanted to wait, without waiting."""
        recorded_waits.append(seconds)

    return RunSettings(
        condition="none",
        system_prompt=None,
        config=config or CONFIG,
        ladder=LADDER,
        probe_spec=PROBE_SPEC,
        families=families,
        is_retryable=is_retryable,
        describe_error=describe_error,
        wait=record_wait,
    )


class ParseFamiliesTests(unittest.TestCase):
    """The --probes argument accepts family names, or 'all'."""

    def test_named_families_are_returned_as_a_set(self) -> None:
        """Names separated by commas, with spaces, become one set."""
        self.assertEqual(parse_families("gauntlet, twins"), frozenset({flows.GAUNTLET, flows.TWINS}))

    def test_all_means_every_family(self) -> None:
        """The word 'all' gives every family."""
        self.assertEqual(parse_families("all"), flows.ALL_FAMILIES)

    def test_unknown_name_is_rejected_with_the_allowed_names(self) -> None:
        """A name that is not a family raises an error naming it and listing the allowed names."""
        with self.assertRaises(argparse.ArgumentTypeError) as context:
            parse_families("gauntlet,nonsense")
        self.assertIn("nonsense", str(context.exception))
        self.assertIn(flows.GAUNTLET, str(context.exception))


class MakeUnitsTests(unittest.TestCase):
    """Every model, question and repeat gets one unit."""

    def test_one_unit_per_model_question_and_repeat(self) -> None:
        """Two models, two questions and three repeats make twelve units, numbered from 1."""
        units = make_units(["m1", "m2"], [make_question("q1"), make_question("q2")], 3)
        self.assertEqual(len(units), 12)
        self.assertEqual({unit.repeat for unit in units}, {1, 2, 3})


class BackoffTests(unittest.TestCase):
    """The wait between retries doubles and stops at 60 seconds."""

    def test_backoff_doubles_and_is_capped_at_sixty_seconds(self) -> None:
        """Attempts 0 to 2 wait 1, 2 and 4 seconds, and later attempts wait 60."""
        self.assertEqual([backoff_seconds(attempt) for attempt in range(3)], [1, 2, 4])
        self.assertEqual(backoff_seconds(10), 60)


class RunnerTests(unittest.IsolatedAsyncioTestCase):
    """Units run through the client, use the cache and record failures."""

    def setUp(self) -> None:
        """Create a temporary folder for the cache file, so the real cache is never touched."""
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.cache_path = Path(temp_dir.name) / "cache.jsonl"

    async def run_quietly(
        self,
        client: FakeClient,
        questions: list[dict[str, Any]],
        settings: RunSettings,
        cache: dict[tuple[Any, ...], dict[str, Any]] | None = None,
        repeats: int = 1,
    ) -> tuple[RunStats, str]:
        """Run the experiment with its printed output captured. Returns the stats and what went to stderr."""
        errors = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(errors):
            stats = await run_all(client, cache or {}, self.cache_path, questions, [MODEL], repeats, settings)
        return stats, errors.getvalue()

    async def test_empty_family_set_makes_one_call_per_unit(self) -> None:
        """With no families, each unit makes only its first call."""
        client = FakeClient()
        questions = [make_question("q1"), make_question("q2")]
        stats, _ = await self.run_quietly(client, questions, make_settings(), repeats=2)
        self.assertEqual(len(client.sent), 4)
        self.assertEqual(stats.calls_made, 4)
        self.assertTrue(client.closed)

    async def test_saved_reply_is_reused_without_a_call(self) -> None:
        """A reply already in the cache is used, counted as reused, and not sent again."""
        question = make_question("q1")
        key = core.make_key("none", MODEL, "q1", 1, core.BASELINE_STEP)
        cache = {key: core.make_record("none", MODEL, question, 1, core.BASELINE_STEP, [], "Answer: B", 0.7)}
        client = FakeClient()
        stats, _ = await self.run_quietly(client, [question], make_settings(), cache=cache)
        self.assertEqual(client.sent, [])
        self.assertEqual(stats.replies_reused, 1)
        self.assertEqual(stats.calls_made, 0)

    async def test_wrong_first_answer_is_counted_as_a_skipped_chain(self) -> None:
        """A wrong first answer skips the flows of a family that needs a right answer."""
        client = FakeClient(default_reply="Answer: A")
        stats, _ = await self.run_quietly(client, [make_question("q1")], make_settings({flows.GAUNTLET}))
        self.assertEqual(len(client.sent), 1)
        self.assertEqual(stats.chains_skipped, 1)

    async def test_non_retryable_error_is_recorded_once_and_the_run_completes(self) -> None:
        """A fatal error is not retried, is recorded as one failure, and the run still finishes."""
        client = FakeClient(script=[FatalError("bad request")])
        waits: list[float] = []
        stats, errors = await self.run_quietly(client, [make_question("q1")], make_settings(waits=waits))
        self.assertEqual(len(client.sent), 1)
        self.assertEqual(waits, [])
        self.assertEqual(len(stats.failures), 1)
        self.assertEqual(stats.failures[0].message, "FatalError: bad request")
        self.assertIn("Failed: test-model q1 repeat 1 level_0: FatalError: bad request", errors)
        self.assertEqual(core.load_cache(self.cache_path), {})

    async def test_retryable_error_is_retried_then_succeeds(self) -> None:
        """Two rate-limit errors wait 1 and then 2 seconds, then the third attempt succeeds."""
        client = FakeClient(script=[RetryableError("rate limited"), RetryableError("timeout")])
        waits: list[float] = []
        stats, _ = await self.run_quietly(client, [make_question("q1")], make_settings(waits=waits))
        self.assertEqual(waits, [1, 2])
        self.assertEqual(stats.failures, [])
        self.assertEqual(stats.calls_made, 1)
        self.assertEqual(len(client.sent), 3)

    async def test_retries_stop_after_max_retries(self) -> None:
        """With max_retries set to 2, the run tries three times and then records one failure."""
        client = FakeClient(script=[RetryableError("timeout") for _ in range(3)])
        waits: list[float] = []
        config = dict(CONFIG, max_retries=2)
        stats, _ = await self.run_quietly(client, [make_question("q1")], make_settings(waits=waits, config=config))
        self.assertEqual(len(client.sent), 3)
        self.assertEqual(waits, [1, 2])
        self.assertEqual(len(stats.failures), 1)


class ArgumentTests(unittest.TestCase):
    """Command-line options are checked before the run starts."""

    def test_limit_of_zero_is_rejected(self) -> None:
        """--limit 0 stops the program with an error."""
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            parse_args(["--limit", "0"])

    def test_probes_default_is_every_family(self) -> None:
        """Without --probes, every family runs."""
        self.assertEqual(parse_args([]).probes, flows.ALL_FAMILIES)


class ShuffleOptionTests(unittest.TestCase):
    """--shuffle-questions and --shuffle-pushbacks are integer seeds, and None when not given."""

    def test_shuffle_seeds_are_read_as_integers(self) -> None:
        """Both seeds come back as ints."""
        args = parse_args(["--shuffle-questions", "3", "--shuffle-pushbacks", "7"])
        self.assertEqual((args.shuffle_questions, args.shuffle_pushbacks), (3, 7))
        self.assertIsInstance(args.shuffle_questions, int)
        self.assertIsInstance(args.shuffle_pushbacks, int)

    def test_shuffle_seeds_default_to_none(self) -> None:
        """Without the flags, neither shuffle is on."""
        args = parse_args([])
        self.assertIsNone(args.shuffle_questions)
        self.assertIsNone(args.shuffle_pushbacks)


class QuestionOrderTests(unittest.TestCase):
    """plan_question_order shuffles before the limit, and keeps the file order without a seed."""

    QUESTIONS = [{"id": f"q{number}"} for number in range(10)]

    def test_limit_takes_the_first_positions_of_the_shuffled_order(self) -> None:
        """A limited shuffled run is a random sample: the first N of the shuffled order, positions 1..N."""
        ordered, orders = plan_question_order(self.QUESTIONS, limit=3, seed=3)
        self.assertEqual(ordered, shuffle.shuffled_questions(self.QUESTIONS, 3)[:3])
        self.assertEqual([orders[question["id"]]["question_position"] for question in ordered], [1, 2, 3])
        self.assertEqual(orders[ordered[0]["id"]]["question_order_seed"], 3)

    def test_no_seed_keeps_the_file_order_and_adds_no_order_fields(self) -> None:
        """Without a seed the first N questions run in file order, and no question gets order fields."""
        ordered, orders = plan_question_order(self.QUESTIONS, limit=2, seed=None)
        self.assertEqual(ordered, self.QUESTIONS[:2])
        self.assertEqual(orders, {})


class DryRunCommandTests(unittest.TestCase):
    """The --dry-run option prints the upper bound and never needs the API client or key."""

    def test_dry_run_prints_the_upper_bound_and_makes_no_client(self) -> None:
        """main returns 0, prints the total, and never builds the client or reads the key."""
        output = io.StringIO()
        with mock.patch("model_client.TokenFactoryClient") as client_class, mock.patch(
            "core.read_api_key"
        ) as read_key, contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            exit_code = main(["--dry-run", "--limit", "2", "--condition", "none"])
        self.assertEqual(exit_code, 0)
        self.assertIn("Dry run: no calls will be made.", output.getvalue())
        self.assertIn("Total: at most", output.getvalue())
        client_class.assert_not_called()
        read_key.assert_not_called()


class ReplyByTextClient(FakeClient):
    """Answers with 'wrong_reply' when the last message contains 'trigger', else with the default reply."""

    def __init__(self, trigger: str, wrong_reply: str) -> None:
        super().__init__()
        self.trigger = trigger
        self.wrong_reply = wrong_reply

    async def complete(self, model: str, messages: list[dict[str, str]], temperature: float, max_tokens: int) -> str:
        """Record the call, then pick the reply from the last message."""
        self.sent.append(list(messages))
        return self.wrong_reply if self.trigger in messages[-1]["content"] else self.default_reply


class GauntletV4RunTests(unittest.IsolatedAsyncioTestCase):
    """The v4 gauntlet through the runner: twelve levels, the level 5 setup turn, and the confession."""

    def setUp(self) -> None:
        """Create a temporary folder for the cache file."""
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.cache_path = Path(temp_dir.name) / "cache.jsonl"
        self.question = make_question("q1")

    def settings(self) -> RunSettings:
        """Settings for the gauntlet alone, on the v4 suite, with no waiting."""

        async def no_wait(seconds: float) -> None:
            """Return at once instead of sleeping."""

        return RunSettings(
            condition="none",
            system_prompt=None,
            config=CONFIG,
            ladder=V4_SUITE.ladder,
            probe_spec=V4_SUITE.probe_spec,
            families=frozenset({flows.GAUNTLET}),
            is_retryable=is_retryable,
            describe_error=describe_error,
            wait=no_wait,
            suite=V4_SUITE,
        )

    async def run_gauntlet(self, client: FakeClient) -> dict[tuple[Any, ...], dict[str, Any]]:
        """Run one unit with the client and return the saved replies of the v4 suite."""
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            await run_all(client, {}, self.cache_path, [self.question], [MODEL], 1, self.settings())
        return core.load_cache(self.cache_path, experiment=V4_SUITE.experiment)

    async def test_v4_gauntlet_saves_levels_one_to_twelve_and_the_setup_turn(self) -> None:
        """The baseline, levels 1 to 12 (11 and 12 included) and setup_5 are saved; no confession without a flip."""
        client = FakeClient()
        cache = await self.run_gauntlet(client)
        self.assertEqual({key[4] for key in cache}, {core.BASELINE_STEP, "setup_5", *core.pushback_steps(12)})
        self.assertEqual(len(client.sent), 14)

    async def test_v4_setup_turn_has_no_reminder_and_the_level_five_message_has_one(self) -> None:
        """The setup message is sent bare, then the level 5 message follows it with the format reminder."""
        client = FakeClient()
        await self.run_gauntlet(client)
        setup_text = adaptive.setup_text(V4_SUITE.ladder["levels"][4], self.question)
        index = next(number for number, sent in enumerate(client.sent) if sent[-1]["content"] == setup_text)
        self.assertFalse(setup_text.endswith(REMINDER))
        self.assertTrue(client.sent[index + 1][-1]["content"].endswith(REMINDER))

    async def test_v4_confession_is_sent_last_after_a_flip_at_level_eleven(self) -> None:
        """A wrong answer at level 11 makes the run send the confession after level 12."""
        client = ReplyByTextClient(trigger="Will you confirm it, yes or no?", wrong_reply="Answer: C")
        cache = await self.run_gauntlet(client)
        self.assertIn(core.CONFESSION_STEP, {key[4] for key in cache})
        self.assertTrue(client.sent[-1][-1]["content"].startswith("Setting aside"))
        self.assertTrue(client.sent[-2][-1]["content"].endswith(REMINDER))


class SuiteOptionTests(unittest.TestCase):
    """--ladder, --questions and --cache: default to None so config.json decides."""

    def test_suite_options_default_to_none(self) -> None:
        """Without the options, the ladder, questions and cache are left for the config and the default path."""
        args = parse_args([])
        self.assertIsNone(args.ladder)
        self.assertIsNone(args.questions)
        self.assertIsNone(args.cache)

    def test_suite_options_are_read(self) -> None:
        """Named values come back as given, and --cache becomes a path."""
        args = parse_args(["--ladder", "gauntlet_v4", "--questions", "hard", "--cache", "saved.jsonl"])
        self.assertEqual((args.ladder, args.questions), ("gauntlet_v4", "hard"))
        self.assertEqual(args.cache, Path("saved.jsonl"))

    def test_unknown_ladder_or_question_set_exits_with_code_two(self) -> None:
        """A name that is not in the registry is refused by the parser."""
        for argv in (["--ladder", "gauntlet_v9"], ["--questions", "medium"]):
            with self.subTest(argv=argv), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as context:
                    parse_args(argv)
                self.assertEqual(context.exception.code, 2)


class BaseUrlOptionTests(unittest.TestCase):
    """--base-url is a test-only override: it is accepted for 127.0.0.1 and localhost and nothing else."""

    def test_localhost_and_loopback_are_accepted(self) -> None:
        """Both loopback names with any port are accepted."""
        for url in ("http://127.0.0.1:8123/v1", "http://localhost:9000/v1"):
            with self.subTest(url=url):
                self.assertEqual(parse_args(["--base-url", url, "--cache", "saved.jsonl"]).base_url, url)

    def test_any_other_host_or_scheme_exits_with_code_two(self) -> None:
        """Real hosts, look-alike hosts, user names in the URL and other schemes are all refused with code 2."""
        refused = (
            "https://api.tokenfactory.nebius.com/v1/",
            "http://example.com/v1",
            "http://127.0.0.1.example.com/v1",
            "http://user@127.0.0.1:9/v1",
            "http://localhost@example.com/v1",
            "ftp://127.0.0.1/v1",
        )
        for url in refused:
            with self.subTest(url=url), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as context:
                    parse_args(["--base-url", url])
                self.assertEqual(context.exception.code, 2)

    def test_base_url_sends_the_run_to_the_local_mock(self) -> None:
        """A real run with --base-url reaches the mock server only, and saves its replies to the given cache."""
        with tempfile.TemporaryDirectory() as folder, MockOpenAIServer() as server:
            cache_path = Path(folder) / "cache.jsonl"
            loopback = "127.0.0.1,localhost"
            env = {"TOKEN_FACTORY_TOKEN": DEFAULT_KEY, "NO_PROXY": loopback, "no_proxy": loopback}
            with mock.patch.dict(os.environ, env), contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()):
                code = main(["--models", MODEL, "--limit", "1", "--repeats", "1", "--probes", "gauntlet",
                             "--base-url", server.base_url, "--cache", str(cache_path)])
            self.assertEqual(code, 0)
            self.assertTrue(server.requests)
            self.assertEqual({request["path"] for request in server.requests}, {server.chat_path})
            self.assertIn(core.BASELINE_STEP, {record["step"] for record in core.load_cache(cache_path).values()})


class SuiteDryRunTests(unittest.TestCase):
    """The dry run works for any suite, makes no calls and writes nothing."""

    def test_dry_run_of_the_v4_suite_prints_its_ladder_and_makes_no_calls(self) -> None:
        """The plan names the v4 ladder, and the client, the key and the cache file are never touched."""
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder) / "empty.jsonl"
            cache.write_text("", encoding="utf-8")
            output = io.StringIO()
            with mock.patch("model_client.ModelRouter") as router_class, mock.patch(
                "core.read_api_key"
            ) as read_key, contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                exit_code = main(["--dry-run", "--ladder", "gauntlet_v4", "--questions", "hard", "--limit", "2",
                                  "--cache", str(cache)])
            self.assertEqual(exit_code, 0)
            self.assertIn("Ladder: gauntlet_v4", output.getvalue())
            self.assertIn("Total: at most", output.getvalue())
            router_class.assert_not_called()
            read_key.assert_not_called()
            self.assertEqual(cache.read_text(encoding="utf-8"), "")

    def test_dry_run_with_shuffled_pushbacks_prints_one_line_per_slot(self) -> None:
        """With --shuffle-pushbacks the dry run lists the axis of every slot, 12 for gauntlet_v4."""
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder) / "empty.jsonl"
            cache.write_text("", encoding="utf-8")
            output = io.StringIO()
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                exit_code = main(["--dry-run", "--stub", "--ladder", "gauntlet_v4", "--questions", "hard",
                                  "--shuffle-pushbacks", "7", "--limit", "2", "--cache", str(cache)])
            self.assertEqual(exit_code, 0)
            slot_lines = [line for line in output.getvalue().splitlines() if line.startswith("  level ")]
            self.assertEqual(len(slot_lines), 12)
            self.assertEqual(slot_lines[0], f"  level 1: {V4_SHUFFLED_ORDER[0]}")


CUSTOM_KEY_VAR = "SPINE_TEST_CUSTOM_KEY_UNSET"


class CustomModelCommandTests(unittest.TestCase):
    """Custom models from config.json, as seen from the command line. No key value is printed."""

    def setUp(self) -> None:
        """Use a temporary cache, make sure the custom key variable is unset, and keep .env out of it."""
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.cache = str(Path(temp_dir.name) / "cache.jsonl")
        self.entry = {
            "name": "my-model",
            "base_url": "https://models.example.org/v1",
            "model": "org/my-model",
            "api_key_env": CUSTOM_KEY_VAR,
        }
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop(CUSTOM_KEY_VAR, None)
        no_env_file = mock.patch.object(core, "load_env_file")
        no_env_file.start()
        self.addCleanup(no_env_file.stop)

    def run_main(self, entry: dict[str, Any], argv: list[str]) -> tuple[int, str, str]:
        """Run main with one custom model in the config. Returns the exit code, stdout and stderr."""
        config = dict(core.load_config(), custom_models=[entry])
        output, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(core, "load_config", return_value=config), contextlib.redirect_stdout(output), \
                contextlib.redirect_stderr(errors):
            code = main(argv)
        return code, output.getvalue(), errors.getvalue()

    def test_unsafe_custom_url_exits_with_code_two_and_never_prints_it(self) -> None:
        """A URL with a user name, a password and a query string is refused, and the URL is not echoed."""
        entry = dict(self.entry, base_url="https://user:hunter2@models.example.org/v1?key=abc")
        code, _, errors = self.run_main(entry, ["--dry-run", "--cache", self.cache])
        self.assertEqual(code, 2)
        self.assertIn("my-model", errors)
        self.assertNotIn("hunter2", errors)

    def test_missing_custom_key_exits_with_code_two_and_names_the_variable(self) -> None:
        """A run that needs the custom key stops before any call, and the message names the variable only."""
        code, _, errors = self.run_main(self.entry, ["--models", "my-model", "--limit", "1", "--cache", self.cache])
        self.assertEqual(code, 2)
        self.assertIn(CUSTOM_KEY_VAR, errors)

    def test_custom_model_is_left_out_of_the_default_run(self) -> None:
        """Without --models, the dry run lists only the built-in models, so the custom endpoint is not used."""
        code, output, _ = self.run_main(self.entry, ["--dry-run", "--limit", "1", "--cache", self.cache])
        self.assertEqual(code, 0)
        self.assertNotIn("my-model", output)

    def test_custom_model_runs_when_named_and_a_dry_run_needs_no_key(self) -> None:
        """Named with --models, the custom model is listed by the dry run, which reads no key."""
        code, output, _ = self.run_main(
            self.entry, ["--dry-run", "--models", "my-model", "--limit", "1", "--cache", self.cache]
        )
        self.assertEqual(code, 0)
        self.assertIn("  my-model: ", output)

    def test_real_run_without_models_never_builds_the_custom_route(self) -> None:
        """A real run with no --models gets only the built-in model names, so no custom endpoint is called."""
        seen: dict[str, Any] = {}

        def fake_make_client(args, config, models, custom_routes, questions):
            """Record the model names the run asks for, and return a client that answers without a network."""
            seen["models"] = models
            return FakeClient()

        config = dict(core.load_config(), custom_models=[self.entry])
        with mock.patch.object(core, "load_config", return_value=config), mock.patch(
            "runner.make_client", side_effect=fake_make_client
        ), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = main(["--limit", "1", "--repeats", "1", "--probes", "gauntlet", "--cache", self.cache])
        self.assertEqual(code, 0)
        self.assertEqual(seen["models"], CONFIG["models"])
        self.assertNotIn("my-model", seen["models"])


class ChooseModelsTests(unittest.TestCase):
    """The default model list is the built-in models; --models and --stub pick others."""

    def test_default_is_the_built_in_models(self) -> None:
        self.assertEqual(choose_models(parse_args([]), CONFIG), CONFIG["models"])

    def test_named_models_are_used_as_given(self) -> None:
        self.assertEqual(choose_models(parse_args(["--models", "my-model"]), CONFIG), ["my-model"])

    def test_stub_uses_the_stub_model(self) -> None:
        self.assertEqual(choose_models(parse_args(["--stub"]), CONFIG), ["stub"])


class BaseUrlNeedsCacheTests(unittest.TestCase):
    """--base-url without --cache is refused before any call, so test replies never reach the real cache."""

    def test_base_url_without_cache_exits_two_and_writes_nothing_to_the_real_cache(self) -> None:
        with tempfile.TemporaryDirectory() as folder, MockOpenAIServer() as server:
            real_cache = Path(folder) / "real_cache.jsonl"
            output, errors = io.StringIO(), io.StringIO()
            env = {core.TOKEN_ENV_VAR: DEFAULT_KEY}
            with mock.patch.object(core, "CACHE_PATH", real_cache), mock.patch.dict(os.environ, env), \
                    contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                with self.assertRaises(SystemExit) as context:
                    main(["--models", MODEL, "--limit", "1", "--repeats", "1", "--base-url", server.base_url])
            self.assertEqual(context.exception.code, 2)
            self.assertIn("--base-url needs --cache", errors.getvalue())
            self.assertFalse(real_cache.exists())
            self.assertEqual(server.requests, [])
            self.assertNotIn(DEFAULT_KEY, output.getvalue() + errors.getvalue())


class CustomLabelKeyTests(unittest.TestCase):
    """A custom model's saved replies are keyed by its endpoint and API model id, not only its name."""

    def test_same_name_different_base_url_gives_different_step_keys(self) -> None:
        first = ModelRoute("mine", "org/x", "https://a.example.org/v1", "UNUSED_KEY_VAR", custom=True)
        second = replace(first, base_url="https://b.example.org/v1")
        keys = []
        for route in (first, second):
            labels = model_client.record_labels(["mine"], CONFIG, [route], None)
            unit = make_units(["mine"], [make_question("q1")], 1, labels)[0]
            keys.append(step_key("none", unit, core.BASELINE_STEP))
        self.assertNotEqual(keys[0], keys[1])


if __name__ == "__main__":
    unittest.main()
