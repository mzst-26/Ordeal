"""Async clients for OpenAI-compatible chat APIs, built on the openai library.

The runner sends every chat request through a ModelRouter, which gives each model its own
endpoint and key. The helper functions decide which errors are worth a retry, how an error
is shown, and which custom models and test base URLs are allowed.
"""

import hashlib
import math
import os
import re
from dataclasses import dataclass, field, replace
from typing import Any
from urllib.parse import urlsplit

import openai

from ordeal import core
from ordeal import limiter

# Errors that can pass on a later try. Other errors (bad request, bad key, missing model) would fail again.
RETRYABLE_ERROR_TYPES = (
    openai.RateLimitError,
    openai.APITimeoutError,
    openai.APIConnectionError,
    openai.InternalServerError,
)
# The finish_reason the provider sends when max_tokens stopped the reply before it was finished.
FINISH_REASON_LENGTH = "length"
# Control tokens such as <|channel|> that some models write instead of an answer, and the role word after <|start|>.
CONTROL_TOKEN = re.compile(r"<\|[^|>]*\|>")
LEFTOVER_ROLE_WORD = re.compile(r"^\s*assistant\s*", re.IGNORECASE)
# Error text is cut to this length so a long server message cannot flood the output.
MAX_ERROR_TEXT_LENGTH = 200
# Number of hex characters of the digest added to a custom model's saved name (see record_label).
LABEL_DIGEST_LENGTH = 8
# Hosts allowed for a plain-http test server (see is_local_base_url).
LOCAL_HOSTS = ("127.0.0.1", "localhost")
# A valid environment variable name, matched in full.
ENV_NAME_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# The provider names for models that do not come from the platform list. The built-in models in config.json
# use one fixed endpoint that is not a platform in providers.json, and a custom model has its own address.
CONFIG_PROVIDER = "config"
CUSTOM_PROVIDER = "custom"
# Every custom_models entry in config.json must have all of these as non-blank text.
CUSTOM_MODEL_FIELDS = ("name", "base_url", "model", "api_key_env")
CUSTOM_URL_MESSAGE = (
    "Custom model '{name}' needs a base_url that starts with https://, "
    "with no user name or password and no query string."
)


@dataclass(frozen=True)
class ModelRoute:
    """Where one model is called. 'name' labels it in the cache and output; the key is never shown."""

    name: str
    api_model: str  # the model id sent to the API
    base_url: str
    key_env: str  # the environment variable that holds the key
    custom: bool = False  # True for a config.json custom model; its saved replies get a digest label
    # The provider the saved replies name: a platform id, or CONFIG_PROVIDER or CUSTOM_PROVIDER below.
    provider: str = ""
    # Empty until attach_keys fills it in. repr=False keeps the key out of printed routes and logs.
    api_key: str = field(default="", repr=False)


@dataclass(frozen=True)
class Reply:
    """One model reply, with what the pacer needs to learn the provider's limits from it.

    'headers' are the HTTP headers of the reply, with lower-case names, because the rate-limit headers are
    only sent there. The usage counts come from the reply body and are None when the provider leaves them out.
    'finish_reason' is why the provider stopped, such as "stop". It is saved with each reply so the record shows it.
    """

    text: str
    headers: dict[str, str]
    prompt_tokens: int | None
    completion_tokens: int | None
    finish_reason: str | None = None


class TruncatedReply(Exception):
    """Raised when max_tokens cut the reply short (finish_reason "length").

    A cut-off answer is not a real answer, so the runner must record it as a failure and never save it.
    It is not retryable either: the same request with the same max_tokens would be cut off the same way.
    """


class EmptyReply(Exception):
    """Raised when the reply has no words in it: no content, only spaces, or only control tokens.

    Some models write only their own control tokens, such as <|start|>assistant<|channel|>, instead of an answer. That
    is not an answer, so the runner must record it as a failure and never save it. It is not retryable, because the same
    request would give the same empty reply and the retry would use up the call cap.
    """


