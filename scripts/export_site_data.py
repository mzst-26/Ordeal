"""Export the public data the static site needs into site/data/.

The website never reads the project's private files. This script copies the
pressure ladder and the probe spec as they are, writes the questions and a
public part of config.json, and turns the saved sample replies and the result
CSV files into JSON. It also writes a manifest with the size and SHA-256 hash
of each file, so the site can show what was exported.

The script makes no network calls, never reads .env files and never reads
environment variables. Before it writes anything, it checks every output for
key-like strings and refuses to write if one is found.
"""

# Module overview: run `python scripts/export_site_data.py` to refresh site/data/.
# Run with --new-files-only to write just the files added for the v4 ladder and
# the hard question set, leaving the older site files untouched.
import csv
import hashlib
import json
import re
import sys
from pathlib import Path

# The project root is the folder above scripts/. It is added to the import path so that
# `import core` works when this file is run directly.
PROJECT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_DIR))

from ordeal import core  # noqa: E402  (needs the project folder on sys.path first)

# Where every exported file is written.
SITE_DATA_DIR = PROJECT_DIR / "site" / "data"
# Value stored in version.json to say which project the export came from.
SOURCE_NAME = "Ordeal"
MANIFEST_NAME = "manifest.json"
# The shared platform list. The Python package and the browser site read the same platforms, so a platform
# added once is seen by both. The site copy leaves out key_env: the browser never reads environment variables,
# and the deploy check refuses the name of the token variable in public files.
PROVIDERS_SOURCE_PATH = PROJECT_DIR / "ordeal" / "providers.json"
PROVIDERS_SITE_NAME = "providers.json"
# Command-line flag that switches the script to write_new_files() instead of main().
NEW_FILES_FLAG = "--new-files-only"
# File names the v4 ladder and v4 probe spec get on the site.
V4_LADDER_NAME = "ladder_v4.json"
V4_PROBE_SPEC_NAME = "probe_spec_v4.json"
SUITES_NAME = "suites.json"
# Site file name for each question set (the keys match core.QUESTION_FILES).
QUESTION_SITE_NAMES = {"easy": "questions.json", "hard": "questions_hard.json"}
# The only config.json keys that are copied to the public site. Anything else is dropped.
PUBLIC_CONFIG_KEYS = (
    "base_url",
    "models",
    "catalog",
    "repeats",
    "temperature",
    "max_tokens",
    "concurrency",
    "request_timeout_seconds",
    "answer_format_reminder",
    "corrections",
    "system_prompts",
    "bootstrap_resamples",
    "random_seed",
)
# The only fields of each question that are exported.
QUESTION_FIELDS = (
    "id",
    "tier",
    "category",
    "difficulty",
    "question",
    "options",
    "correct",
    "pushed_wrong",
    "correction_test",
    "wrapper_test",
    "wrong_path",
)
# The fields a sample reply has after reduce_sample(). (Not used elsewhere in this file.)
SAMPLE_FIELDS = ("model", "question_id", "repeat", "step", "reply", "user_text")
# Name of the setup turn at pressure level 4 (from core.setup_step).
SETUP_STEP_FOR_LEVEL_FOUR = core.setup_step(4)
# Steps in the order they happen in the conversation. Probe steps come after these.
ORDERED_STEPS = (
    core.BASELINE_STEP,
    SETUP_STEP_FOR_LEVEL_FOUR,
    *core.PUSHBACK_STEPS,
    core.CONFESSION_STEP,
    *core.CORRECTION_STEPS,
)
# Name prefixes of the probe steps. step_rank() sorts probe steps in this group order, then by name.
PROBE_STEP_PREFIXES = ("fp_", "twin_", "dose_")
# The browser follows the order of keys in an object (the dose dials are shown in that order), so these files
# keep the key order of their source. Every other file is written with its keys sorted.
SOURCE_ORDER_FILES = ("ladder.json", "probe_spec.json", "questions.json", "config.json")
# Text shapes that look like an API key ("sk-" followed by 16 or more letters or digits) or an
# auth header. If any output matches, the export is refused.
SECRET_PATTERNS = (re.compile(r"sk-[A-Za-z0-9]{16,}"), re.compile(r"Bearer "))
# config.json must not even mention these words, so the public file stays free of settings that hold secrets.
CONFIG_FORBIDDEN_TEXT = ("TOKEN", "Bearer", "sk-")


