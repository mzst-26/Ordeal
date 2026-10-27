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
from datetime import datetime
from pathlib import Path
from unittest import mock

from ordeal import cli, core, grade, keys, model_client, providers, runner
from tests.fake_clock import isolated_run

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

    def test_lists_every_website_platform(self) -> None:
        """Each platform the website shows appears in the output, with a header row."""
        code, out, _ = self.run_cli(["platforms"])
        self.assertEqual(code, 0)
        self.assertIn("Key", out)
        for platform in providers.web_platforms(providers.load_platforms()):
            self.assertIn(platform.id, out)

    def test_leaves_out_platforms_the_website_does_not_show(self) -> None:
        """A local server is in providers.json but not on the website, so the command line does not list it."""
        code, out, _ = self.run_cli(["platforms"])
        self.assertEqual(code, 0)
        self.assertNotIn("ollama", out)

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

    def test_platform_not_on_the_website_is_refused(self) -> None:
        """A platform the website does not show (a local server) is refused and asks for no key."""
        with mock.patch("ordeal.cli.getpass.getpass") as prompt:
            code, _, err = self.run_cli(["login", "ollama"])
        self.assertEqual(code, 1)
        self.assertIn("'ollama' is not one of the platforms on the website", err)
        self.assertIn("groq", err)
        prompt.assert_not_called()
        self.assertFalse(keys.credentials_path().exists())

    def test_unknown_platform_is_refused(self) -> None:
        """An unknown platform fails with exit code 1 and asks nothing."""
        with mock.patch("ordeal.cli.getpass.getpass") as prompt:
            code, _, err = self.run_cli(["login", "nope"])
        self.assertEqual(code, 1)
        self.assertIn("'nope' is not one of the platforms on the website", err)
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
        # The grader is faked, so no tables exist to describe. This also keeps source.json out of the real docs/ folder.
        source_patch = mock.patch.object(cli, "write_source_file")
        source_patch.start()
        self.addCleanup(source_patch.stop)

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


class SummaryFolderTests(CliTestCase):
    """The summary tables of a command-line run go under docs/cli-results, and the raw replies stay in results/.

    The test runs inside a temporary folder, so nothing is written into the real docs/ folder.
    """

    def setUp(self) -> None:
        """Give the groq platform a key, stop the runner and grader, and move into a temporary folder."""
        super().setUp()
        env_patch = mock.patch.dict(os.environ, {"GROQ_API_KEY": FAKE_KEY})
        env_patch.start()
        self.addCleanup(env_patch.stop)
        runner_patch = mock.patch.object(runner, "main", return_value=0)
        self.runner_main = runner_patch.start()
        self.addCleanup(runner_patch.stop)
        grade_patch = mock.patch.object(grade, "main", return_value=0)
        self.grade_main = grade_patch.start()
        self.addCleanup(grade_patch.stop)
        previous_folder = os.getcwd()
        work_dir = tempfile.TemporaryDirectory()
        self.addCleanup(work_dir.cleanup)
        os.chdir(work_dir.name)
        self.addCleanup(os.chdir, previous_folder)
        self.work_dir = Path(work_dir.name).resolve()

    def test_summaries_default_to_docs_cli_results_by_suite_and_condition(self) -> None:
        """The three summary tables go to docs/cli-results/<suite>/<condition>/ by default."""
        with self.fake_models(GROQ_MODELS):
            code, _, _ = self.run_cli(["test", "groq", "org/alpha-7b"])
        self.assertEqual(code, 0)
        grade_argv = self.grade_main.call_args.args[0]
        out_dir = Path(grade_argv[grade_argv.index("--out-dir") + 1])
        suite = core.load_chosen_suite()
        self.assertEqual(out_dir, self.work_dir / "docs" / "cli-results" / suite.name / core.NO_SYSTEM_PROMPT)

    def test_raw_replies_stay_in_results(self) -> None:
        """The cache file is still written under results/, not under docs/."""
        with self.fake_models(GROQ_MODELS):
            self.run_cli(["test", "groq", "org/alpha-7b"])
        cache = Path(self.runner_main.call_args.args[0][self.runner_main.call_args.args[0].index("--cache") + 1])
        self.assertEqual(cache.parent, self.work_dir / "results")

    def test_out_dir_option_chooses_another_folder(self) -> None:
        """--out-dir sends the summary tables to the folder given, and is not passed on to the runner."""
        chosen = self.work_dir / "my-tables"
        with self.fake_models(GROQ_MODELS):
            code, _, _ = self.run_cli(["test", "groq", "org/alpha-7b", "--out-dir", str(chosen)])
        self.assertEqual(code, 0)
        grade_argv = self.grade_main.call_args.args[0]
        self.assertEqual(grade_argv[grade_argv.index("--out-dir") + 1], str(chosen))
        self.assertNotIn("--out-dir", self.runner_main.call_args.args[0])

    def test_source_file_says_where_the_tables_came_from(self) -> None:
        """source.json names the command line, the suite, the condition, the time, and the files written beside it."""
        chosen = self.work_dir / "tables"
        chosen.mkdir()
        write_results_csv(chosen / grade.RESULTS_FILE_NAME, ["org/alpha-7b", "org/beta-large", "org/beta-large"])
        with self.fake_models(GROQ_MODELS):
            self.run_cli(["test", "groq", "org/alpha-7b", "--out-dir", str(chosen)])
        record = json.loads((chosen / cli.SOURCE_FILE_NAME).read_text(encoding="utf-8"))
        suite = core.load_chosen_suite()
        self.assertEqual(record["source"], "command line")
        self.assertEqual(record["suite"], suite.name)
        self.assertEqual(record["condition"], core.NO_SYSTEM_PROMPT)
        self.assertEqual(record["models"], 2)
        self.assertEqual(record["questions"], len(suite.questions))
        self.assertEqual(record["files"], ["results.csv", "probes.csv", "by_difficulty.csv"])
        # The time is a full date and time, so it can be read back as one.
        datetime.fromisoformat(record["written_at"])

    def test_source_file_holds_no_key_and_no_env_path(self) -> None:
        """Nothing in source.json looks like a key or points at the .env file."""
        chosen = self.work_dir / "tables"
        with self.fake_models(GROQ_MODELS):
            self.run_cli(["test", "groq", "org/alpha-7b", "--out-dir", str(chosen)])
        text = (chosen / cli.SOURCE_FILE_NAME).read_text(encoding="utf-8")
        self.assertNotIn(FAKE_KEY, text)
        self.assertNotIn(".env", text)

    def test_no_source_file_when_grading_found_nothing(self) -> None:
        """When the grader finds no saved replies, it writes no tables, so no source.json either."""
        chosen = self.work_dir / "tables"
        self.grade_main.return_value = 1
        with self.fake_models(GROQ_MODELS):
            self.run_cli(["test", "groq", "org/alpha-7b", "--out-dir", str(chosen)])
        self.assertFalse((chosen / cli.SOURCE_FILE_NAME).exists())


def write_results_csv(path: Path, models: list[str]) -> None:
    """Write a small results.csv with one row per model, using the same first two columns as the real file."""
    lines = ["suite,condition,model"]
    lines += [f"{core.load_chosen_suite().name},{core.NO_SYSTEM_PROMPT},{model}" for model in models]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


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