class TokenFactoryClient:
    """Sends chat requests to one OpenAI-compatible endpoint."""

    def __init__(self, base_url: str, api_key: str, timeout_seconds: float) -> None:
        """Create the underlying client. Retries are off because the runner does its own."""
        self.client = openai.AsyncOpenAI(
            base_url=base_url,
            api_key=api_key,
            timeout=timeout_seconds,
            max_retries=0,
        )

    async def complete(self, model: str, messages: list[dict], temperature: float, max_tokens: int) -> str:
        """Send the messages and return the reply text, or "" if the reply has no content."""
        reply = await self.complete_detailed(model, messages, temperature, max_tokens)
        return reply.text

    async def complete_detailed(self, model: str, messages: list[dict], temperature: float, max_tokens: int) -> Reply:
        """Send the messages and return the reply with its headers and usage, for the pacer.

        The raw-response form is used because the headers are only on the HTTP response. The body is then parsed
        as usual, so the text and the usage come from the same object as before.

        Raises TruncatedReply when max_tokens cut the reply short, because that text is not a finished answer.
        """
        raw = await self.client.chat.completions.with_raw_response.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        response = raw.parse()
        # Checked before anything else is read, so a cut-off reply is never returned as if it were complete.
        finish_reason = reply_finish_reason(response)
        if finish_reason == FINISH_REASON_LENGTH:
            raise TruncatedReply(f"The reply was cut off at max_tokens={max_tokens}, so it is not a full answer.")
        text = reply_text(response)
        if not has_words(text):
            raise EmptyReply("The reply had no text.")
        prompt_tokens, completion_tokens = usage_counts(response)
        return Reply(
            text=text,
            headers=lower_case_headers(raw.headers),
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            finish_reason=finish_reason,
        )

    async def close(self) -> None:
        """Close the underlying HTTP connections."""
        await self.client.close()


class ModelRouter:
    """Sends each model's requests to its own endpoint, with its own key. Callers name the model, not the API id."""

    def __init__(self, routes: dict[str, ModelRoute], timeout_seconds: float) -> None:
        """Create one client per model, each with that model's base URL and key."""
        self.routes = routes
        self.clients = {
            name: TokenFactoryClient(route.base_url, route.api_key, timeout_seconds) for name, route in routes.items()
        }

    async def complete(self, model: str, messages: list[dict], temperature: float, max_tokens: int) -> str:
        """Send the messages to the endpoint of the named model and return the reply text."""
        reply = await self.complete_detailed(model, messages, temperature, max_tokens)
        return reply.text

    async def complete_detailed(self, model: str, messages: list[dict], temperature: float, max_tokens: int) -> Reply:
        """Send the messages to the endpoint of the named model and return the reply with its headers and usage."""
        route = self.routes[model]
        return await self.clients[model].complete_detailed(route.api_model, messages, temperature, max_tokens)

    async def close(self) -> None:
        """Close the connections of every client."""
        for client in self.clients.values():
            await client.close()


def lower_case_headers(headers: Any) -> dict[str, str]:
    """Return the headers as a plain dict with lower-case names, so one name is always spelled the same way.

    HTTP header names are not case-sensitive, but a plain dict is. Lower-casing here lets callers look up
    'x-ratelimit-limit-requests' without worrying how the provider capitalised it.
    """
    return {str(name).lower(): str(value) for name, value in headers.items()}


def reply_text(response: Any) -> str:
    """Return the text of the first choice. The provider can send no content, which becomes "" so callers get a string."""
    content = response.choices[0].message.content
    if content is None:
        return ""
    return content


def has_words(text: str) -> bool:
    """Return True when a reply has words in it, not only spaces, control tokens or a leftover role word.

    The control tokens are removed first, then the role word a model writes after <|start|> (such as "assistant"),
    because the browser batch treats the same text the same way.
    """
    without_tokens = CONTROL_TOKEN.sub("", text)
    return LEFTOVER_ROLE_WORD.sub("", without_tokens).strip() != ""


