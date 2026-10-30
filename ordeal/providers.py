"""The platform registry: which services Ordeal can call, and how to reach a model on each one.

The list of platforms lives in ordeal/data/providers.json, so the Python code and the browser site read the same
facts. This module reads that file and checks every entry. It also turns what a user types (a model
id, a link to a model page, or a name a local server uses) into a route that model_client can call.
Nothing here knows about a particular model, so a new model never needs new code.
"""

import difflib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import openai

from ordeal.model_client import (
    ENV_NAME_PATTERN,
    ModelRoute,
    has_forbidden_url_character,
    is_local_base_url,
    is_safe_custom_url,
)

# The registry sits in the data folder beside this file, so it is found whatever the current folder is.
REGISTRY_PATH = Path(__file__).resolve().parent / "data" / "providers.json"
# The fields every registry entry must have, and no others. An unknown field is refused,
# so a typo such as "base_ur1" cannot be silently ignored.
# kind says what the service is: "inference" for a host of models from many labs, "single-vendor" for one lab's
# own API, "local" for a server on this computer, and "custom" for an address the user gives.
PLATFORM_KINDS = ("inference", "single-vendor", "local", "custom")
PLATFORM_FIELDS = (
    "id", "name", "kind", "summary", "base_url", "key_env", "signup", "web_host", "browser", "local",
)
# A platform id is used inside route names such as "groq/model", so it is kept to simple lowercase text.
PLATFORM_ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]*")
# Only the custom platform may leave its base URL empty, because the user gives that address.
CUSTOM_PLATFORM_ID = "custom"
# Typing "hf:org/name" is a shorthand for "org/name"; the prefix is removed before the id is used.
HF_PREFIX = "hf:"
# Text that starts with one of these is a file path, which is never a model id on a hosted platform.
FILE_PATH_PREFIXES = ("/", "./", "~")
# How many close ids to suggest when a model name is not found, and how close they must be (0 to 1).
SUGGESTION_COUNT = 5
SUGGESTION_CUTOFF = 0.6
# Seconds to wait for a model list before giving up.
FETCH_TIMEOUT_SECONDS = 30
# Local servers ignore the key, but the openai client refuses an empty one, so a fixed placeholder is sent.
LOCAL_KEY_PLACEHOLDER = "not-needed"


@dataclass(frozen=True)
class Platform:
    """One service from the registry. Its key is never stored here; keys.py finds it when needed."""

    id: str  # short name used in route names, such as "groq"
    name: str  # the name shown to people
    kind: str  # one of PLATFORM_KINDS; the browser dropdown shows only "inference" platforms
    summary: str  # one plain sentence about the service, shown in the picker
    base_url: str | None  # the API address; None only for the custom platform
    key_env: str | None  # the environment variable that holds the key; None when no key is needed
    signup: str | None  # where to make a key
    web_host: str | None  # the site that hosts model pages, used to read model links
    browser: bool  # True when the platform has a browser console
    local: bool  # True for a server on this computer, which may use plain http on localhost


def base_url_problem(url: object, local: bool) -> str | None:
    """Return why a base URL is unsafe for a platform, or None when it is safe.

    The rules match model_client: a hosted address must be https with no user name, password or query.
    A local address may also be plain http, but only to 127.0.0.1 or localhost. The message never
    includes the URL itself, in case the URL carries a secret.
    """
    if not isinstance(url, str) or not url:
        return "the base URL is missing"
    if has_forbidden_url_character(url) or "?" in url:
        return "the base URL must have no query string, fragment or control characters"
    if local:
        if is_local_base_url(url):
            return None
        return "a local platform may use http or https only for 127.0.0.1 or localhost"
    if is_safe_custom_url(url):
        return None
    return "a hosted base URL must start with https://, name a host, and have no user name, password or query string"


def check_entry_fields(entry: object, prefix: str) -> None:
    """Raise ValueError if a registry entry is not an object with exactly the expected fields."""
    if not isinstance(entry, dict):
        raise ValueError(f"{prefix} must be an object.")
    missing = [field for field in PLATFORM_FIELDS if field not in entry]
    if missing:
        raise ValueError(f"{prefix} is missing: {', '.join(missing)}.")
    unknown = [field for field in entry if field not in PLATFORM_FIELDS]
    if unknown:
        raise ValueError(f"{prefix} has unknown fields: {', '.join(unknown)}.")


