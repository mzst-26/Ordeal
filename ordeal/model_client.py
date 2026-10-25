"""Async clients for OpenAI-compatible chat APIs, built on the openai library.

The runner sends every chat request through a ModelRouter, which gives each model its own
endpoint and key. The helper functions decide which errors are worth a retry, how an error
is shown, and which custom models and test base URLs are allowed.
"""

import hashlib
import os
import re
from dataclasses import dataclass, field, replace
from typing import Any
from urllib.parse import urlsplit

import openai

from ordeal import core

# Errors that can pass on a later try. Other errors (bad request, bad key, missing model) would fail again.
RETRYABLE_ERROR_TYPES = (
    openai.RateLimitError,
    openai.APITimeoutError,
    openai.APIConnectionError,
    openai.InternalServerError,
)
# Error text is cut to this length so a long server message cannot flood the output.
MAX_ERROR_TEXT_LENGTH = 200
# Number of hex characters of the digest added to a custom model's saved name (see record_label).
LABEL_DIGEST_LENGTH = 8
# Hosts allowed for a plain-http test server (see is_local_base_url).
LOCAL_HOSTS = ("127.0.0.1", "localhost")
# A valid environment variable name, matched in full.
ENV_NAME_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
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
    # Empty until attach_keys fills it in. repr=False keeps the key out of printed routes and logs.
    api_key: str = field(default="", repr=False)


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
        response = await self.client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        # The message content can be None; callers expect a string, so it becomes "".
        content = response.choices[0].message.content
        if content is None:
            return ""
        return content

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
        route = self.routes[model]
        return await self.clients[model].complete(route.api_model, messages, temperature, max_tokens)

    async def close(self) -> None:
        """Close the connections of every client."""
        for client in self.clients.values():
            await client.close()


def is_retryable(error: Exception) -> bool:
    """Return True for errors that may pass on a second try: rate limit, timeout, connection or server error."""
    return isinstance(error, RETRYABLE_ERROR_TYPES)


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
        name=name, api_model=entry["model"], base_url=entry["base_url"], key_env=key_env, custom=True
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
            route = ModelRoute(name=name, api_model=name, base_url=config["base_url"], key_env=core.TOKEN_ENV_VAR)
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