def reply_finish_reason(response: Any) -> str | None:
    """Return why the provider stopped the first choice, such as "stop" or "length". None if it did not say."""
    return response.choices[0].finish_reason


def usage_counts(response: Any) -> tuple[int | None, int | None]:
    """Return (prompt tokens, completion tokens) from the reply body. Both are None when the body has no usage block."""
    usage = getattr(response, "usage", None)
    if usage is None:
        return None, None
    return usage.prompt_tokens, usage.completion_tokens


def is_retryable(error: Exception) -> bool:
    """Return True for errors that may pass on a second try: rate limit, timeout, connection or server error."""
    return isinstance(error, RETRYABLE_ERROR_TYPES)


def is_rate_limit(error: Exception) -> bool:
    """Return True only for a rate-limit (429) error. The runner parks a model for these and no other error."""
    return isinstance(error, openai.RateLimitError)


def retry_after_seconds(error: Exception) -> float | None:
    """Return how many seconds the provider asked us to wait after this error, or None if it did not say.

    The retry-after header is checked first, because it is the plain instruction. Without it, the reset time
    of the request limit is used. An error with no HTTP response (a timeout, say) has no headers, so gives None.
    """
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    seconds = retry_after_header_seconds(headers)
    if seconds is not None:
        return seconds
    return limiter.parse_rate_headers(headers).get("reset_requests_seconds")


def retry_after_header_seconds(headers: Any) -> float | None:
    """Return the retry-after header as seconds, or None if it is missing or is not a count of seconds.

    Only the seconds form is read. The date form is rare, and a missing value falls back to the reset header.
    """
    for name, value in headers.items():
        if str(name).lower() != "retry-after":
            continue
        try:
            seconds = float(value)
        except ValueError:
            return None
        # A negative or infinite wait makes no sense, and would park the model forever, so it counts as no wait time.
        return seconds if math.isfinite(seconds) and seconds >= 0 else None
    return None


def describe_error(error: Exception) -> str:
    """Return 'ClassName: message', cut to 200 characters. Request headers and the key are never included."""
    text = f"{type(error).__name__}: {error}"
    return text[:MAX_ERROR_TEXT_LENGTH]


def is_local_base_url(url: str) -> bool:
    """Return True for an http or https URL to 127.0.0.1 or localhost, with no user name or password."""
    # urlsplit and .hostname can raise ValueError on malformed input such as a bad port or bracket.
    try:
        parts = urlsplit(url)
        host = parts.hostname
    except ValueError:
        return False
    # "@" in the network part would mean user:password@host, which could carry a secret in the config.
    return parts.scheme in ("http", "https") and host in LOCAL_HOSTS and "@" not in parts.netloc


def has_forbidden_url_character(url: str) -> bool:
    """Return True if the URL contains a '#' or a control character (code below 32, or 127), anywhere."""
    return "#" in url or any(ord(char) < 32 or ord(char) == 127 for char in url)


def is_safe_custom_url(url: Any) -> bool:
    """Return True for an https URL with a host, no user name or password, no query, fragment or control character."""
    if not isinstance(url, str) or not url.startswith("https://") or has_forbidden_url_character(url):
        return False
    # Custom models send a real API key, so only https is accepted here (plain http is for local tests only).
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    return bool(parts.hostname) and "@" not in parts.netloc and "?" not in url


def custom_route(entry: Any) -> ModelRoute:
    """Check one entry of config.json's custom_models and return its route. Raises ValueError with a fixed message."""
    if not isinstance(entry, dict):
        raise ValueError("Each custom model in config.json must be an object.")
    blank = [key for key in CUSTOM_MODEL_FIELDS if not isinstance(entry.get(key), str) or not entry[key].strip()]
    if blank:
        raise ValueError(f"A custom model in config.json needs these text fields: {', '.join(blank)}.")
    name = entry["name"]
    if not is_safe_custom_url(entry["base_url"]):
        raise ValueError(CUSTOM_URL_MESSAGE.format(name=name))
    # A custom model must not reuse the built-in key, or that key would be sent to a third-party endpoint.
    key_env = entry["api_key_env"]
    # Every platform's variable is off limits too, so a custom model cannot send another platform's key to its own URL.
    # providers imports this module, so it is imported here, when the check runs, to avoid a circular import.
    from ordeal import providers

    platform_key_names = {platform.key_env for platform in providers.load_platforms() if platform.key_env}
    if not ENV_NAME_PATTERN.fullmatch(key_env) or key_env in platform_key_names:
        raise ValueError(
            f"Custom model '{name}' needs api_key_env to name a variable that no platform uses, such as MY_MODEL_KEY."
        )
    return ModelRoute(
        name=name, api_model=entry["model"], base_url=entry["base_url"], key_env=key_env, custom=True,
        provider=CUSTOM_PROVIDER,
    )


