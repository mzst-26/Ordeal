"""Refresh ordeal/data/models.json: the text-writing models each hosted inference platform serves.

A maintainer runs this script by hand. For every platform whose kind is "inference", it reads the key
(through keys.get_key, which never prints it), asks the platform for its model list, and keeps only the
models that write text (see ordeal/catalog.py). It makes one request per platform and does not retry.

Each platform gets one status:
  refreshed     the list was read this run
  needs a key   the platform refused the request and no key was given
  failed: ...   anything else. The previous list is kept, and the status says so.
If no platform was refreshed, the file is left alone. The new file is written to a temporary file
first and then moved into place, so a crash cannot leave half a file behind.

This script never writes to the site folder. The site copy is made by a separate step.
"""

import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_DIR))

from ordeal import catalog, keys, providers  # noqa: E402  (needs the project folder on sys.path first)

# The file the site and the Python code read. It sits in the data folder, next to providers.json.
OUTPUT_PATH = PROJECT_DIR / "ordeal" / "data" / "models.json"
# HTTP answers that mean "you did not send a valid key". Without a key these mean the platform needs one.
AUTH_REFUSED_CODES = (401, 403)


def read_key(platform: providers.Platform) -> str:
    """Return the platform's key, or "" when none is set. Never prints the key."""
    try:
        return keys.get_key(platform)
    except RuntimeError:
        # keys.get_key raises when no key exists. That is not an error here: the call is tried without one.
        return ""


def read_previous_catalogue(path: Path) -> dict:
    """Return the catalogue saved by the last run, or {} when there is none or it cannot be read."""
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        print(f"{path.name} could not be read, so no earlier lists are kept.")
        return {}


def fetch_listing(platform: providers.Platform, key: str):
    """Ask the platform for its model list with one request, and return the parsed reply.

    The key goes in the Authorization header, and only when one was given. Errors from urllib are
    raised to the caller, so the caller can tell a refused key from a failed connection.
    """
    # Some platforms sit behind a CDN that refuses urllib's default User-Agent with a 403, so a plain name is sent.
    headers = {"Accept": "application/json", "User-Agent": "ordeal-catalog-refresh/1.0"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    request = urllib.request.Request(platform.base_url + "/models", headers=headers)
    with urllib.request.urlopen(request, timeout=providers.FETCH_TIMEOUT_SECONDS) as reply:
        return json.loads(reply.read().decode("utf-8"))


def failed(reason: str) -> dict:
    """Return the result for a call that did not give a usable list."""
    return {"status": f"failed: {reason}", "ids": [], "skipped": 0}


def fetch_platform(platform: providers.Platform, key: str) -> dict:
    """Return {"status", "ids", "skipped"} for one platform. This function never raises."""
    try:
        listing = fetch_listing(platform, key)
    except urllib.error.HTTPError as error:
        if error.code in AUTH_REFUSED_CODES and not key:
            return {"status": catalog.STATUS_NEEDS_KEY, "ids": [], "skipped": 0}
        return failed(f"the server answered {error.code}")
    except OSError as error:
        # URLError and timeouts are both OSError. The reason text never contains the key.
        return failed(f"could not reach the server ({error.__class__.__name__})")
    except ValueError:
        return failed("the reply was not JSON")
    if catalog.listing_entries(listing) is None:
        return failed("the reply had no model list")
    ids, skipped = catalog.catalogue_ids(listing)
    return {"status": catalog.STATUS_REFRESHED, "ids": ids, "skipped": skipped}


def should_write(platform_results: dict) -> bool:
    """Return True when the file should be rewritten. A run where every call failed changes nothing."""
    return catalog.any_refreshed(platform_results)


def write_atomically(catalogue: dict, path: Path) -> None:
    """Write the catalogue to a temporary file in the same folder, then move it over the old file.

    The temporary file is in the same folder so os.replace is a single step on one disk. If the write
    fails, the temporary file is removed and the old file stays as it was.
    """
    file_descriptor, temporary_name = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as file:
            json.dump(catalogue, file, indent=2, ensure_ascii=False)
            file.write("\n")
        os.replace(temporary_name, path)
    except BaseException:
        os.unlink(temporary_name)
        raise


def print_line(platform_id: str, result: dict) -> None:
    """Print one line for a platform: its id, its status and its count, plus any bad entries skipped."""
    count = len(result["ids"])
    line = f"{platform_id:<14} {result['status']}  {count} text models"
    if result.get("skipped"):
        line += f" ({result['skipped']} bad entries skipped)"
    print(line)


def main() -> int:
    """Refresh every inference platform, print one line each, and write the file if anything refreshed."""
    previous = read_previous_catalogue(OUTPUT_PATH)
    platform_results = {}
    for platform in providers.load_platforms():
        if platform.kind != "inference":
            continue
        result = fetch_platform(platform, read_key(platform))
        if result["status"] != catalog.STATUS_REFRESHED:
            result = catalog.keep_previous(result["status"], previous, platform.id) | {"skipped": 0}
        platform_results[platform.id] = result
        print_line(platform.id, result)
    if should_write(platform_results):
        catalogue = catalog.build_catalogue(platform_results)
        write_atomically(catalog.keep_details(catalogue, previous), OUTPUT_PATH)
        print(f"Wrote {OUTPUT_PATH}")
    else:
        print("No platform was refreshed, so models.json was not changed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
