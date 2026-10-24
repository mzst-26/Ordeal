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

import csv
import hashlib
import json
import re
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_DIR))

import core  # noqa: E402  (needs the project folder on sys.path first)

SITE_DATA_DIR = PROJECT_DIR / "site" / "data"
SOURCE_NAME = "spine-meter"
MANIFEST_NAME = "manifest.json"
NEW_FILES_FLAG = "--new-files-only"
V4_LADDER_NAME = "ladder_v4.json"
V4_PROBE_SPEC_NAME = "probe_spec_v4.json"
SUITES_NAME = "suites.json"
QUESTION_SITE_NAMES = {"easy": "questions.json", "hard": "questions_hard.json"}
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
SAMPLE_FIELDS = ("model", "question_id", "repeat", "step", "reply", "user_text")
SETUP_STEP_FOR_LEVEL_FOUR = core.setup_step(4)
# Steps in the order they happen in the conversation. Probe steps come after these.
ORDERED_STEPS = (
    core.BASELINE_STEP,
    SETUP_STEP_FOR_LEVEL_FOUR,
    *core.PUSHBACK_STEPS,
    core.CONFESSION_STEP,
    *core.CORRECTION_STEPS,
)
PROBE_STEP_PREFIXES = ("fp_", "twin_", "dose_")
# The browser follows the order of keys in an object (the dose dials are shown in that order), so these files
# keep the key order of their source. Every other file is written with its keys sorted.
SOURCE_ORDER_FILES = ("ladder.json", "probe_spec.json", "questions.json", "config.json")
SECRET_PATTERNS = (re.compile(r"sk-[A-Za-z0-9]{16,}"), re.compile(r"Bearer "))
# config.json must not even mention these words, so the public file stays free of settings that hold secrets.
CONFIG_FORBIDDEN_TEXT = ("TOKEN", "Bearer", "sk-")


def read_csv_rows(path):
    """Return the rows of a CSV file as dicts with string values. A missing file gives an empty list."""
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8") as file:
        return [{key: ("" if value is None else value) for key, value in row.items()} for row in csv.DictReader(file)]


def public_config(config):
    """Return only the settings the site may show, in their source order, leaving out keys not in config.json."""
    return {key: value for key, value in config.items() if key in PUBLIC_CONFIG_KEYS}


def public_questions(questions):
    """Return each question with only its public fields, in their source order. Missing fields are not invented."""
    return [{field: value for field, value in question.items() if field in QUESTION_FIELDS} for question in questions]


def last_user_text(messages):
    """Return the content of the last message with role 'user', or None if there is none."""
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
    if step in ORDERED_STEPS:
        return (ORDERED_STEPS.index(step), "")
    for group_number, prefix in enumerate(PROBE_STEP_PREFIXES, start=len(ORDERED_STEPS)):
        if step.startswith(prefix):
            return (group_number, step)
    return (len(ORDERED_STEPS) + len(PROBE_STEP_PREFIXES), step)


def sample_sort_key(sample):
    """Return the sort key for a sample: model, question, repeat, then step order."""
    return (sample["model"], sample["question_id"], sample["repeat"], step_rank(sample["step"]))


def build_sample_run():
    """Return the sample replies for condition 'none' in the current experiment, sorted for display."""
    cache = core.load_cache(core.CACHE_PATH)
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
    sort_keys = name not in SOURCE_ORDER_FILES
    return json.dumps(data, ensure_ascii=False, indent=1, sort_keys=sort_keys) + "\n"


def contains_secret(name, text):
    """Return True if a file's text has a key-like string. Only the file name is ever reported."""
    if any(pattern.search(text) for pattern in SECRET_PATTERNS):
        return True
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
    ladder_path = PROJECT_DIR / core.LADDER_FILES["gauntlet_v4"][0]
    probe_path = PROJECT_DIR / core.LADDER_FILES["gauntlet_v4"][1]
    hard_path = PROJECT_DIR / core.QUESTION_FILES["hard"]
    hard_questions = public_questions(core.load_questions(hard_path))
    return [
        (V4_LADDER_NAME, checked_source_bytes(ladder_path, core.load_ladder)),
        (V4_PROBE_SPEC_NAME, checked_source_bytes(probe_path, core.load_probe_spec)),
        (QUESTION_SITE_NAMES["hard"], serialize_in_source_order(hard_questions).encode("utf-8")),
        (SUITES_NAME, serialize(SUITES_NAME, build_suites_index()).encode("utf-8")),
    ]


def write_new_files():
    """Write only the files added for the new suites. Existing site/data files are never touched."""
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


def main():
    """Build every output, check for key-like strings, then write the files and the manifest."""
    outputs = build_outputs()
    rendered = [(name, data, serialize(name, data).encode("utf-8")) for name, data in outputs]
    for name, _, data_bytes in rendered:
        if contains_secret(name, data_bytes.decode("utf-8")):
            print(f"Refused to write {name}: it contains a key-like string.", file=sys.stderr)
            return 1

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
    if NEW_FILES_FLAG in sys.argv[1:]:
        sys.exit(write_new_files())
    sys.exit(main())
