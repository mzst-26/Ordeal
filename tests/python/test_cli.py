"""Tests for the ordeal command line. Every test is offline.

The network call (fetch_model_ids) and the chat call (send_tiny_message) are replaced by fakes, the
runner and the grader are replaced where a full run would start, and saved keys go to a temporary
config folder through XDG_CONFIG_HOME, so the real home folder is never touched.
"""

import io
import json
import os
import stat
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import replace
from pathlib import Path
from unittest import mock

from ordeal import cli, grade, keys, model_client, providers, runner
from tests.python.fake_clock import isolated_run

FAKE_KEY = "test-key-123"
GROQ_MODELS = ["org/alpha-7b", "org/beta-large", "other/alpha-small"]


class CliTestCase(unittest.TestCase):
    """Sets up a temporary config folder and an environment that is restored after each test."""

    def setUp(self) -> None:
        """Point XDG_CONFIG_HOME at a temp folder, so saved keys never reach the real home folder."""
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name)
        # patch.dict also undoes any variables that keys.get_key copies in from the .env file.
        patcher = mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": str(self.folder / "config")})
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_cli(self, argv: list[str]) -> tuple[int, str, str]:
        """Run main() with these arguments and return (exit code, printed output, error output)."""
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cli.main(argv)
        return code, out.getvalue(), err.getvalue()

    def fake_models(self, ids: list[str]):
        """Replace the model list request with a fake that returns these ids."""
        return mock.patch.object(providers, "fetch_model_ids", return_value=ids)


class PlatformsTests(CliTestCase):
    """The platforms command lists every registry entry and never prints a key."""

    def test_lists_every_platform(self) -> None:
        """Each platform id from providers.json appears in the output, with a header row."""
        code, out, _ = self.run_cli(["platforms"])
        self.assertEqual(code, 0)
        self.assertIn("Key", out)
        for platform in providers.load_platforms():
            self.assertIn(platform.id, out)

    def test_never_prints_a_key(self) -> None:
        """A key set in the environment is used for the status, but its value is not printed."""
        with mock.patch.dict(os.environ, {"GROQ_API_KEY": FAKE_KEY}):
            _, out, err = self.run_cli(["platforms"])
        self.assertNotIn(FAKE_KEY, out + err)


class ModelsTests(CliTestCase):
    """The models command lists a platform's model ids, optionally filtered by --search."""

    def setUp(self) -> None:
        """Give the groq platform a key, so the list request is allowed to run."""
        super().setUp()
        patcher = mock.patch.dict(os.environ, {"GROQ_API_KEY": FAKE_KEY})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_search_filters_the_list(self) -> None:
        """Only the ids that contain the search text, ignoring case, are printed."""
        with self.fake_models(GROQ_MODELS):
            code, out, _ = self.run_cli(["models", "groq", "--search", "ALPHA"])
        self.assertEqual(code, 0)
        self.assertIn("org/alpha-7b", out)
        self.assertIn("other/alpha-small", out)
        self.assertNotIn("org/beta-large", out)

    def test_never_prints_the_key(self) -> None:
        """The key is used for the request but never printed."""
        with self.fake_models(GROQ_MODELS):
            _, out, err = self.run_cli(["models", "groq"])
        self.assertNotIn(FAKE_KEY, out + err)

    def test_unknown_platform_lists_the_valid_ones(self) -> None:
        """A bad platform name fails with exit code 1 and names the valid platforms."""
        code, _, err = self.run_cli(["models", "nope"])
        self.assertEqual(code, 1)
        self.assertIn("Unknown platform 'nope'", err)
        self.assertIn("groq", err)

    def test_missing_key_says_which_variable_to_set(self) -> None:
        """With no key anywhere, the error names the variable to set, and no request is made."""
        with mock.patch.dict(os.environ, {"GROQ_API_KEY": ""}), self.fake_models(GROQ_MODELS) as fake:
            code, _, err = self.run_cli(["models", "groq"])
        self.assertEqual(code, 1)
        self.assertIn("GROQ_API_KEY", err)
        fake.assert_not_called()