def check_entry_values(entry: dict, prefix: str) -> None:
    """Raise ValueError if the values of one registry entry have the wrong type or an unsafe address."""
    platform_id = entry["id"]
    if not isinstance(platform_id, str) or not PLATFORM_ID_PATTERN.fullmatch(platform_id):
        raise ValueError(f"{prefix}: id must be lowercase letters, digits and dashes.")
    if not isinstance(entry["name"], str) or not entry["name"].strip():
        raise ValueError(f"{prefix}: name must be non-empty text.")
    if entry["kind"] not in PLATFORM_KINDS:
        raise ValueError(f"{prefix}: kind must be one of {', '.join(PLATFORM_KINDS)}.")
    if not isinstance(entry["summary"], str) or not entry["summary"].strip():
        raise ValueError(f"{prefix}: summary must be non-empty text.")
    for flag in ("browser", "local"):
        if not isinstance(entry[flag], bool):
            raise ValueError(f"{prefix}: {flag} must be true or false.")
    for optional in ("signup", "web_host"):
        if entry[optional] is not None and not isinstance(entry[optional], str):
            raise ValueError(f"{prefix}: {optional} must be text or null.")
    check_key_env(entry, prefix)
    check_base_url_field(entry, prefix)


def check_key_env(entry: dict, prefix: str) -> None:
    """Raise ValueError unless key_env is a valid variable name, or null for a local platform."""
    key_env = entry["key_env"]
    if key_env is None and entry["local"]:
        return
    if not isinstance(key_env, str) or not ENV_NAME_PATTERN.fullmatch(key_env):
        raise ValueError(f"{prefix}: key_env must name an environment variable (or be null for a local platform).")


def check_base_url_field(entry: dict, prefix: str) -> None:
    """Raise ValueError unless base_url is safe. Only the custom platform may leave it null."""
    url = entry["base_url"]
    if url is None and entry["id"] == CUSTOM_PLATFORM_ID:
        return
    problem = base_url_problem(url, entry["local"])
    if problem is not None:
        raise ValueError(f"{prefix}: {problem}.")


def platform_from_entry(entry: object, prefix: str) -> Platform:
    """Check one registry entry and return it as a Platform. 'prefix' says which entry it is, for the messages."""
    check_entry_fields(entry, prefix)
    check_entry_values(entry, prefix)
    return Platform(
        id=entry["id"],
        name=entry["name"],
        kind=entry["kind"],
        summary=entry["summary"],
        base_url=entry["base_url"],
        key_env=entry["key_env"],
        signup=entry["signup"],
        web_host=entry["web_host"],
        browser=entry["browser"],
        local=entry["local"],
    )


