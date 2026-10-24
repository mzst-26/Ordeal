"""Tests for model_client: the retry and error helpers, custom model rules, keys and per-model routing.

The openai error objects are built from local httpx2 requests and responses. The routing test talks only
to the local mock server on 127.0.0.1, so no network is used.
"""

import asyncio
import os
import unittest
from unittest import mock

import httpx2
import openai

import core
import model_client
from model_client import ModelRoute, describe_error, is_retryable
from tests.mock_openai import MockOpenAIServer

CUSTOM_KEY_VAR = "SPINE_TEST_ROUTE_KEY_UNSET"
CUSTOM_ENTRY = {
    "name": "my-model",
    "base_url": "https://models.example.org/v1",
    "model": "org/my-model",
    "api_key_env": CUSTOM_KEY_VAR,
}

API_URL = "https://example.invalid/v1/chat/completions"


def fake_response(status_code: int) -> httpx2.Response:
    """Build a response object for an openai status error, without sending anything."""
    request = httpx2.Request("POST", API_URL)
    return httpx2.Response(status_code, request=request)


def fake_request() -> httpx2.Request:
    """Build a request object for an openai connection error, without sending anything."""
    return httpx2.Request("POST", API_URL)


class IsRetryableTests(unittest.TestCase):
    def test_rate_limit_error_is_retryable(self):
        error = openai.RateLimitError("slow down", response=fake_response(429), body=None)
        self.assertTrue(is_retryable(error))

    def test_timeout_error_is_retryable(self):
        self.assertTrue(is_retryable(openai.APITimeoutError(request=fake_request())))

    def test_connection_error_is_retryable(self):
        self.assertTrue(is_retryable(openai.APIConnectionError(request=fake_request())))

    def test_server_error_is_retryable(self):
        error = openai.InternalServerError("server broke", response=fake_response(500), body=None)
        self.assertTrue(is_retryable(error))

    def test_generic_value_error_is_not_retryable(self):
        self.assertFalse(is_retryable(ValueError("bad value")))

    def test_authentication_error_is_not_retryable(self):
        error = openai.AuthenticationError("bad key", response=fake_response(401), body=None)
        self.assertFalse(is_retryable(error))

    def test_bad_request_error_is_not_retryable(self):
        error = openai.BadRequestError("bad request", response=fake_response(400), body=None)
        self.assertFalse(is_retryable(error))

    def test_not_found_error_is_not_retryable(self):
        error = openai.NotFoundError("no such model", response=fake_response(404), body=None)
        self.assertFalse(is_retryable(error))


class DescribeErrorTests(unittest.TestCase):
    def test_starts_with_class_name_and_message(self):
        self.assertEqual(describe_error(ValueError("boom")), "ValueError: boom")

    def test_long_message_is_cut_to_200_characters(self):
        text = describe_error(ValueError("x" * 500))
        self.assertLessEqual(len(text), 200)
        self.assertTrue(text.startswith("ValueError: "))


class CustomModelRuleTests(unittest.TestCase):
    """config.json custom models: https only, no user name or password, no query string, a key from a named variable."""

    def config(self, **changes):
        """Return a config with the built-in model list and one custom entry, with some fields changed."""
        entry = dict(CUSTOM_ENTRY, **changes)
        return {"models": ["built-in-model"], "custom_models": [entry]}

    def test_valid_entry_becomes_a_route_without_a_key(self):
        routes = model_client.load_custom_models(self.config())
        self.assertEqual(
            routes,
            [ModelRoute("my-model", "org/my-model", "https://models.example.org/v1", CUSTOM_KEY_VAR, custom=True)],
        )

    def test_http_user_name_password_and_query_string_are_refused(self):
        bad_urls = (
            "http://models.example.org/v1",
            "https://user:hunter2@models.example.org/v1",
            "https://user@models.example.org/v1",
            "https://models.example.org/v1?key=abc",
            "https://models.example.org/v1?",
            "https:///v1",
        )
        for url in bad_urls:
            with self.subTest(url=url):
                with self.assertRaises(ValueError) as context:
                    model_client.load_custom_models(self.config(base_url=url))
                self.assertIn("my-model", str(context.exception))
                self.assertNotIn("hunter2", str(context.exception))
                self.assertNotIn("abc", str(context.exception))

    def test_url_with_fragment_is_refused(self):
        with self.assertRaises(ValueError) as context:
            model_client.load_custom_models(self.config(base_url="https://models.example.org/v1#section"))
        self.assertIn("my-model", str(context.exception))

    def test_url_with_trailing_newline_or_control_character_is_refused(self):
        base = "https://models.example.org/v1"
        for url in (base + "\n", base + "\t", base + "\x7f"):
            with self.subTest(url=repr(url)):
                with self.assertRaises(ValueError):
                    model_client.load_custom_models(self.config(base_url=url))

    def test_key_variable_must_be_a_name_and_not_the_token_factory_key(self):
        for key_env in ("", "1BAD", "NOT A NAME", core.TOKEN_ENV_VAR):
            with self.subTest(api_key_env=key_env):
                with self.assertRaises(ValueError):
                    model_client.load_custom_models(self.config(api_key_env=key_env))

    def test_custom_name_cannot_repeat_a_built_in_or_another_custom_name(self):
        with self.assertRaises(ValueError):
            model_client.load_custom_models({"models": ["my-model"], "custom_models": [CUSTOM_ENTRY]})
        with self.assertRaises(ValueError):
            model_client.load_custom_models({"models": [], "custom_models": [CUSTOM_ENTRY, CUSTOM_ENTRY]})

    def test_entry_missing_a_field_is_refused(self):
        entry = {key: value for key, value in CUSTOM_ENTRY.items() if key != "model"}
        with self.assertRaises(ValueError):
            model_client.load_custom_models({"models": [], "custom_models": [entry]})

    def test_no_custom_models_gives_no_routes(self):
        self.assertEqual(model_client.load_custom_models({"models": ["a"], "custom_models": []}), [])


