"""Tests for model_client: the retry and error helpers, custom model rules, keys and per-model routing.

The openai error objects are built from local httpx2 requests and responses. The routing test talks only
to the local mock server on 127.0.0.1, so no network is used.
"""

import asyncio
import os
import unittest
from dataclasses import replace
from unittest import mock

import httpx2
import openai

from ordeal import core
from ordeal import limiter
from ordeal import model_client
from ordeal.model_client import ModelRoute, describe_error, is_retryable
from tests.python.mock_openai import DEFAULT_KEY, MockOpenAIServer

# A key variable name that is never set in the environment, so tests control exactly when a key exists.
# CUSTOM_ENTRY is a valid config.json custom_models entry; tests change one field at a time to break it.
CUSTOM_KEY_VAR = "SPINE_TEST_ROUTE_KEY_UNSET"
CUSTOM_ENTRY = {
    "name": "my-model",
    "base_url": "https://models.example.org/v1",
    "model": "org/my-model",
    "api_key_env": CUSTOM_KEY_VAR,
}

# The .invalid top-level domain never resolves, so these fake requests cannot reach a real server.
API_URL = "https://example.invalid/v1/chat/completions"


def fake_response(status_code: int, headers: dict[str, str] | None = None) -> httpx2.Response:
    """Build a response object for an openai status error, without sending anything."""
    request = httpx2.Request("POST", API_URL)
    return httpx2.Response(status_code, headers=headers, request=request)


def fake_request() -> httpx2.Request:
    """Build a request object for an openai connection error, without sending anything."""
    return httpx2.Request("POST", API_URL)


# Guards the retry policy: only temporary failures (rate limit, timeout, connection, server error) are
# retried. Permanent client errors (bad key, bad request, unknown model) must fail at once, because
# repeating them cannot succeed and would only waste the call budget.
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


# Guards the error text written to logs: it names the error class and is capped at 200 characters.
class DescribeErrorTests(unittest.TestCase):
    def test_starts_with_class_name_and_message(self):
        self.assertEqual(describe_error(ValueError("boom")), "ValueError: boom")

    def test_long_message_is_cut_to_200_characters(self):
        text = describe_error(ValueError("x" * 500))
        self.assertLessEqual(len(text), 200)
        self.assertTrue(text.startswith("ValueError: "))


# Guards the safety rules for user-supplied models in config.json. Unsafe URLs (plain http, embedded
# login, query string, fragment, control characters) are refused so that a key is never sent over an
# insecure link and secrets in a URL never end up in error messages. Names and key variables are also
# validated, and a custom entry may not reuse the main Token Factory key.
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


# Guards key handling: a missing key is reported by variable name only, and a key value never appears
# in repr output (so it cannot leak into logs). The environment and .env loading are patched in setUp
# so the developer's real keys cannot affect the result.
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


# Guards per-model routing: one router must send each model's request with that model's own key and
# API model id. The server accepts only key-a, so the call for 'bad' (key-b) must fail with an
# authentication error. NO_PROXY keeps the local mock server from being sent through a proxy.
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


# Guards the label saved with each reply, which becomes part of the resume key. A custom model's label
# includes a digest of its endpoint and API model id, so changing either one cannot silently reuse
# replies saved from a different model under the same name.
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