def load_platforms(path: Path = REGISTRY_PATH) -> list[Platform]:
    """Read and check the registry file, and return its platforms in file order.

    Raises ValueError with a message that names the bad entry, for a bad field or a repeated id.
    Every other part of Ordeal trusts this check, so it runs on every entry, before anything is used.
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    entries = data.get("platforms") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise ValueError(f"{path.name} needs a 'platforms' list.")
    platforms = []
    seen_ids = set()
    for number, entry in enumerate(entries, start=1):
        platform = platform_from_entry(entry, f"{path.name} entry {number}")
        if platform.id in seen_ids:
            raise ValueError(f"{path.name}: platform id '{platform.id}' is used more than once.")
        seen_ids.add(platform.id)
        platforms.append(platform)
    return platforms


def get_platform(platform_id: str) -> Platform:
    """Return the platform with this id. An unknown id raises ValueError that lists the valid ids."""
    platforms = load_platforms()
    for platform in platforms:
        if platform.id == platform_id:
            return platform
    valid_ids = ", ".join(platform.id for platform in platforms)
    raise ValueError(f"Unknown platform '{platform_id}'. Valid platforms: {valid_ids}.")


def looks_like_file_path(text: str) -> bool:
    """Return True for text that starts like a file path or contains a backslash."""
    return text.startswith(FILE_PATH_PREFIXES) or "\\" in text


def model_id_from_link(platform: Platform, link: str) -> str:
    """Return the model id that a link to the platform's model page names.

    Only the path is kept. The scheme, host, query, fragment and trailing slashes are dropped,
    so "https://huggingface.co/org/name/?x=1" becomes "org/name". A link on any other site is refused,
    so the user cannot be sent to a model page on a site the platform does not run.
    """
    if platform.web_host is None:
        raise ValueError(f"{platform.name} has no model web page, so give a model id, not a link.")
    parts = urlsplit(link)
    if (parts.hostname or "") != platform.web_host:
        raise ValueError(f"That link is not on {platform.web_host}. Give a model id, or a link to {platform.web_host}.")
    return parts.path.strip("/")


def parse_model_reference(platform: Platform, text: str) -> str:
    """Turn what the user typed into an API model id for this platform. Raises ValueError if it is not usable.

    Accepted forms: a plain id such as org/name; hf:org/name; a link to the platform's model page;
    an id with a provider suffix such as org/name:provider (kept, because the API needs it).
    A local platform also accepts a plain served name such as llama3.1:8b.
    """
    cleaned = text.strip()
    if not cleaned:
        raise ValueError("Give a model id, such as org/name, or a link to the model page.")
    if cleaned.startswith(("http://", "https://")):
        cleaned = model_id_from_link(platform, cleaned)
    else:
        # A hosted platform never serves a model from a file, so a path is refused with a clear hint.
        if not platform.local and looks_like_file_path(cleaned):
            raise ValueError("That looks like a file path, not a model id. Give a model id such as org/name.")
        if cleaned.startswith(HF_PREFIX):
            cleaned = cleaned[len(HF_PREFIX):].strip()
    if not cleaned:
        raise ValueError("Give a model id, such as org/name, or a link to the model page.")
    if any(char.isspace() for char in cleaned):
        raise ValueError("A model id cannot contain spaces. Check the id on the platform's model page.")
    return cleaned


def find_model(platform: Platform, wanted: str, available: list[str]) -> str:
    """Return the id from 'available' that matches 'wanted'. This is a pure function: it makes no request.

    An exact match wins. Otherwise a single case-insensitive match is returned in the platform's own
    spelling. If nothing matches, the error lists up to five close ids so the user can spot the typo.
    """
    if wanted in available:
        return wanted
    lowered = wanted.lower()
    matches = [model_id for model_id in available if model_id.lower() == lowered]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise ValueError(
            f"'{wanted}' matches more than one model on {platform.name}: {', '.join(matches)}. Give the exact id."
        )
    suggestions = difflib.get_close_matches(wanted, available, n=SUGGESTION_COUNT, cutoff=SUGGESTION_CUTOFF)
    message = f"{platform.name} has no model named '{wanted}'."
    if suggestions:
        message += f" Did you mean: {', '.join(suggestions)}?"
    raise ValueError(message)


def choose_base_url(platform: Platform, base_url_override: str | None) -> str:
    """Return the address a request will go to, and refuse any address that is not safe for this platform.

    A hosted platform always uses its own address. Naming a different one would send its key to another host,
    so that is refused. The custom platform has no fixed address, so the caller must give one.
    """
    if platform.base_url is None:
        if not base_url_override:
            raise ValueError(f"{platform.name} needs a base URL. Give the address of the endpoint.")
        url = base_url_override
    else:
        if base_url_override is not None and base_url_override != platform.base_url:
            raise ValueError(f"{platform.name} always uses its own address, so its key cannot go to another host.")
        url = platform.base_url
    problem = base_url_problem(url, platform.local)
    if problem is not None:
        raise ValueError(f"Base URL refused for {platform.name}: {problem}.")
    return url


def route_for(platform: Platform, model_id: str, base_url_override: str | None = None) -> ModelRoute:
    """Build the ModelRoute for one model on one platform. The route is named platform/model and marked custom.

    The custom flag makes model_client add a digest to the saved replies, so a model on a different
    address never reuses old replies. A local platform gets an empty key_env, because it needs no key.
    """
    if not model_id:
        raise ValueError("A model id is needed to build a route.")
    base_url = choose_base_url(platform, base_url_override)
    # The provider is the platform id, so each saved reply says which platform served it.
    return ModelRoute(
        name=f"{platform.id}/{model_id}",
        api_model=model_id,
        base_url=base_url,
        key_env=platform.key_env or "",
        custom=True,
        provider=platform.id,
    )


def fetch_model_ids(platform: Platform, api_key: str, base_url_override: str | None = None) -> list[str]:
    """Ask the platform for its model list and return the ids, sorted.

    The key is sent only to the platform's own address (see choose_base_url). It is never printed,
    and an error names the variable that holds it, never its value. Tests replace the openai client here.
    """
    base_url = choose_base_url(platform, base_url_override)
    if not api_key and not platform.local:
        raise ValueError(f"No key for {platform.name}. Set {platform.key_env} first.")
    client = openai.OpenAI(
        base_url=base_url,
        api_key=api_key or LOCAL_KEY_PLACEHOLDER,
        max_retries=0,
        timeout=FETCH_TIMEOUT_SECONDS,
    )
    response = client.models.list()
    return sorted(model.id for model in response.data)