class CustomKeyTests(unittest.TestCase):
    """Keys come from the named variable. A missing key is reported by name, and no value is ever shown."""

    def setUp(self):
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop(CUSTOM_KEY_VAR, None)
        no_env_file = mock.patch.object(core, "load_env_file")
        no_env_file.start()
        self.addCleanup(no_env_file.stop)
        self.route = ModelRoute("my-model", "org/my-model", "https://models.example.org/v1", CUSTOM_KEY_VAR)

    def test_missing_key_error_names_the_variable(self):
        with self.assertRaises(RuntimeError) as context:
            model_client.read_route_key(self.route)
        self.assertIn(CUSTOM_KEY_VAR, str(context.exception))

    def test_present_key_is_read_from_the_environment(self):
        os.environ[CUSTOM_KEY_VAR] = "secret-value-123"
        self.assertEqual(model_client.read_route_key(self.route), "secret-value-123")

    def test_route_text_never_shows_the_key(self):
        keyed = dict(name="my-model", api_model="m", base_url="https://x.example.org/v1", key_env=CUSTOM_KEY_VAR)
        route = ModelRoute(**keyed, api_key="secret-value-123")
        self.assertNotIn("secret-value-123", repr(route))

    def test_attach_keys_reads_the_key_of_every_route(self):
        os.environ[CUSTOM_KEY_VAR] = "secret-value-123"
        os.environ[core.TOKEN_ENV_VAR] = "token-value-456"
        routes = {
            "my-model": self.route,
            "built-in": ModelRoute("built-in", "built-in", "https://api.example.org/v1", core.TOKEN_ENV_VAR),
        }
        keyed = model_client.attach_keys(routes)
        self.assertEqual(keyed["my-model"].api_key, "secret-value-123")
        self.assertEqual(keyed["built-in"].api_key, "token-value-456")


class ModelRouterTests(unittest.TestCase):
    """Each model's requests carry its own API model id and its own key, and go to its own endpoint."""

    def test_each_model_uses_its_own_key_and_api_model(self):
        no_proxy = {"NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}
        message = [{"role": "user", "content": "Which is larger?"}]

        async def scenario(server):
            routes = {
                "good": ModelRoute("good", "org/good-model", server.base_url, "KEY_GOOD", api_key="key-a"),
                "bad": ModelRoute("bad", "org/bad-model", server.base_url, "KEY_BAD", api_key="key-b"),
            }
            router = model_client.ModelRouter(routes, timeout_seconds=10)
            try:
                reply = await router.complete("good", message, 0.7, 16)
                with self.assertRaises(openai.AuthenticationError):
                    await router.complete("bad", message, 0.7, 16)
            finally:
                await router.close()
            return reply

        with MockOpenAIServer(api_key="key-a") as server, mock.patch.dict(os.environ, no_proxy):
            reply = asyncio.run(scenario(server))
        self.assertEqual(reply, "Answer: A")
        self.assertEqual([request["model"] for request in server.requests], ["org/good-model", "org/bad-model"])


class RecordLabelTests(unittest.TestCase):
    """The name saved with each reply: built-in models keep their name, custom models add a digest."""

    def custom(self, base_url: str, api_model: str) -> ModelRoute:
        """Return a custom route named 'mine' for the given endpoint and API model id."""
        return ModelRoute("mine", api_model, base_url, CUSTOM_KEY_VAR, custom=True)

    def test_built_in_model_keeps_its_name(self):
        route = ModelRoute("Qwen/Qwen3-30B-A3B-Instruct-2507", "Qwen/Qwen3-30B-A3B-Instruct-2507",
                           "https://api.example.org/v1", core.TOKEN_ENV_VAR)
        self.assertEqual(model_client.record_label(route), "Qwen/Qwen3-30B-A3B-Instruct-2507")

    def test_custom_label_is_name_at_eight_hex_digits(self):
        label = model_client.record_label(self.custom("https://a.example.org/v1", "org/x"))
        self.assertRegex(label, r"^mine@[0-9a-f]{8}$")

    def test_same_name_different_base_url_gives_different_record_keys(self):
        """Two custom routes with the same name but different endpoints never share saved replies."""
        first = self.custom("https://a.example.org/v1", "org/x")
        second = self.custom("https://b.example.org/v1", "org/x")
        key_first = core.make_key("none", model_client.record_label(first), "q1", 1, "level_1")
        key_second = core.make_key("none", model_client.record_label(second), "q1", 1, "level_1")
        self.assertNotEqual(key_first, key_second)

    def test_same_name_and_endpoint_but_different_api_model_gives_different_labels(self):
        first = self.custom("https://a.example.org/v1", "org/x")
        second = self.custom("https://a.example.org/v1", "org/y")
        self.assertNotEqual(model_client.record_label(first), model_client.record_label(second))

    def test_record_labels_follow_the_config_and_the_test_override(self):
        """Built-in names are unchanged; a custom name is labelled; the test-only base URL changes the custom label."""
        config = dict(core.load_config())
        route = self.custom("https://a.example.org/v1", "org/x")
        labels = model_client.record_labels(["built-in/m", "mine"], config, [route], None)
        self.assertEqual(labels["built-in/m"], "built-in/m")
        self.assertEqual(labels["mine"], model_client.record_label(route))
        overridden = model_client.record_labels(["mine"], config, [route], "http://127.0.0.1:9/v1")
        self.assertNotEqual(overridden["mine"], labels["mine"])


if __name__ == "__main__":
    unittest.main()