# Loopback addresses must bypass any proxy, or the local mock server would be reached through it.
LOOPBACK_NO_PROXY = {"NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}
MESSAGE = [{"role": "user", "content": "Which is larger?"}]


# Guards the detailed reply: the text, the reply headers and the usage counts must come back from one call,
# because the runner learns the provider's limits from the same reply it saves.
class CompleteDetailedTests(unittest.TestCase):
    """complete_detailed keeps the reply headers (lower-case names) and the usage counts."""

    def test_reply_has_text_lower_case_headers_and_usage(self):
        headers = {"X-RateLimit-Limit-Requests": "600", "X-RateLimit-Remaining-Requests": "599"}

        async def scenario(server):
            client = model_client.TokenFactoryClient(server.base_url, DEFAULT_KEY, timeout_seconds=10)
            try:
                return await client.complete_detailed("org/model", MESSAGE, 0.7, 16)
            finally:
                await client.close()

        with MockOpenAIServer(reply_headers=headers) as server, mock.patch.dict(os.environ, LOOPBACK_NO_PROXY):
            reply = asyncio.run(scenario(server))
        self.assertEqual(reply.text, "Answer: A")
        self.assertEqual(reply.headers["x-ratelimit-limit-requests"], "600")
        self.assertEqual(reply.headers["x-ratelimit-remaining-requests"], "599")
        # The mock counts words: the question has 3, the reply "Answer: A" has 2.
        self.assertEqual(reply.prompt_tokens, 3)
        self.assertEqual(reply.completion_tokens, 2)


# Guards the cut-off reply: when max_tokens stops the answer (finish_reason "length"), the client must raise
# TruncatedReply, so the runner records a failure instead of saving a blank or partial answer as a real one.
class TruncatedReplyTests(unittest.TestCase):
    """A reply cut off by max_tokens is an error, not a reply."""

    def test_length_finish_reason_raises_truncated_reply(self):
        async def scenario(server):
            client = model_client.TokenFactoryClient(server.base_url, DEFAULT_KEY, timeout_seconds=10)
            try:
                return await client.complete_detailed("org/model", MESSAGE, 0.7, 16)
            finally:
                await client.close()

        with MockOpenAIServer(finish_reason="length") as server, mock.patch.dict(os.environ, LOOPBACK_NO_PROXY):
            with self.assertRaises(model_client.TruncatedReply):
                asyncio.run(scenario(server))

    def test_stop_finish_reason_still_returns_the_reply(self):
        async def scenario(server):
            client = model_client.TokenFactoryClient(server.base_url, DEFAULT_KEY, timeout_seconds=10)
            try:
                return await client.complete_detailed("org/model", MESSAGE, 0.7, 16)
            finally:
                await client.close()

        with MockOpenAIServer(finish_reason="stop") as server, mock.patch.dict(os.environ, LOOPBACK_NO_PROXY):
            reply = asyncio.run(scenario(server))
        self.assertEqual(reply.text, "Answer: A")

    def test_truncated_reply_is_not_retryable(self):
        """Asking again with the same max_tokens would be cut off the same way, so the runner must not retry it."""
        self.assertFalse(is_retryable(model_client.TruncatedReply("cut off")))


# Guards the empty reply: a reply with no words in it (no content, only spaces, or only control tokens) is an error,
# not an answer, so the runner records a failure instead of saving it. The web batch does the same.
class EmptyReplyTests(unittest.TestCase):
    """A reply with no words in it is an error, not a reply."""

    def _reply_with(self, text):
        async def scenario(server):
            client = model_client.TokenFactoryClient(server.base_url, DEFAULT_KEY, timeout_seconds=10)
            try:
                return await client.complete_detailed("org/model", MESSAGE, 0.7, 16)
            finally:
                await client.close()

        with MockOpenAIServer(responder=lambda body: text) as server, mock.patch.dict(os.environ, LOOPBACK_NO_PROXY):
            return asyncio.run(scenario(server))

    def test_empty_content_raises_empty_reply(self):
        with self.assertRaises(model_client.EmptyReply):
            self._reply_with("")

    def test_spaces_only_raise_empty_reply(self):
        with self.assertRaises(model_client.EmptyReply):
            self._reply_with("   \n ")

    def test_control_tokens_only_raise_empty_reply(self):
        with self.assertRaises(model_client.EmptyReply):
            self._reply_with("<|start|>assistant<|channel|>")

    def test_empty_reply_is_not_retryable(self):
        """The same request would give the same empty reply, so the runner must not spend the cap on a retry."""
        self.assertFalse(is_retryable(model_client.EmptyReply("no text")))

    def test_a_reply_with_words_is_still_returned(self):
        self.assertEqual(self._reply_with("<|channel|>Answer: B").text, "<|channel|>Answer: B")


# Guards the link between the router and the pacer: the limits in a reply's headers must reach the pacer for
# that model, so the snapshot shows the provider's own limit and says it came from the headers.
class RouterReplyHeaderTests(unittest.TestCase):
    """The headers of a routed reply, handed to the pacer, set that model's limits."""

    def test_reply_headers_give_the_model_its_header_limits(self):
        headers = {"x-ratelimit-limit-requests": "600", "x-ratelimit-limit-tokens": "400000"}
        route = ModelRoute("good", "org/good-model", "", "KEY_GOOD", api_key=DEFAULT_KEY)

        async def scenario(server):
            routes = {"good": replace(route, base_url=server.base_url)}
            router = model_client.ModelRouter(routes, timeout_seconds=10)
            try:
                return await router.complete_detailed("good", MESSAGE, 0.7, 16)
            finally:
                await router.close()

        with MockOpenAIServer(reply_headers=headers) as server, mock.patch.dict(os.environ, LOOPBACK_NO_PROXY):
            reply = asyncio.run(scenario(server))
        pacer = limiter.Pacer(table={})
        pacer.record_headers("good", reply.headers)
        snapshot = pacer.snapshot_for("good")
        self.assertEqual(snapshot["requests_per_minute"], 600)
        self.assertEqual(snapshot["tokens_per_minute"], 400000)
        self.assertEqual(snapshot["source"], "headers")


# Guards the wait a rate-limit error asks for. The runner parks a model for this long, so a wrong reading
# would stall a model for too long or send calls into a provider that is still refusing them.
class RetryAfterTests(unittest.TestCase):
    """retry_after_seconds reads the retry-after header, then the reset header, and gives None when neither is there."""

    def test_retry_after_header_gives_its_seconds(self):
        error = openai.RateLimitError("slow down", response=fake_response(429, {"retry-after": "7"}), body=None)
        self.assertEqual(model_client.retry_after_seconds(error), 7.0)

    def test_reset_requests_header_is_used_when_there_is_no_retry_after(self):
        headers = {"x-ratelimit-reset-requests": "1m30s"}
        error = openai.RateLimitError("slow down", response=fake_response(429, headers), body=None)
        self.assertEqual(model_client.retry_after_seconds(error), 90.0)

    def test_error_with_no_wait_header_gives_none(self):
        error = openai.RateLimitError("slow down", response=fake_response(429), body=None)
        self.assertIsNone(model_client.retry_after_seconds(error))

    def test_error_with_no_response_gives_none(self):
        self.assertIsNone(model_client.retry_after_seconds(openai.APITimeoutError(request=fake_request())))

    def test_only_a_rate_limit_error_counts_as_a_rate_limit(self):
        rate_limit = openai.RateLimitError("slow down", response=fake_response(429), body=None)
        server_error = openai.InternalServerError("broke", response=fake_response(500), body=None)
        self.assertTrue(model_client.is_rate_limit(rate_limit))
        self.assertFalse(model_client.is_rate_limit(server_error))


if __name__ == "__main__":
    unittest.main()
