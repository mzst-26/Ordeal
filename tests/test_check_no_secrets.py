"""Tests for scripts/check_no_secrets.py. Planted strings are built at run time so this file holds no key-like text."""

import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# scripts/ is not a package, so it is added to the import path to make check_no_secrets importable.
SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import check_no_secrets  # noqa: E402

# Each fake secret is joined from two parts so this file never contains a complete key-like string
# (so no scanner or reader of the repo mistakes the test file for a leaked secret).
FAKE_SK_KEY = "sk-" + "abcdefghijklmnopqrst"
FAKE_BEARER = "Bearer " + "abcdefghijklmnopqrstuvwxyz"
FAKE_TOKEN_NAME = "TOKEN_" + "FACTORY_TOKEN"
FAKE_PROJECT_KEY = "project-" + "0123456789abcdef"


# Guards the pre-publish secrets scan of frontend/: each secret shape (API key, token variable name, Bearer
# header, the project key from .env) is detected and gives exit code 1, a clean folder gives 0, the
# output gives only file, line and pattern name and never the matched text, and binary files are skipped.
class CheckNoSecretsTests(unittest.TestCase):
    """Run the check on a temporary folder so the real frontend/ is never touched."""

    def setUp(self):
        """Create a temporary root folder that holds an empty frontend/ folder."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        (self.root / "frontend").mkdir()

    def tearDown(self):
        """Delete the temporary folder."""
        self.temp_dir.cleanup()

    def write_site_file(self, name, text):
        """Write a text file under the temporary frontend/ folder."""
        (self.root / "frontend" / name).write_text(text, encoding="utf-8")

    def run_check(self, *extra_args):
        """Run main() on the temporary folder; return the exit code and the printed output."""
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = check_no_secrets.main(["--root", str(self.root), "--no-env-check", *extra_args])
        return code, output.getvalue()

    def test_clean_folder_passes(self):
        """A folder with no secret-like text exits 0."""
        self.write_site_file("index.html", "<h1>Spine meter</h1>\n")
        code, output = self.run_check()
        self.assertEqual(code, 0)
        self.assertIn("Secrets check passed: 1 files scanned.", output)

    def test_sk_key_is_found_as_api_key_shape(self):
        """A file with sk- followed by 20 letters is reported as api_key_shape and exits 1."""
        self.write_site_file("app.js", f"const key = '{FAKE_SK_KEY}';\n")
        code, output = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("app.js:1: pattern api_key_shape", output)

    def test_token_name_is_found_as_token_variable_name(self):
        """A file that names the token variable is reported as token_variable_name."""
        self.write_site_file("notes.txt", f"line one\nuse {FAKE_TOKEN_NAME} here\n")
        code, output = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("notes.txt:2: pattern token_variable_name", output)

    def test_bearer_token_is_found_as_bearer_header(self):
        """A Bearer header with 16 or more token characters is reported as bearer_header."""
        self.write_site_file("config.json", f'{{"auth": "{FAKE_BEARER}"}}\n')
        code, output = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("config.json:1: pattern bearer_header", output)

    def test_printed_output_never_contains_matched_text(self):
        """The planted key and bearer text are not printed, only the location and pattern name."""
        self.write_site_file("leak.html", f"{FAKE_SK_KEY}\n{FAKE_BEARER}\n")
        code, output = self.run_check()
        self.assertEqual(code, 1)
        self.assertNotIn(FAKE_SK_KEY, output)
        self.assertNotIn(FAKE_BEARER, output)
        self.assertNotIn("abcdefghijklmnopqrst", output)
        self.assertIn("FAILED: 2 findings in 1 files.", output)

    def test_binary_file_is_skipped(self):
        """A file with a NUL byte in its first 8000 bytes is not scanned, so a key inside it is ignored."""
        (self.root / "frontend" / "image.bin").write_bytes(b"\x00\x01" + FAKE_SK_KEY.encode("ascii"))
        code, output = self.run_check()
        self.assertEqual(code, 0)
        self.assertIn("Secrets check passed: 0 files scanned.", output)

    def test_no_env_check_skips_project_key_value(self):
        """With --no-env-check the .env key is never read, so the project_key_value pattern never runs."""
        self.write_site_file("plain.txt", f"{FAKE_PROJECT_KEY}\n")
        with mock.patch.object(check_no_secrets, "read_project_key") as read_key:
            code, output = self.run_check()
        read_key.assert_not_called()
        self.assertEqual(code, 0)
        self.assertNotIn("pattern project_key_value", output)

    def test_project_key_is_found_as_project_key_value_without_flag(self):
        """Without --no-env-check the key value from .env is searched for and reported as project_key_value."""
        self.write_site_file("plain.txt", f"value {FAKE_PROJECT_KEY}\n")
        output = io.StringIO()
        with mock.patch.object(check_no_secrets, "read_project_key", return_value=FAKE_PROJECT_KEY):
            with contextlib.redirect_stdout(output):
                code = check_no_secrets.main(["--root", str(self.root)])
        self.assertEqual(code, 1)
        self.assertIn("plain.txt:1: pattern project_key_value", output.getvalue())
        self.assertNotIn(FAKE_PROJECT_KEY, output.getvalue())


if __name__ == "__main__":
    unittest.main()