def read_csv_rows(path):
    """Return the rows of a CSV file as dicts with string values. A missing file gives an empty list."""
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8") as file:
        # csv.DictReader gives None for cells missing from a short row; those become "" so every value is a string.
        return [{key: ("" if value is None else value) for key, value in row.items()} for row in csv.DictReader(file)]


def public_config(config):
    """Return only the settings the site may show, in their source order, leaving out keys not in config.json."""
    return {key: value for key, value in config.items() if key in PUBLIC_CONFIG_KEYS}


def public_questions(questions):
    """Return each question with only its public fields, in their source order. Missing fields are not invented."""
    return [{field: value for field, value in question.items() if field in QUESTION_FIELDS} for question in questions]


def last_user_text(messages):
    """Return the content of the last message with role 'user', or None if there is none."""
    # Walk backwards so the first match is the most recent user message.
    for message in reversed(messages):
        if message.get("role") == "user":
            return message.get("content")
    return None


def reduce_sample(record):
    """Keep only the fields the site needs from one saved reply, plus the last user message."""
    return {
        "model": record["model"],
        "question_id": record["question_id"],
        "repeat": record["repeat"],
        "step": record["step"],
        "reply": record["reply"],
        "user_text": last_user_text(record["messages"]),
    }


def step_rank(step):
    """Return a sort key for a step: the fixed conversation order first, then the probe groups A to Z."""
    # Fixed steps rank by their position in ORDERED_STEPS.
    if step in ORDERED_STEPS:
        return (ORDERED_STEPS.index(step), "")
    # Probe groups rank after all fixed steps, one rank per prefix; the step name breaks ties within a group.
    for group_number, prefix in enumerate(PROBE_STEP_PREFIXES, start=len(ORDERED_STEPS)):
        if step.startswith(prefix):
            return (group_number, step)
    # Any unknown step goes last.
    return (len(ORDERED_STEPS) + len(PROBE_STEP_PREFIXES), step)


def sample_sort_key(sample):
    """Return the sort key for a sample: model, question, repeat, then step order."""
    return (sample["model"], sample["question_id"], sample["repeat"], step_rank(sample["step"]))


def build_sample_run():
    """Return the sample replies for condition 'none' in the current experiment, sorted for display."""
    cache = core.load_cache(core.CACHE_PATH)
    # Only replies from the "none" condition (no system prompt) are shown on the site.
    samples = [
        reduce_sample(record)
        for record in cache.values()
        if record["condition"] == core.NO_SYSTEM_PROMPT
    ]
    return sorted(samples, key=sample_sort_key)


def build_version():
    """Return the experiment code, the export time and the source name."""
    return {
        "experiment": core.current_experiment(),
        "exported_at": core.utc_timestamp(),
        "source": SOURCE_NAME,
    }


def build_outputs():
    """Return a list of (file name, data) pairs for every file except the manifest."""
    config = core.load_config()
    # ladder.json and probe_spec.json are the project files as loaded, with nothing removed;
    # questions and config are cut down to their public parts first.
    return [
        ("ladder.json", core.load_json(core.LADDER_PATH)),
        ("probe_spec.json", core.load_json(core.PROBE_SPEC_PATH)),
        ("questions.json", public_questions(core.load_questions())),
        ("config.json", public_config(config)),
        ("version.json", build_version()),
        ("sample_run.json", build_sample_run()),
        ("results.json", read_csv_rows(core.RESULTS_CSV_PATH)),
        ("probes.json", read_csv_rows(core.PROBES_CSV_PATH)),
    ]


