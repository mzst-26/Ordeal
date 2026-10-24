"""Tests for the local OpenAI-compatible mock in tests/mock_openai.py.

Everything runs against 127.0.0.1. No outbound network calls are made.
"""

import asyncio
import http.client
import json
import os
import socket
import unittest
from contextlib import contextmanager
from urllib.parse import urlsplit

import openai

from model_client import TokenFactoryClient
from tests.mock_openai import MockOpenAIServer

# Key the mock accepts by default, and the model name used in the requests below.
KEY = "test-key-123"
MODEL = "test-model"
# Exactly the fields the mock may record. Anything else (such as headers) would risk leaking the key.
RECORD_KEYS = {"path", "model", "messages", "temperature", "max_tokens"}


def chat_body(content="Hello", model=MODEL):
    """Return a chat request body with one user message."""
    return {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0,
        "max_tokens": 16,
    }


def post(mock, body=None, headers=None, raw=None):
    """POST to the mock's chat endpoint with http.client (no proxies). Return (status, text)."""
    port = mock.port
    path = urlsplit(mock.base_url).path + "/chat/completions"
    payload = raw if raw is not None else json.dumps(body or chat_body()).encode("utf-8")
    request_headers = {"Content-Type": "application/json"}
    request_headers.update(headers or {})
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.request("POST", path, body=payload, headers=request_headers)
        response = connection.getresponse()
        return response.status, response.read().decode("utf-8")
    finally:
        connection.close()


def auth_headers(key=KEY):
    """Return the Authorization header for the given key."""
    return {"Authorization": f"Bearer {key}"}


@contextmanager
def loopback_without_proxy():
    """Let the SDK reach 127.0.0.1 directly even if the environment sets a proxy. Restores env afterwards."""
    saved = {name: os.environ.get(name) for name in ("NO_PROXY", "no_proxy")}
    extra = "127.0.0.1,localhost"
    for name in ("NO_PROXY", "no_proxy"):
        current = os.environ.get(name)
        os.environ[name] = f"{current},{extra}" if current else extra
    try:
        yield
    finally:
        for name, value in saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


