"""Refresh the rate-limit table in ordeal/data/rate_limits.json from the headers the provider sends on each reply.

A maintainer runs this script by hand. For every model in the table, it sends one tiny chat call and reads
the rate-limit headers on the reply. It makes one request per model and does not retry (about 30 calls).

Why this exists: the table was copied from the provider's console, and the console table can drift. A limit
can change on the provider's side and the copy then stops being true. The headers on a reply show the limits
the provider actually enforces on that call, so they are the more trusted source. The table is only the
fallback for models that have not been seen yet (ordeal/limiter.py writes down the order it uses).

Each model gets one status:
  refreshed     the reply had both limit headers, and the table now holds their numbers
  needs a key   no key is set for the platform, so no call was made
  failed: ...   the call or the reply gave no usable limits. The old values are kept and the reason says why.
If no model was refreshed, the file is left alone. The new file is written to a temporary file first and then
moved into place, so a crash cannot leave half a file behind.

The key is read through keys.get_key, which never prints it, and it is sent only to the platform's own base
URL. The failure reasons are built from status codes and exception names, never from the error text, so
they cannot carry the key or a URL.
"""

import datetime
import json
import os
import sys
import tempfile
from pathlib import Path

import openai

PROJECT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_DIR))

from ordeal import keys, limiter, providers  # noqa: E402  (needs the project folder on sys.path first)

# The table this script refreshes. ordeal/limiter.py reads the same file.
OUTPUT_PATH = PROJECT_DIR / "ordeal" / "data" / "rate_limits.json"
# The tiny call sent to each model. Five tokens is enough for one word, so each call costs almost nothing.
PROMPT = "Reply with the word ok."
MAX_TOKENS = 5
# HTTP answers that mean the provider did not accept the key that was sent.
KEY_REFUSED_CODES = (401, 403)

# The status words a model can get. They match the words scripts/refresh_catalog.py uses.
STATUS_REFRESHED = "refreshed"
STATUS_NEEDS_KEY = "needs a key"

# Each limit the merge needs: the field parse_rate_headers fills, the table field it sets, and the header's name.
# The header name is only used in messages, so a maintainer can see which header was missing.
LIMIT_FIELDS = (
    ("limit_requests", "requests_per_minute", "x-ratelimit-limit-requests"),
    ("limit_tokens", "tokens_per_minute", "x-ratelimit-limit-tokens"),
)


def limit_problem(parsed: dict) -> str | None:
    """Return why the reply's limits cannot be used, or None when both are present and above zero.

    A limit of zero is refused too. A real model never has a limit of zero, so a zero means the reply was
    odd, and writing it would stop the pacer from calling that model at all.
    """
    for parsed_field, _table_field, header in LIMIT_FIELDS:
        if parsed_field not in parsed:
            return f"the reply had no {header} header"
        if parsed[parsed_field] <= 0:
            return f"the reply's {header} was zero"
    return None


def merge_model_limits(entry: dict, parsed: dict, failure: str | None = None) -> tuple[dict, str]:
    """Return (new entry, status) for one model. The entry that is passed in is never changed.

    failure: the short reason the call failed, or None when a reply came back.
    parsed: the fields that parse_rate_headers found in that reply. It is ignored when there was a failure.

    The reply's limits are used only when both are present and above zero. Otherwise the old values stay,
    and the status says why, so the table never takes a guess from a reply that was incomplete.
    """
    new_entry = dict(entry)
    if failure is not None:
        return new_entry, f"failed: {failure}"
    problem = limit_problem(parsed)
    if problem is not None:
        return new_entry, f"failed: {problem}"
    for parsed_field, table_field, _header in LIMIT_FIELDS:
        new_entry[table_field] = parsed[parsed_field]
    # Marks that these numbers came from the provider's reply, not from the console table.
    new_entry["source"] = "headers"
    return new_entry, STATUS_REFRESHED


def read_key(platform: providers.Platform) -> str:
    """Return the platform's key, or "" when none is set. Never prints the key."""
    try:
        return keys.get_key(platform)
    except RuntimeError:
        # keys.get_key raises when no key exists. Here that is a status ("needs a key"), not a crash.
        return ""


def make_client(platform: providers.Platform, key: str) -> openai.OpenAI:
    """Return an openai client for the platform's own base URL.

    Retries are off because this script makes one call per model and reports any failure instead.
    """
    return openai.OpenAI(
        base_url=platform.base_url,
        api_key=key,
        timeout=providers.FETCH_TIMEOUT_SECONDS,
        max_retries=0,
    )


def ask_model(client: openai.OpenAI, model: str) -> tuple[dict, str | None]:
    """Send one tiny chat call to the model. Return (parsed rate headers, None), or ({}, reason) on failure.

    with_raw_response gives the HTTP headers next to the parsed reply. The reply text itself is not needed.
    Errors become a short reason built from the status code or the exception's class name only.
    """
    try:
        raw = client.chat.completions.with_raw_response.create(
            model=model,
            messages=[{"role": "user", "content": PROMPT}],
            max_tokens=MAX_TOKENS,
        )
    except openai.APIStatusError as error:
        if error.status_code in KEY_REFUSED_CODES:
            return {}, f"the server refused the key ({error.status_code})"
        return {}, f"the server answered {error.status_code}"
    except openai.OpenAIError as error:
        return {}, f"could not get a reply ({error.__class__.__name__})"
    return limiter.parse_rate_headers(raw.headers), None


def check_model(client: openai.OpenAI | None, model: str, old_entry: dict) -> tuple[dict, str]:
    """Return (new entry, status) for one model. With no client (no key), nothing is called and the entry is kept."""
    if client is None:
        return dict(old_entry), STATUS_NEEDS_KEY
    parsed, failure = ask_model(client, model)
    return merge_model_limits(old_entry, parsed, failure)


def print_line(model: str, status: str, old_entry: dict, new_entry: dict) -> None:
    """Print one line: the model, its status, and its requests and tokens per minute, before and after."""
    print(
        f"{model:<40} {status}; "
        f"requests/min {old_entry['requests_per_minute']} -> {new_entry['requests_per_minute']}, "
        f"tokens/min {old_entry['tokens_per_minute']} -> {new_entry['tokens_per_minute']}"
    )


def write_atomically(table: dict, path: Path) -> None:
    """Write the table to a temporary file in the same folder, then move it over the old file.

    The temporary file is in the same folder so os.replace is a single step on one disk. If the write
    fails, the temporary file is removed and the old file stays as it was.
    """
    file_descriptor, temporary_name = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as file:
            json.dump(table, file, indent=2, ensure_ascii=False)
            file.write("\n")
        os.replace(temporary_name, path)
    except BaseException:
        os.unlink(temporary_name)
        raise


def main() -> int:
    """Check every model in the table, print one line each, and write the table if any model refreshed."""
    table = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
    platform = providers.get_platform(table["platform"])
    key = read_key(platform)
    client = make_client(platform, key) if key else None
    new_models = {}
    refreshed_count = 0
    for model, old_entry in table["models"].items():
        new_entry, status = check_model(client, model, old_entry)
        new_models[model] = new_entry
        if status == STATUS_REFRESHED:
            refreshed_count += 1
        print_line(model, status, old_entry, new_entry)
    if refreshed_count == 0:
        print("No model was refreshed, so rate_limits.json was not changed.")
        return 0
    new_table = dict(table, checked=datetime.date.today().isoformat(), models=new_models)
    write_atomically(new_table, OUTPUT_PATH)
    print(f"Wrote {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
