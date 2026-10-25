"""Tests for providers: the platform registry, model reference parsing, model lookup and route building.

Every test is offline. The one test that asks for a model list replaces the openai client with a fake,
so no network call is made.
"""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from ordeal import providers

# A registry entry that is valid on its own. Each bad-entry test changes one field of a copy.
GOOD_ENTRY = {
    "id": "example",
    "name": "Example",
    "base_url": "https://api.example.com/v1",
    "key_env": "EXAMPLE_KEY",
    "signup": None,
    "web_host": None,
    "browser": False,
    "local": False,
}


class RegistryTests(unittest.TestCase):
    """The registry file is read and every entry is checked before anything else uses it."""

    def setUp(self) -> None:
        """Create a temporary folder for test registry files."""
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)

    def write_registry(self, entries: list) -> Path:
        """Write a registry file with the given entries and return its path."""
        path = self.folder / "providers.json"
        path.write_text(json.dumps({"version": 1, "platforms": entries}), encoding="utf-8")
        return path

    def test_every_registry_entry_validates(self) -> None:
        """The real providers.json loads, with unique ids and the platforms the rest of the code relies on."""
        platforms = providers.load_platforms()
        ids = [platform.id for platform in platforms]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertIn("huggingface", ids)
        self.assertIn("ollama", ids)
        self.assertIn("custom", ids)
        for platform in platforms:
            self.assertIsInstance(platform, providers.Platform)

    def test_valid_entry_loads(self) -> None:
        """A correct entry becomes one Platform with the same fields."""
        platforms = providers.load_platforms(self.write_registry([GOOD_ENTRY]))
        self.assertEqual(platforms[0].id, "example")
        self.assertEqual(platforms[0].base_url, "https://api.example.com/v1")

    def test_missing_field_is_refused(self) -> None:
        """An entry without a required field is refused, and the error names the field."""
        entry = dict(GOOD_ENTRY)
        del entry["name"]
        with self.assertRaisesRegex(ValueError, "name"):
            providers.load_platforms(self.write_registry([entry]))

    def test_unknown_field_is_refused(self) -> None:
        """A misspelt field name is caught, instead of being silently ignored."""
        entry = dict(GOOD_ENTRY, colour="red")
        with self.assertRaisesRegex(ValueError, "colour"):
            providers.load_platforms(self.write_registry([entry]))

    def test_duplicate_id_is_refused(self) -> None:
        """Two entries with the same id are refused, because a route name would be ambiguous."""
        with self.assertRaisesRegex(ValueError, "more than once"):
            providers.load_platforms(self.write_registry([GOOD_ENTRY, dict(GOOD_ENTRY)]))

    def test_bad_id_is_refused(self) -> None:
        """An id with capital letters is refused, because ids are used in route names."""
        entry = dict(GOOD_ENTRY, id="Example")
        with self.assertRaisesRegex(ValueError, "id"):
            providers.load_platforms(self.write_registry([entry]))

    def test_plain_http_hosted_url_is_refused(self) -> None:
        """A hosted platform must use https, because its key would be sent in the clear otherwise."""
        entry = dict(GOOD_ENTRY, base_url="http://api.example.com/v1")
        with self.assertRaisesRegex(ValueError, "https"):
            providers.load_platforms(self.write_registry([entry]))

    def test_hosted_url_with_query_is_refused(self) -> None:
        """A hosted URL with a query string is refused, the same rule model_client uses for custom models."""
        entry = dict(GOOD_ENTRY, base_url="https://api.example.com/v1?key=1")
        with self.assertRaisesRegex(ValueError, "query"):
            providers.load_platforms(self.write_registry([entry]))

    def test_local_platform_refuses_remote_host(self) -> None:
        """A local platform may only point at this computer, so a remote address is refused."""
        entry = dict(GOOD_ENTRY, local=True, key_env=None, base_url="https://api.example.com/v1")
        with self.assertRaisesRegex(ValueError, "local"):
            providers.load_platforms(self.write_registry([entry]))

    def test_local_platform_allows_localhost_http(self) -> None:
        """A local platform may use plain http on 127.0.0.1, which is how local servers run."""
        entry = dict(GOOD_ENTRY, local=True, key_env=None, base_url="http://127.0.0.1:9000/v1")
        platforms = providers.load_platforms(self.write_registry([entry]))
        self.assertTrue(platforms[0].local)

    def test_missing_base_url_is_refused_unless_custom(self) -> None:
        """Only the custom platform may leave its base URL empty, because the user supplies that address."""
        entry = dict(GOOD_ENTRY, base_url=None)
        with self.assertRaisesRegex(ValueError, "base URL"):
            providers.load_platforms(self.write_registry([entry]))

    def test_custom_platform_may_have_no_base_url(self) -> None:
        """The custom platform loads with a null base URL and its own key variable."""
        entry = dict(GOOD_ENTRY, id="custom", base_url=None, key_env="ORDEAL_API_KEY")
        platforms = providers.load_platforms(self.write_registry([entry]))
        self.assertIsNone(platforms[0].base_url)

    def test_hosted_platform_needs_a_key_variable(self) -> None:
        """A hosted platform must name the variable its key is read from."""
        entry = dict(GOOD_ENTRY, key_env=None)
        with self.assertRaisesRegex(ValueError, "key_env"):
            providers.load_platforms(self.write_registry([entry]))

    def test_get_platform_returns_one(self) -> None:
        """get_platform finds an entry by its id."""
        self.assertEqual(providers.get_platform("groq").id, "groq")

    def test_get_platform_unknown_lists_valid_ids(self) -> None:
        """An unknown id is refused, and the error lists the valid ids so the user can pick one."""
        with self.assertRaisesRegex(ValueError, "huggingface"):
            providers.get_platform("no-such-platform")