def serialize(name, data):
    """Return the JSON text for one output file. Files in SOURCE_ORDER_FILES keep their key order."""
    # Sorted keys make the output stable from run to run, except for the files that must keep source order.
    sort_keys = name not in SOURCE_ORDER_FILES
    # ensure_ascii=False keeps non-ASCII characters as they are; the trailing newline ends the file cleanly.
    return json.dumps(data, ensure_ascii=False, indent=1, sort_keys=sort_keys) + "\n"


def contains_secret(name, text):
    """Return True if a file's text has a key-like string. Only the file name is ever reported."""
    if any(pattern.search(text) for pattern in SECRET_PATTERNS):
        return True
    # The extra word check applies to config.json only.
    return name == "config.json" and any(word in text for word in CONFIG_FORBIDDEN_TEXT)


def count_records(data):
    """Return the number of records in a list output, or None for a file that is not a list."""
    return len(data) if isinstance(data, list) else None


def sha256_hex(data_bytes):
    """Return the SHA-256 hash of some bytes as a hex string."""
    return hashlib.sha256(data_bytes).hexdigest()


def build_manifest(entries):
    """Return the manifest data for a list of (name, data bytes) pairs."""
    return [
        {"name": name, "bytes": len(data_bytes), "sha256": sha256_hex(data_bytes)}
        for name, data_bytes in entries
    ]


def write_file(name, data_bytes):
    """Write one output file into site/data/, creating the folder if it is missing."""
    SITE_DATA_DIR.mkdir(parents=True, exist_ok=True)
    (SITE_DATA_DIR / name).write_bytes(data_bytes)


def print_summary(name, data_bytes, data):
    """Print one line per written file: name, size and record count for lists."""
    count = count_records(data)
    count_text = f", {count} records" if count is not None else ""
    print(f"{name}: {len(data_bytes)} bytes{count_text}")


def serialize_in_source_order(data):
    """Return JSON text with the keys in their source order, the same layout as the other site files."""
    return json.dumps(data, ensure_ascii=False, indent=1) + "\n"


def check_no_key_text(name, data_bytes):
    """Raise ValueError if one output file has a key-like string. Only the file name is in the message."""
    if contains_secret(name, data_bytes.decode("utf-8")):
        raise ValueError(f"Refused to write {name}: it contains a key-like string.")


def checked_source_bytes(source_path, loader):
    """Run a loader check on a project file, then return its raw bytes unchanged."""
    loader(source_path)
    return source_path.read_bytes()


def suite_file_names(suite):
    """Return the site file names a suite uses for its ladder, probe spec and question set."""
    # core.LADDER_FILES maps a ladder name to its (ladder file, probe/wrapper file) in the project folder.
    # The v4 files get their own site names so they do not overwrite the v3 ladder.json and probe_spec.json.
    ladder_source, probe_source = core.LADDER_FILES[suite.ladder_name]
    ladder_name = V4_LADDER_NAME if ladder_source == "ladder_v4.json" else "ladder.json"
    probe_name = V4_PROBE_SPEC_NAME if probe_source == "wrappers_v4.json" else "probe_spec.json"
    return {"ladder": ladder_name, "probe_spec": probe_name, "questions": QUESTION_SITE_NAMES[suite.question_set]}


def suite_entry(suite):
    """Return the index entry for one suite: its name, settings, fingerprint and site file names."""
    return {
        "name": suite.name,
        "ladder": suite.ladder_name,
        "question_set": suite.question_set,
        "level_count": suite.level_count,
        "held_firm_score": suite.held_firm_score,
        "experiment": suite.experiment,
        "files": suite_file_names(suite),
    }


def build_suites_index():
    """Return the suites.json data: one entry for every ladder and question-set pair in the registries."""
    return [
        suite_entry(core.load_suite(ladder=ladder, questions=questions))
        for ladder in core.LADDER_FILES
        for questions in core.QUESTION_FILES
    ]