class LoginTests(CliTestCase):
    """The login command asks for a key with hidden input and saves it in the credentials file."""

    def test_saves_the_trimmed_key_privately(self) -> None:
        """The key is saved under the platform id, the file is owner-only, and the key is not printed."""
        with mock.patch("ordeal.cli.getpass.getpass", return_value="  secret-123 \n"):
            code, out, err = self.run_cli(["login", "groq"])
        self.assertEqual(code, 0)
        saved = json.loads(keys.credentials_path().read_text(encoding="utf-8"))
        self.assertEqual(saved, {"groq": "secret-123"})
        self.assertEqual(stat.S_IMODE(keys.credentials_path().stat().st_mode), keys.CREDENTIALS_MODE)
        self.assertNotIn("secret-123", out + err)

    def test_blank_key_is_refused_and_nothing_is_saved(self) -> None:
        """A key of only spaces fails with exit code 1 and creates no credentials file."""
        with mock.patch("ordeal.cli.getpass.getpass", return_value="   "):
            code, _, err = self.run_cli(["login", "groq"])
        self.assertEqual(code, 1)
        self.assertIn("empty", err)
        self.assertFalse(keys.credentials_path().exists())

    def test_local_platform_needs_no_key(self) -> None:
        """A platform on this computer has no key, so the prompt is never shown."""
        with mock.patch("ordeal.cli.getpass.getpass") as prompt:
            code, out, _ = self.run_cli(["login", "ollama"])
        self.assertEqual(code, 0)
        prompt.assert_not_called()
        self.assertIn("no key", out)

    def test_unknown_platform_fails(self) -> None:
        """An unknown platform fails with exit code 1 and asks nothing."""
        with mock.patch("ordeal.cli.getpass.getpass") as prompt:
            code, _, err = self.run_cli(["login", "nope"])
        self.assertEqual(code, 1)
        self.assertIn("Unknown platform", err)
        prompt.assert_not_called()


class CheckTests(CliTestCase):
    """The check command confirms one model answers, and refuses a model the platform does not serve."""

    def setUp(self) -> None:
        """Give the groq platform a key, so the list request is allowed to run."""
        super().setUp()
        patcher = mock.patch.dict(os.environ, {"GROQ_API_KEY": FAKE_KEY})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_refuses_unknown_model_with_suggestions(self) -> None:
        """A near-miss name fails with a 'Did you mean' list, and no chat call is made."""
        with self.fake_models(GROQ_MODELS), mock.patch.object(cli, "send_tiny_message") as send:
            code, _, err = self.run_cli(["check", "groq", "org/alpha-7c"])
        self.assertEqual(code, 1)
        self.assertIn("Did you mean", err)
        self.assertIn("org/alpha-7b", err)
        send.assert_not_called()

    def test_accepts_a_model_link_and_makes_one_call(self) -> None:
        """A link to the model page is turned into its id, and exactly one small call is made."""
        with self.fake_models(GROQ_MODELS), mock.patch.object(cli, "send_tiny_message", return_value="ok") as send:
            code, _, _ = self.run_cli(["check", "groq", "https://groq.com/org/alpha-7b"])
        self.assertEqual(code, 0)
        send.assert_called_once()
        route = send.call_args.args[0]
        self.assertEqual(route.api_model, "org/alpha-7b")
        self.assertEqual(route.api_key, FAKE_KEY)


class TestCommandTests(CliTestCase):
    """The test command hands a keyed route to the runner and grades the cache it writes."""

    def setUp(self) -> None:
        """Give the groq platform a key and stop the real runner and grader from starting."""
        super().setUp()
        patcher = mock.patch.dict(os.environ, {"GROQ_API_KEY": FAKE_KEY})
        patcher.start()
        self.addCleanup(patcher.stop)
        runner_patch = mock.patch.object(runner, "main", return_value=0)
        self.runner_main = runner_patch.start()
        self.addCleanup(runner_patch.stop)
        grade_patch = mock.patch.object(grade, "main", return_value=0)
        self.grade_main = grade_patch.start()
        self.addCleanup(grade_patch.stop)

    def test_cache_file_is_named_after_platform_and_model(self) -> None:
        """Two models never share a cache file, and the file name starts with the platform and model."""
        with self.fake_models(GROQ_MODELS):
            code, _, _ = self.run_cli(["test", "groq", "org/alpha-7b", "--limit", "2"])
        self.assertEqual(code, 0)
        cache = Path(self.runner_main.call_args.args[0][self.runner_main.call_args.args[0].index("--cache") + 1])
        self.assertTrue(cache.name.startswith("groq__org_alpha-7b-"), cache.name)
        self.assertTrue(cache.name.endswith(".jsonl"), cache.name)
        # The options after the model name are passed on to the runner.
        self.assertIn("--limit", self.runner_main.call_args.args[0])
        # The grader reads the same cache file.
        grade_argv = self.grade_main.call_args.args[0]
        self.assertEqual(grade_argv[grade_argv.index("--cache") + 1], str(cache))

    def test_runner_gets_the_key_through_a_prebuilt_route(self) -> None:
        """The route handed to the runner carries the saved key, so the runner does not read keys itself."""
        with self.fake_models(GROQ_MODELS):
            self.run_cli(["test", "groq", "org/alpha-7b"])
        routes = self.runner_main.call_args.kwargs["prebuilt_routes"]
        self.assertEqual(list(routes), ["groq/org/alpha-7b"])
        self.assertEqual(routes["groq/org/alpha-7b"].api_key, FAKE_KEY)

    def test_local_route_uses_the_placeholder_key_and_no_key_lookup(self) -> None:
        """A local platform needs no key, so it gets the placeholder and attach_keys is never called."""
        with self.fake_models(["llama3.1:8b"]), mock.patch.object(model_client, "attach_keys") as attach:
            code, _, _ = self.run_cli(["test", "ollama", "llama3.1:8b"])
        self.assertEqual(code, 0)
        attach.assert_not_called()
        routes = self.runner_main.call_args.kwargs["prebuilt_routes"]
        self.assertEqual(routes["ollama/llama3.1:8b"].api_key, providers.LOCAL_KEY_PLACEHOLDER)