class ParseModelReferenceTests(unittest.TestCase):
    """What the user types becomes one API model id, or a clear refusal."""

    def setUp(self) -> None:
        """Load one hosted platform and one local platform."""
        self.hosted = providers.get_platform("huggingface")
        self.local = providers.get_platform("ollama")

    def test_plain_id_is_kept(self) -> None:
        """A plain org/name id is returned unchanged."""
        self.assertEqual(providers.parse_model_reference(self.hosted, "org/name"), "org/name")

    def test_surrounding_spaces_are_removed(self) -> None:
        """Spaces around the text the user typed are ignored."""
        self.assertEqual(providers.parse_model_reference(self.hosted, "  org/name  "), "org/name")

    def test_hf_prefix_is_stripped(self) -> None:
        """The hf: prefix is a shorthand, so it is removed."""
        self.assertEqual(providers.parse_model_reference(self.hosted, "hf:org/name"), "org/name")

    def test_link_gives_model_id(self) -> None:
        """A link to the platform's model page becomes the model id, with the scheme, host and slashes removed."""
        link = "https://huggingface.co/org/name/"
        self.assertEqual(providers.parse_model_reference(self.hosted, link), "org/name")

    def test_link_query_and_fragment_are_dropped(self) -> None:
        """The query string and fragment of a link are not part of the model id."""
        link = "https://huggingface.co/org/name/?library=transformers#readme"
        self.assertEqual(providers.parse_model_reference(self.hosted, link), "org/name")

    def test_provider_suffix_is_kept(self) -> None:
        """A provider suffix after a colon is part of the id, because the API needs it."""
        self.assertEqual(providers.parse_model_reference(self.hosted, "org/name:together"), "org/name:together")

    def test_empty_text_is_refused(self) -> None:
        """Empty text, or text that is only spaces, is refused."""
        for text in ("", "   "):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    providers.parse_model_reference(self.hosted, text)

    def test_file_paths_are_refused_for_hosted_platforms(self) -> None:
        """A file path is not a model id, so a hosted platform refuses it and says what to type instead."""
        for text in ("/home/me/model", "./model", "~/model", "models\\name"):
            with self.subTest(text=text):
                with self.assertRaisesRegex(ValueError, "model id"):
                    providers.parse_model_reference(self.hosted, text)

    def test_link_to_another_host_is_refused(self) -> None:
        """A link to any site other than the platform's own web host is refused."""
        with self.assertRaisesRegex(ValueError, "huggingface.co"):
            providers.parse_model_reference(self.hosted, "https://example.com/org/name")

    def test_link_on_local_platform_is_refused(self) -> None:
        """A local platform has no model web page, so a link is refused."""
        with self.assertRaisesRegex(ValueError, "link"):
            providers.parse_model_reference(self.local, "https://huggingface.co/org/name")

    def test_local_served_name_is_allowed(self) -> None:
        """A local server names its models itself, so a plain name like llama3.1:8b is accepted."""
        self.assertEqual(providers.parse_model_reference(self.local, "llama3.1:8b"), "llama3.1:8b")

    def test_id_with_spaces_is_refused(self) -> None:
        """A model id cannot contain spaces."""
        with self.assertRaisesRegex(ValueError, "spaces"):
            providers.parse_model_reference(self.hosted, "org name")

    def test_link_without_a_model_is_refused(self) -> None:
        """A link to the site front page names no model, so it is refused."""
        with self.assertRaises(ValueError):
            providers.parse_model_reference(self.hosted, "https://huggingface.co/")

    def test_hf_prefix_alone_is_refused(self) -> None:
        """The prefix with nothing after it names no model."""
        with self.assertRaises(ValueError):
            providers.parse_model_reference(self.hosted, "hf:")


