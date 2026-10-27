"""Refresh the rate-limit table in ordeal/data/rate_limits.json from the headers the provider sends on each reply.

A maintainer runs this script by hand. For every model in the table, it sends one tiny chat call and reads the
rate-limit headers on the reply. This file holds the pure part: how one model's table entry is merged with what
one reply said. The network part is added later in this file.
"""

# The status words a model can get. They match the words scripts/refresh_catalog.py uses.
STATUS_REFRESHED = "refreshed"
STATUS_NEEDS_KEY = "needs a key"

# Each limit the merge needs: the field parse_rate_headers fills, the table field it sets, and the header's name.
# The header name is only used in the messages, so a maintainer can find the header that was missing.
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