# Keys for the providers the multi-provider tests use. Each variable is named in providers.json.
PROVIDER_KEYS = {
    "GROQ_API_KEY": FAKE_KEY,
    "TOGETHER_API_KEY": FAKE_KEY,
    "FIREWORKS_API_KEY": FAKE_KEY,
    "DEEPINFRA_API_KEY": FAKE_KEY,
}


class MultiProviderTests(CliTestCase):
    """The test command runs up to three providers with the same options, each into its own cache, then grades them."""

    def setUp(self) -> None:
        """Give the providers keys, and stop the real runner and grader from starting."""
        super().setUp()
        patcher = mock.patch.dict(os.environ, PROVIDER_KEYS)
        patcher.start()
        self.addCleanup(patcher.stop)
        runner_patch = mock.patch.object(runner, "main", return_value=0)
        self.runner_main = runner_patch.start()
        self.addCleanup(runner_patch.stop)
        grade_patch = mock.patch.object(grade, "main", return_value=0)
        self.grade_main = grade_patch.start()
        self.addCleanup(grade_patch.stop)

    def run_test(self, *args: str) -> tuple[int, str, str]:
        """Run the test command with the fake model list, which every provider serves."""
        with self.fake_models(GROQ_MODELS):
            return self.run_cli(["test", *args])

    def sent_model_ids(self) -> list[str]:
        """Return the API model id of the route given to each run, in run order."""
        return [next(iter(run.kwargs["prebuilt_routes"].values())).api_model for run in self.runner_main.call_args_list]

    def cache_arguments(self, argv: list[str]) -> list[str]:
        """Return the cache file names given to a command, in order, from its --cache options."""
        return [argv[index + 1] for index, name in enumerate(argv) if name == "--cache"]

    def test_one_provider_runs_once_and_grades_its_one_cache(self) -> None:
        """With one provider the command is the same as before: one run, then one grade of that cache."""
        code, _, _ = self.run_test("groq", "org/alpha-7b", "--limit", "2")
        self.assertEqual(code, 0)
        self.assertEqual(self.runner_main.call_count, 1)
        run_caches = self.cache_arguments(self.runner_main.call_args.args[0])
        grade_argv = self.grade_main.call_args.args[0]
        self.assertEqual(self.cache_arguments(grade_argv), run_caches)
        self.assertEqual(len(run_caches), 1)

    def test_three_providers_run_once_each_with_their_own_cache(self) -> None:
        """Three providers give three runs with the same options, one route each, and one cache per provider."""
        code, _, _ = self.run_test("groq,together,fireworks", "org/alpha-7b", "--limit", "2")
        self.assertEqual(code, 0)
        self.assertEqual(self.runner_main.call_count, 3)
        caches, providers_seen = [], []
        for run in self.runner_main.call_args_list:
            self.assertIn("--limit", run.args[0])
            routes = run.kwargs["prebuilt_routes"]
            self.assertEqual(len(routes), 1)
            providers_seen.append(next(iter(routes.values())).provider)
            caches.append(self.cache_arguments(run.args[0])[0])
        self.assertEqual(providers_seen, ["groq", "together", "fireworks"])
        self.assertEqual(len(set(caches)), 3)
        for name, cache in zip(["groq", "together", "fireworks"], caches):
            self.assertTrue(Path(cache).name.startswith(f"{name}__"), cache)

    def test_three_providers_are_graded_together_in_one_call(self) -> None:
        """The grader gets every provider's cache in one call, so one results file holds all of them."""
        self.run_test("groq,together,fireworks", "org/alpha-7b")
        self.assertEqual(self.grade_main.call_count, 1)
        grade_argv = self.grade_main.call_args.args[0]
        run_caches = [self.cache_arguments(run.args[0])[0] for run in self.runner_main.call_args_list]
        self.assertEqual(self.cache_arguments(grade_argv), run_caches)
        self.assertEqual(grade_argv[-2], "--out-dir")

    def test_one_model_name_is_used_for_every_provider(self) -> None:
        """A single model name is looked up on each provider, so the same model is run on all of them."""
        self.run_test("groq,together", "org/alpha-7b")
        self.assertEqual(self.sent_model_ids(), ["org/alpha-7b", "org/alpha-7b"])

    def test_one_model_name_per_provider_gives_each_its_own_model(self) -> None:
        """A comma list of model names pairs with the provider list, so each provider can serve an equivalent model."""
        self.run_test("groq,together", "org/alpha-7b,org/beta-large")
        self.assertEqual(self.sent_model_ids(), ["org/alpha-7b", "org/beta-large"])

    def test_four_providers_are_refused_before_any_run(self) -> None:
        """A fourth provider is refused with a clear message, and no run or key lookup happens."""
        code, _, err = self.run_test("groq,together,fireworks,deepinfra", "org/alpha-7b")
        self.assertEqual(code, 1)
        self.assertIn("at most 3", err)
        self.runner_main.assert_not_called()

    def test_unknown_provider_is_refused_before_any_run(self) -> None:
        """An id that is not in providers.json is refused, the valid ids are listed, and no run starts."""
        code, _, err = self.run_test("groq,nope", "org/alpha-7b")
        self.assertEqual(code, 1)
        self.assertIn("Unknown platform 'nope'", err)
        self.runner_main.assert_not_called()

    def test_repeated_provider_is_refused(self) -> None:
        """Naming the same provider twice is refused, so one provider never runs twice into one results file."""
        code, _, err = self.run_test("groq,groq", "org/alpha-7b")
        self.assertEqual(code, 1)
        self.assertIn("once", err)
        self.runner_main.assert_not_called()

    def test_missing_key_is_refused_before_any_run_and_names_the_variable(self) -> None:
        """A provider with no key stops the command before any run, names the variable, and prints no key value."""
        with mock.patch.dict(os.environ, {"TOGETHER_API_KEY": ""}):
            code, out, err = self.run_test("groq,together", "org/alpha-7b")
        self.assertEqual(code, 1)
        self.assertIn("TOGETHER_API_KEY", err)
        self.assertNotIn(FAKE_KEY, out + err)
        self.runner_main.assert_not_called()

    def test_model_names_must_be_one_or_one_per_provider(self) -> None:
        """Two providers with three model names is refused, and no run starts."""
        code, _, err = self.run_test("groq,together", "org/alpha-7b,org/beta-large,other/alpha-small")
        self.assertEqual(code, 1)
        self.assertIn("one model per provider", err)
        self.runner_main.assert_not_called()


class RunnerHookTests(CliTestCase):
    """The runner accepts routes from the caller and reads no keys for them."""

    def test_runner_uses_given_routes_without_reading_keys(self) -> None:
        """The client built by the runner holds the route's own key, and attach_keys is never called."""
        route = providers.route_for(providers.get_platform("groq"), "org/alpha-7b")
        route = replace(route, api_key="k-1")
        captured = []

        async def fake_run_all(client, *args, **kwargs):
            """Keep the client the runner built, and return empty stats."""
            captured.append(client)
            return runner.RunStats()

        cache = self.folder / "cache.jsonl"
        with mock.patch.object(model_client, "attach_keys", side_effect=AssertionError("no key lookup")), \
                mock.patch.object(runner, "run_all", new=fake_run_all), isolated_run(self.folder / "results"), \
                redirect_stdout(io.StringIO()):
            code = runner.main(
                ["--limit", "1", "--repeats", "1", "--probes", "gauntlet", "--cache", str(cache)],
                prebuilt_routes={route.name: route},
            )
        self.assertEqual(code, 0)
        self.assertEqual(captured[0].routes[route.name].api_key, "k-1")


if __name__ == "__main__":
    unittest.main()