class FindModelTests(unittest.TestCase):
    """find_model picks one id from the list a platform returned, and explains a miss."""

    AVAILABLE = ["org/Name", "org/name-large", "other/model"]

    def setUp(self) -> None:
        """Load the hosted platform used by every test."""
        self.hosted = providers.get_platform("huggingface")

    def test_exact_match_is_returned(self) -> None:
        """An id that matches exactly is returned as it is."""
        self.assertEqual(providers.find_model(self.hosted, "org/Name", self.AVAILABLE), "org/Name")

    def test_case_insensitive_match_returns_the_listed_spelling(self) -> None:
        """A different capitalisation finds the id, and the id is returned in the platform's own spelling."""
        self.assertEqual(providers.find_model(self.hosted, "ORG/name", self.AVAILABLE), "org/Name")

    def test_no_match_suggests_close_ids(self) -> None:
        """A typo gets up to five close suggestions, so the user can see the right id."""
        with self.assertRaisesRegex(ValueError, "org/name-large"):
            providers.find_model(self.hosted, "org/name-larg", self.AVAILABLE)

    def test_no_match_without_suggestions_says_so(self) -> None:
        """A name that is nothing like any id gets a plain 'no model' message, with no suggestion list."""
        with self.assertRaisesRegex(ValueError, "no model named") as context:
            providers.find_model(self.hosted, "zzzzzz", self.AVAILABLE)
        self.assertNotIn("Did you mean", str(context.exception))

    def test_suggestions_are_at_most_five(self) -> None:
        """Even when many ids are close, the message lists at most five of them."""
        available = [f"m-{number}" for number in range(10)]
        with self.assertRaises(ValueError) as context:
            providers.find_model(self.hosted, "m-x", available)
        suggestion_text = str(context.exception).split("Did you mean:")[1]
        self.assertLessEqual(suggestion_text.count("m-"), 5)

    def test_ambiguous_case_match_is_refused(self) -> None:
        """Two ids that differ only by case cannot be chosen between, so the user must type the exact id."""
        with self.assertRaisesRegex(ValueError, "more than one"):
            providers.find_model(self.hosted, "ORG/NAME", ["org/Name", "org/name"])


