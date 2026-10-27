"""Local mock of the OpenAI-compatible chat completions endpoint, for tests only.

The server binds to 127.0.0.1 on a free port and serves POST {base_url}/chat/completions.
It never makes outbound calls, writes nothing to disk and prints nothing.

Recorded requests keep only the request path and the body fields
(model, messages, temperature, max_tokens). Headers are never recorded, so the
API key cannot leak through the recorded list.

Usage:
    with MockOpenAIServer() as mock:
        client = TokenFactoryClient(base_url=mock.base_url, api_key="test-key-123", timeout_seconds=10)
"""

import collections
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Bearer key the mock accepts unless a test passes a different api_key.
DEFAULT_KEY = "test-key-123"
CHAT_SUFFIX = "/chat/completions"
INVALID_JSON = "invalid_json"
# OpenAI-style error type strings by status code. Any other status is reported as api_error.
ERROR_TYPES = {401: "authentication_error", 429: "rate_limit_error", 500: "server_error"}
# The only request body fields that are recorded. Keeping this list short is what stops the key leaking.
RECORDED_FIELDS = ("model", "messages", "temperature", "max_tokens")


def default_responder(request_json):
    """Return the fixed reply used when no responder is given."""
    return "Answer: A"


def _rough_tokens(value):
    """Count whitespace-separated words in a string or in a list of messages. Used only for usage numbers."""
    if isinstance(value, str):
        return len(value.split())
    if isinstance(value, list):
        total = 0
        for message in value:
            if isinstance(message, dict):
                total += _rough_tokens(str(message.get("content", "")))
        return total
    return 0


def _error_body(status, message):
    """Build an OpenAI-style error body."""
    error = {"message": message, "type": ERROR_TYPES.get(status, "api_error"), "code": None}
    return json.dumps({"error": error}).encode("utf-8")


class _Server(ThreadingHTTPServer):
    """Threaded HTTP server that hands each request to its owning MockOpenAIServer."""

    daemon_threads = True

    def __init__(self, owner):
        self.owner = owner
        # Port 0 asks the OS for a free port, so parallel test runs never collide.
        super().__init__(("127.0.0.1", 0), _Handler)


class _Handler(BaseHTTPRequestHandler):
    """Serves the chat endpoint. Logging is silenced."""

    def log_message(self, format, *args):
        """Silence the default request logging."""
        return

    def do_POST(self):
        """Record the request, then check the path, the key, injected failures and the body."""
        # Every request is recorded first, even ones that are then rejected, so tests can assert on what was sent.
        owner = self.server.owner
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        # A body that is not valid JSON is recorded with all fields as None and rejected further down.
        try:
            body = json.loads(raw)
        except ValueError:
            body = None
        fields = {}
        for name in RECORDED_FIELDS:
            fields[name] = body.get(name) if isinstance(body, dict) else None
        owner._record({"path": self.path, **fields})

        # Checks run in this order: path (404), API key (401), queued failure, body shape (400), responder.
        # A queued failure is only used up by a request that passed the path and key checks.
        if self.path != owner.chat_path:
            self._send(404, _error_body(404, "Unknown path."))
            return
        if self.headers.get("Authorization") != f"Bearer {owner.api_key}":
            self._send(401, _error_body(401, "Incorrect API key provided."))
            return
        injected = owner._take_injected()
        if injected == INVALID_JSON:
            self._send(200, b"{this is not valid json")
            return
        if injected is not None:
            self._send(injected, _error_body(injected, "Injected failure."), owner.error_headers)
            return
        if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
            self._send(400, _error_body(400, "Request body must be JSON with a messages list."))
            return
        try:
            text = owner.responder(body)
        except Exception as error:  # the responder is test code; report its failure as a 500
            self._send(500, _error_body(500, f"Responder failed: {type(error).__name__}"))
            return
        completion = owner._completion(body, text)
        self._send(200, json.dumps(completion).encode("utf-8"), owner.reply_headers)

    def _send(self, status, payload, extra_headers=None):
        """Send a JSON body with its length, plus any extra headers the test asked for (such as rate-limit headers)."""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(payload)


class MockOpenAIServer:
    """A local OpenAI-compatible chat endpoint for tests. Use it as a context manager."""

    def __init__(self, responder=None, api_key=DEFAULT_KEY, reply_headers=None, error_headers=None):
        self.responder = responder or default_responder
        self.api_key = api_key
        # Extra headers sent with every successful reply, e.g. rate-limit headers. Empty by default.
        self.reply_headers = dict(reply_headers or {})
        # Extra headers sent with every injected failure, e.g. retry-after on a 429. Empty by default.
        self.error_headers = dict(error_headers or {})
        self.base_url = None
        self.port = None
        self.chat_path = None
        self._records = []
        self._injected = collections.deque()  # entries are [kind, remaining]; kind is a status code or INVALID_JSON
        self._completion_count = 0
        self._lock = threading.Lock()
        self._server = None
        self._thread = None

    def __enter__(self):
        """Start the server on 127.0.0.1 with a free port, in a background thread."""
        self._server = _Server(self)
        self.port = self._server.server_address[1]
        self.base_url = f"http://127.0.0.1:{self.port}/v1"
        self.chat_path = "/v1" + CHAT_SUFFIX
        self._thread = threading.Thread(target=self._server.serve_forever, name="mock-openai", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc, traceback):
        """Stop the server and close the socket so the port is free again."""
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)
        return False

    @property
    def requests(self):
        """A copy of the recorded requests, oldest first. Each has path, model, messages, temperature, max_tokens."""
        with self._lock:
            return list(self._records)

    def add_failure(self, status_code, count=1):
        """Queue `count` replies with `status_code` and a JSON error body. Queue entries are served in order."""
        if count < 1:
            raise ValueError("count must be at least 1")
        with self._lock:
            self._injected.append([status_code, count])

    def add_invalid_json(self, count=1):
        """Queue `count` replies whose body is not valid JSON (status 200)."""
        if count < 1:
            raise ValueError("count must be at least 1")
        with self._lock:
            self._injected.append([INVALID_JSON, count])

    def clear_failures(self):
        """Remove every queued failure."""
        with self._lock:
            self._injected.clear()

    # Append one record. The lock is needed because the server handles each request in its own thread.
    def _record(self, record):
        with self._lock:
            self._records.append(record)

    def _take_injected(self):
        """Return the next queued failure kind, using up one of its count, or None when the queue is empty."""
        with self._lock:
            if not self._injected:
                return None
            head = self._injected[0]
            kind = head[0]
            head[1] -= 1
            if head[1] <= 0:
                self._injected.popleft()
            return kind

    def _completion(self, body, text):
        """Build an OpenAI chat completion object for the reply text."""
        with self._lock:
            self._completion_count += 1
            number = self._completion_count
        prompt_tokens = _rough_tokens(body.get("messages"))
        completion_tokens = _rough_tokens(text)
        return {
            "id": f"chatcmpl-mock-{number}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": body.get("model"),
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": text},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
        }