def load_custom_models(config: dict[str, Any]) -> list[ModelRoute]:
    """Return the routes of config.json's custom models. Raises ValueError for a bad entry or a repeated name."""
    routes = []
    taken = set(config["models"])
    for entry in config.get("custom_models", []):
        route = custom_route(entry)
        if route.name in taken:
            raise ValueError(f"Custom model name '{route.name}' is already used by another model.")
        taken.add(route.name)
        routes.append(route)
    return routes


def build_routes(
    models: list[str], config: dict[str, Any], custom_routes: list[ModelRoute], base_url_override: str | None
) -> dict[str, ModelRoute]:
    """Return one route per model name. A custom name uses its own entry; any other name is a built-in model.

    'base_url_override' (the test-only --base-url) replaces the endpoint of every model.
    """
    custom_by_name = {route.name: route for route in custom_routes}
    routes = {}
    for name in models:
        route = custom_by_name.get(name)
        if route is None:
            route = ModelRoute(
                name=name, api_model=name, base_url=config["base_url"], key_env=core.TOKEN_ENV_VAR,
                provider=CONFIG_PROVIDER,
            )
        if base_url_override is not None:
            route = replace(route, base_url=base_url_override)
        routes[name] = route
    return routes


def record_label(route: ModelRoute) -> str:
    """Return the model name saved with each reply. A built-in model keeps its name; a custom one adds a digest."""
    if not route.custom:
        return route.name
    # The digest covers the endpoint and API model id, so pointing the same name somewhere else
    # gives a different label and old saved replies are not reused for it.
    text = f"{route.base_url}\n{route.api_model}"
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:LABEL_DIGEST_LENGTH]
    return f"{route.name}@{digest}"


def record_providers(
    models: list[str], config: dict[str, Any], custom_routes: list[ModelRoute], base_url_override: str | None
) -> dict[str, str]:
    """Return {model name: provider} for the models of one run, the same way record_labels gives labels.

    The provider is written into each saved reply, so grading can tell which platform a model was served by.
    """
    routes = build_routes(models, config, custom_routes, base_url_override)
    return {name: route.provider for name, route in routes.items()}


def record_labels(
    models: list[str], config: dict[str, Any], custom_routes: list[ModelRoute], base_url_override: str | None
) -> dict[str, str]:
    """Return {model name: saved label} for the models of one run. It reads no keys, so the dry run can use it."""
    routes = build_routes(models, config, custom_routes, base_url_override)
    return {name: record_label(route) for name, route in routes.items()}


def read_route_key(route: ModelRoute) -> str:
    """Return the key for one route. The error names the variable, never its value."""
    # The built-in key has its own reader, which also loads the .env file and raises its own error.
    if route.key_env == core.TOKEN_ENV_VAR:
        return core.read_api_key()
    core.load_env_file()
    value = os.environ.get(route.key_env, "")
    if not value:
        raise RuntimeError(
            f"Missing {route.key_env}, the API key for model '{route.name}'. Add it to the .env file or export it."
        )
    return value


def attach_keys(routes: dict[str, ModelRoute]) -> dict[str, ModelRoute]:
    """Return the routes with their keys read from the environment. Raises RuntimeError if one is missing."""
    return {name: replace(route, api_key=read_route_key(route)) for name, route in routes.items()}