class RouteForTests(unittest.TestCase):
    """route_for builds a ModelRoute only when the address is safe for the platform's key."""

    def setUp(self) -> None:
        """Load the platforms used by the route tests."""
        self.hosted = providers.get_platform("huggingface")
        self.local = providers.get_platform("ollama")
        self.custom = providers.get_platform("custom")

    def test_hosted_route_is_named_and_marked_custom(self) -> None:
        """The route is named platform/model, sends to the platform's own address, and gets a saved-reply digest."""
        route = providers.route_for(self.hosted, "org/name")
        self.assertEqual(route.name, "huggingface/org/name")
        self.assertEqual(route.api_model, "org/name")
        self.assertEqual(route.base_url, "https://router.huggingface.co/v1")
        self.assertEqual(route.key_env, "HF_TOKEN")
        self.assertTrue(route.custom)
        self.assertEqual(route.api_key, "")

    def test_custom_route_uses_the_given_address(self) -> None:
        """The custom platform has no fixed address, so the caller's https address is used."""
        route = providers.route_for(self.custom, "my-model", "https://models.example.org/v1")
        self.assertEqual(route.base_url, "https://models.example.org/v1")
        self.assertEqual(route.key_env, "ORDEAL_API_KEY")

    def test_custom_route_without_base_url_is_refused(self) -> None:
        """Without an address the custom platform has nowhere to send the request, so it is refused."""
        with self.assertRaisesRegex(ValueError, "base URL"):
            providers.route_for(self.custom, "my-model")

    def test_custom_plain_http_address_is_refused(self) -> None:
        """A custom address must be https, because the custom key would travel over plain http."""
        with self.assertRaisesRegex(ValueError, "https"):
            providers.route_for(self.custom, "my-model", "http://models.example.org/v1")

    def test_custom_address_with_query_is_refused(self) -> None:
        """A query string on a custom address is refused, the same as model_client does."""
        with self.assertRaises(ValueError):
            providers.route_for(self.custom, "my-model", "https://models.example.org/v1?key=1")

    def test_hosted_platform_refuses_another_host(self) -> None:
        """A hosted platform always uses its own address, so the key cannot be sent to another host."""
        with self.assertRaisesRegex(ValueError, "own address"):
            providers.route_for(self.hosted, "org/name", "https://evil.example.org/v1")

    def test_hosted_platform_accepts_its_own_address(self) -> None:
        """Naming the platform's own address again is allowed."""
        route = providers.route_for(self.hosted, "org/name", self.hosted.base_url)
        self.assertEqual(route.base_url, self.hosted.base_url)

    def test_local_route_uses_localhost_and_needs_no_key_variable(self) -> None:
        """A local route points at localhost, and its key variable is empty because local servers need no key."""
        route = providers.route_for(self.local, "llama3")
        self.assertEqual(route.base_url, "http://localhost:11434/v1")
        self.assertEqual(route.key_env, "")

    def test_local_platform_refuses_a_remote_address(self) -> None:
        """A local platform will not send to a remote address, even when the user types one."""
        with self.assertRaises(ValueError):
            providers.route_for(self.local, "llama3", "https://models.example.org/v1")

    def test_empty_model_id_is_refused(self) -> None:
        """A route needs a model id."""
        with self.assertRaises(ValueError):
            providers.route_for(self.hosted, "")


class FetchModelIdsTests(unittest.TestCase):
    """fetch_model_ids asks the platform for its model list, using a fake client so no network is used."""

    def setUp(self) -> None:
        """Load the hosted and custom platforms used by these tests."""
        self.hosted = providers.get_platform("huggingface")
        self.custom = providers.get_platform("custom")

    def test_ids_come_back_sorted(self) -> None:
        """The ids from the platform are returned sorted, so the output is the same on every run."""
        fake_client = mock.Mock()
        fake_client.models.list.return_value = SimpleNamespace(
            data=[SimpleNamespace(id="org/b"), SimpleNamespace(id="org/a")]
        )
        with mock.patch("ordeal.providers.openai.OpenAI", return_value=fake_client) as client_class:
            ids = providers.fetch_model_ids(self.hosted, "test-key")
        self.assertEqual(ids, ["org/a", "org/b"])
        # The client is built with the platform's address, the key and retries switched off.
        kwargs = client_class.call_args.kwargs
        self.assertEqual(kwargs["base_url"], self.hosted.base_url)
        self.assertEqual(kwargs["api_key"], "test-key")
        self.assertEqual(kwargs["max_retries"], 0)

    def test_missing_key_is_refused_before_any_call(self) -> None:
        """A hosted platform with no key is refused before any request is made, and the error names the variable."""
        with mock.patch("ordeal.providers.openai.OpenAI") as client_class:
            with self.assertRaisesRegex(ValueError, "HF_TOKEN"):
                providers.fetch_model_ids(self.hosted, "")
        client_class.assert_not_called()

    def test_custom_platform_needs_an_address(self) -> None:
        """The custom platform cannot list models until the caller gives an address."""
        with self.assertRaisesRegex(ValueError, "base URL"):
            providers.fetch_model_ids(self.custom, "test-key")


if __name__ == "__main__":
    unittest.main()
