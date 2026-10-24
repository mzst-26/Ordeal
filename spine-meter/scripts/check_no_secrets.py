"""Fail if the deployed files (site/, netlify/ and netlify.toml) contain an API key or key-like text."""

import argparse
import re
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
# Running this file directly puts scripts/ on sys.path, so the project folder must be added to find core.
sys.path.insert(0, str(PROJECT_DIR))

import core  # noqa: E402

BINARY_SNIFF_BYTES = 8000
MIN_PROJECT_KEY_LENGTH = 16
DEPLOY_FOLDERS = ("site", "netlify")
DEPLOY_FILE = "netlify.toml"


def parse_args(argv):
    """Read the command-line options."""
    parser = argparse.ArgumentParser(description="Check deployed files for secrets.")
    parser.add_argument("--root", type=Path, default=PROJECT_DIR, help="folder to scan (default: project folder)")
    parser.add_argument("--no-env-check", action="store_true", help="skip the search for the project key value")
    return parser.parse_args(argv)


def find_env_file():
    """Return the first .env file from core.ENV_FILE_CANDIDATES that exists, or None."""
    for candidate in core.ENV_FILE_CANDIDATES:
        if candidate.is_file():
            return candidate
    return None


def read_project_key():
    """Return the TOKEN_FACTORY_TOKEN value from the .env file, or None if it is missing or too short."""
    env_file = find_env_file()
    if env_file is None:
        print("No .env file found: skipping the project_key_value check.")
        return None
    prefix = core.TOKEN_ENV_VAR + "="
    for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.lstrip().startswith(prefix):
            value = line.lstrip()[len(prefix):].strip().strip("\"'").strip()
            # Short values would match too much text, so only a long key is searched for.
            if len(value) >= MIN_PROJECT_KEY_LENGTH:
                return value
            print("Project key in .env is too short to search for: skipping the project_key_value check.")
            return None
    print("No TOKEN_FACTORY_TOKEN line in .env: skipping the project_key_value check.")
    return None


def build_patterns(env_check):
    """Return (name, regex) pairs to search for; project_key_value is added only when env_check is True."""
    patterns = [
        ("api_key_shape", re.compile(r"sk-[A-Za-z0-9]{16,}")),
        ("bearer_header", re.compile(r"Bearer\s+[A-Za-z0-9._\-]{16,}")),
        ("token_variable_name", re.compile(re.escape(core.TOKEN_ENV_VAR))),
    ]
    if env_check:
        key = read_project_key()
        if key is not None:
            patterns.append(("project_key_value", re.compile(re.escape(key))))
    return patterns


def collect_scan_targets(root):
    """Return a sorted list of every file under the deploy folders and the netlify.toml file in root."""
    targets = []
    for folder_name in DEPLOY_FOLDERS:
        folder = root / folder_name
        if folder.is_dir():
            targets.extend(path for path in folder.rglob("*") if path.is_file())
    deploy_file = root / DEPLOY_FILE
    if deploy_file.is_file():
        targets.append(deploy_file)
    return sorted(targets)


def read_text_file(path):
    """Return the file as text, or None if it is binary (a NUL byte in its first 8000 bytes)."""
    data = path.read_bytes()
    if b"\x00" in data[:BINARY_SNIFF_BYTES]:
        return None
    return data.decode("utf-8", errors="replace")


def report_matches(display_name, text, patterns):
    """Print the path, line number and pattern name for each match, never the text; return the match count."""
    count = 0
    for line_number, line in enumerate(text.splitlines(), start=1):
        for name, regex in patterns:
            if regex.search(line):
                print(f"{display_name}:{line_number}: pattern {name}")
                count += 1
    return count


def main(argv=None):
    """Run the check and return 0 when nothing is found, 1 when anything is found."""
    args = parse_args(argv)
    root = args.root.resolve()
    patterns = build_patterns(env_check=not args.no_env_check)

    files_scanned = 0
    total_findings = 0
    files_with_findings = 0
    for path in collect_scan_targets(root):
        text = read_text_file(path)
        if text is None:
            continue
        files_scanned += 1
        found = report_matches(path.relative_to(root).as_posix(), text, patterns)
        total_findings += found
        if found:
            files_with_findings += 1

    if total_findings == 0:
        print(f"Secrets check passed: {files_scanned} files scanned.")
        return 0
    print(f"Secrets check FAILED: {total_findings} findings in {files_with_findings} files.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