# Test groups: reply shape and custom responder; 401 on a missing or wrong key; queued failures served in order;
# the record list holds body fields only; the port is released on exit; the project's own client works against the mock.
class MockOpenAIServerTests(unittest.TestCase):
    # Guards the default success path: a valid OpenAI chat.completion body with consistent token usage.
    def test_plain_request_returns_responder_text(self):
        with MockOpenAIServer() as mock:
            status, text = post(mock, headers=auth_headers())
        self.assertEqual(status, 200)
        data = json.loads(text)
        self.assertEqual(data["object"], "chat.completion")
        self.assertIsInstance(data["created"], int)
        self.assertEqual(data["model"], MODEL)
        choice = data["choices"][0]
        self.assertEqual(choice["message"], {"role": "assistant", "content": "Answer: A"})
        self.assertEqual(choice["finish_reason"], "stop")
        usage = data["usage"]
        self.assertEqual(usage["total_tokens"], usage["prompt_tokens"] + usage["completion_tokens"])

    # Guards that a test's own responder is given the parsed request and its text becomes the reply.
    def test_custom_responder_receives_parsed_request(self):
        seen = []

        def responder(request_json):
            seen.append(request_json)
            return request_json["messages"][-1]["content"].upper()

        with MockOpenAIServer(responder=responder) as mock:
            status, text = post(mock, body=chat_body("ping"), headers=auth_headers())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(text)["choices"][0]["message"]["content"], "PING")
        self.assertEqual(seen[0]["messages"][0]["content"], "ping")

    # Guards authentication: a missing or wrong key is refused with 401 and an OpenAI-style JSON error, like the real API.
    def test_missing_key_gives_401_with_json_error(self):
        with MockOpenAIServer() as mock:
            status, text = post(mock)
        self.assertEqual(status, 401)
        self.assertIn("error", json.loads(text))

    def test_wrong_key_gives_401_with_json_error(self):
        with MockOpenAIServer() as mock:
            status, text = post(mock, headers=auth_headers("wrong-key"))
        self.assertEqual(status, 401)
        self.assertIn("error", json.loads(text))

    # Guards failure injection: a queued failure is served once, then normal replies resume (used to test retry code).
    def test_queued_429_then_success(self):
        with MockOpenAIServer() as mock:
            mock.add_failure(429, count=1)
            first_status, first_text = post(mock, headers=auth_headers())
            second_status, second_text = post(mock, headers=auth_headers())
        self.assertEqual(first_status, 429)
        self.assertIn("error", json.loads(first_text))
        self.assertEqual(second_status, 200)
        self.assertEqual(json.loads(second_text)["choices"][0]["message"]["content"], "Answer: A")

    # Guards the invalid-JSON injection: status 200 with an unparseable body for one request, then normal replies.
    def test_invalid_json_mode_gives_unparseable_body_once(self):
        with MockOpenAIServer() as mock:
            mock.add_invalid_json(count=1)
            status, text = post(mock, headers=auth_headers())
            next_status, next_text = post(mock, headers=auth_headers())
        self.assertEqual(status, 200)
        with self.assertRaises(json.JSONDecodeError):
            json.loads(text)
        self.assertEqual(next_status, 200)
        self.assertEqual(json.loads(next_text)["choices"][0]["message"]["content"], "Answer: A")

    # Guards that recorded requests keep only the body fields and never the Authorization header, even for rejected requests.
    def test_recorded_requests_hold_only_body_fields_and_no_key(self):
        with MockOpenAIServer() as mock:
            post(mock, body=chat_body("first"), headers=auth_headers())
            post(mock)  # no key: still recorded, with no header values
            records = mock.requests
        self.assertEqual(len(records), 2)
        for record in records:
            self.assertEqual(set(record), RECORD_KEYS)
            self.assertNotIn(KEY, json.dumps(record))
        self.assertEqual(records[0]["path"], "/v1/chat/completions")
        self.assertEqual(records[0]["model"], MODEL)
        self.assertEqual(records[0]["messages"], [{"role": "user", "content": "first"}])
        self.assertEqual(records[0]["temperature"], 0)
        self.assertEqual(records[0]["max_tokens"], 16)

    # Guards cleanup: after the with block the socket is closed, so tests cannot leak servers or ports.
    def test_port_is_closed_after_with_block(self):
        with MockOpenAIServer() as mock:
            port = mock.port
            status, _ = post(mock, headers=auth_headers())
            self.assertEqual(status, 200)
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=2)

    # Guards the integration with model_client.TokenFactoryClient: a real SDK call round-trips through the mock,
    # and a queued 429 surfaces as openai.RateLimitError.
    def test_project_client_talks_to_mock(self):
        async def run_once():
            client = TokenFactoryClient(base_url=mock.base_url, api_key=KEY, timeout_seconds=10)
            try:
                return await client.complete(MODEL, [{"role": "user", "content": "Hi"}], 0, 16)
            finally:
                await client.close()

        with loopback_without_proxy(), MockOpenAIServer() as mock:
            reply = asyncio.run(run_once())
            records = mock.requests
        self.assertEqual(reply, "Answer: A")
        self.assertEqual(records[0]["path"], "/v1/chat/completions")
        self.assertEqual(records[0]["model"], MODEL)

    def test_project_client_raises_rate_limit_on_queued_429(self):
        async def run_once():
            client = TokenFactoryClient(base_url=mock.base_url, api_key=KEY, timeout_seconds=10)
            try:
                return await client.complete(MODEL, [{"role": "user", "content": "Hi"}], 0, 16)
            finally:
                await client.close()

        with loopback_without_proxy(), MockOpenAIServer() as mock:
            mock.add_failure(429, count=1)
            with self.assertRaises(openai.RateLimitError):
                asyncio.run(run_once())


if __name__ == "__main__":
    unittest.main()