def build_new_outputs():
    """Return (file name, bytes) pairs for the files added for the new suites. Nothing is written here."""
    # Locate the v4 ladder, the v4 probe (wrapper) file and the hard question set in the project folder.
    ladder_path = core.DATA_DIR / core.LADDER_FILES["gauntlet_v4"][0]
    probe_path = core.DATA_DIR / core.LADDER_FILES["gauntlet_v4"][1]
    hard_path = core.DATA_DIR / core.QUESTION_FILES["hard"]
    hard_questions = public_questions(core.load_questions(hard_path))
    # The ladder and probe spec are copied byte for byte (after being validated by core's loaders);
    # the hard questions are filtered to public fields and keep their source key order.
    return [
        (V4_LADDER_NAME, checked_source_bytes(ladder_path, core.load_ladder)),
        (V4_PROBE_SPEC_NAME, checked_source_bytes(probe_path, core.load_probe_spec)),
        (QUESTION_SITE_NAMES["hard"], serialize_in_source_order(hard_questions).encode("utf-8")),
        (SUITES_NAME, serialize(SUITES_NAME, build_suites_index()).encode("utf-8")),
    ]


def write_new_files():
    """Write only the files added for the new suites. Existing site/data files are never touched."""
    # Check every file before writing any, so a failure leaves site/data/ unchanged.
    # Return value is the process exit code: 0 for success, 1 if a file was refused.
    try:
        outputs = build_new_outputs()
        for name, data_bytes in outputs:
            check_no_key_text(name, data_bytes)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1
    for name, data_bytes in outputs:
        write_file(name, data_bytes)
        print(f"{name}: {len(data_bytes)} bytes")
    return 0


def build_providers_output():
    """Return (name, data, bytes) for the shared platform list, prepared for the public site.

    Every platform is kept, but key_env is removed: the browser asks the visitor to type the key and never
    reads an environment variable. The file is parsed first, so a broken list stops the export instead of
    reaching the browser.
    """
    providers_data = json.loads(PROVIDERS_SOURCE_PATH.read_text(encoding="utf-8"))
    for platform in providers_data["platforms"]:
        platform.pop("key_env", None)
    providers_bytes = serialize(PROVIDERS_SITE_NAME, providers_data).encode("utf-8")
    return (PROVIDERS_SITE_NAME, providers_data, providers_bytes)


def main():
    """Build every output, check for key-like strings, then write the files and the manifest."""
    # Return value is the process exit code: 0 for success, 1 if a file was refused.
    # Each item in rendered is (name, original data, encoded JSON bytes).
    outputs = build_outputs()
    rendered = [(name, data, serialize(name, data).encode("utf-8")) for name, data in outputs]
    # The platform list is prepared above, so its bytes are added as they are.
    rendered.append(build_providers_output())
    for name, _, data_bytes in rendered:
        if contains_secret(name, data_bytes.decode("utf-8")):
            print(f"Refused to write {name}: it contains a key-like string.", file=sys.stderr)
            return 1

    # The manifest describes the exact bytes about to be written, so it is built from the rendered bytes and
    # checked too. It is written last, after all the files it lists.
    manifest_data = build_manifest([(name, data_bytes) for name, _, data_bytes in rendered])
    manifest_bytes = serialize(MANIFEST_NAME, manifest_data).encode("utf-8")
    if contains_secret(MANIFEST_NAME, manifest_bytes.decode("utf-8")):
        print(f"Refused to write {MANIFEST_NAME}: it contains a key-like string.", file=sys.stderr)
        return 1

    for name, data, data_bytes in rendered:
        write_file(name, data_bytes)
        print_summary(name, data_bytes, data)
    write_file(MANIFEST_NAME, manifest_bytes)
    print_summary(MANIFEST_NAME, manifest_bytes, manifest_data)
    return 0


if __name__ == "__main__":
    # The exit code of the chosen mode becomes the exit code of the script.
    if NEW_FILES_FLAG in sys.argv[1:]:
        sys.exit(write_new_files())
    sys.exit(main())
