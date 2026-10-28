"""Tests for keys: where an API key is found, and how the per-user credentials file is written.

Each test uses a temporary folder in place of the real home folder, and clears the key variables it
touches, so no test reads or changes a real key. The .env lookup is pointed at a missing file so a
project .env cannot leak into a test.
"""

import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ordeal import core, keys, providers

# Key variables that the tests remove. Each test starts with all of them unset.
# XDG_CONFIG_HOME is deliberately not here: setUp sets it to a temporary folder, and removing it
# would send saves to the real home folder.
KEY_VARIABLES = ("HF_TOKEN", "OPENROUTER_API_KEY", "ORDEAL_API_KEY")


class KeyTestCase(unittest.TestCase):
    """Sets up a temporary config folder and an empty environment for each test."""

    def setUp(self) -> None:
        """Point XDG_CONFIG_HOME at a temporary folder and unset the key variables."""
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        self.config_home = self.folder / "config"
        # patch.dict restores the real environment after each test, so the pops below are safe.
        environment = mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": str(self.config_home)})
        environment.start()
        self.addCleanup(environment.stop)
        for name in KEY_VARIABLES:
            os.environ.pop(name, None)
        # The .env lookup points at a file that does not exist unless a test writes one.
        self.patch_env_files((self.folder / "missing.env",))
        self.credentials = self.config_home / "ordeal" / "credentials.json"

    def patch_env_files(self, paths: tuple) -> None:
        """Make core.load_env_file look only at the given .env paths, and undo the patch after the test."""
        patcher = mock.patch.object(core, "ENV_FILE_CANDIDATES", paths)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_credentials(self, data: dict) -> None:
        """Write the credentials file with the given contents, creating its folder first."""
        self.credentials.parent.mkdir(parents=True, exist_ok=True)
        self.credentials.write_text(json.dumps(data), encoding="utf-8")


class GetKeyTests(KeyTestCase):
    """get_key looks in the environment, then the .env file, then the credentials file."""

    def setUp(self) -> None:
        """Load the hosted platform used by the key lookups."""
        super().setUp()
        self.huggingface = providers.get_platform("huggingface")

    def test_environment_variable_comes_first(self) -> None:
        """A key in the environment wins over a key saved in the credentials file."""
        os.environ["HF_TOKEN"] = "from-env"
        self.write_credentials({"huggingface": "from-file"})
        self.assertEqual(keys.get_key(self.huggingface), "from-env")

    def test_dotenv_file_comes_before_credentials_file(self) -> None:
        """A key in the .env file wins over a key saved in the credentials file."""
        dotenv = self.folder / "test.env"
        dotenv.write_text("HF_TOKEN=from-dotenv\n", encoding="utf-8")
        self.patch_env_files((dotenv,))
        self.write_credentials({"huggingface": "from-file"})
        self.assertEqual(keys.get_key(self.huggingface), "from-dotenv")

    def test_credentials_file_is_the_last_place_looked(self) -> None:
        """With no environment variable and no .env entry, the saved key is used."""
        self.write_credentials({"huggingface": "from-file"})
        self.assertEqual(keys.get_key(self.huggingface), "from-file")

    def test_saved_key_for_another_platform_is_not_used(self) -> None:
        """A key saved for one platform never answers for a different platform."""
        self.write_credentials({"openrouter": "other-key"})
        with self.assertRaises(RuntimeError):
            keys.get_key(self.huggingface)

    def test_missing_key_error_names_the_variable_only(self) -> None:
        """When no key exists, the error names the variable so the user knows what to set."""
        with self.assertRaisesRegex(RuntimeError, "HF_TOKEN"):
            keys.get_key(self.huggingface)

    def test_local_platform_needs_no_key(self) -> None:
        """A local platform has no key variable, so get_key returns an empty string."""
        self.assertEqual(keys.get_key(providers.get_platform("ollama")), "")


class SaveAndForgetKeyTests(KeyTestCase):
    """save_key and forget_key change only the credentials file, and keep its mode private."""

    def test_save_key_creates_folder_and_private_file(self) -> None:
        """Saving makes the folder and file, and the file can be read only by its owner (mode 0o600)."""
        keys.save_key("huggingface", "hf-secret")
        self.assertTrue(self.credentials.exists())
        self.assertEqual(stat.S_IMODE(os.stat(self.credentials).st_mode), 0o600)
        self.assertEqual(json.loads(self.credentials.read_text(encoding="utf-8")), {"huggingface": "hf-secret"})

    def test_existing_file_mode_is_made_private(self) -> None:
        """A credentials file that was made with loose permissions is fixed to 0o600 on the next save."""
        self.write_credentials({})
        os.chmod(self.credentials, 0o644)
        keys.save_key("huggingface", "hf-secret")
        self.assertEqual(stat.S_IMODE(os.stat(self.credentials).st_mode), 0o600)

    def test_saved_key_is_found_by_get_key(self) -> None:
        """A key saved with save_key is the one get_key returns later."""
        keys.save_key("huggingface", "hf-secret")
        self.assertEqual(keys.get_key(providers.get_platform("huggingface")), "hf-secret")

    def test_save_keeps_other_platforms(self) -> None:
        """Saving one platform's key does not remove the keys of other platforms."""
        self.write_credentials({"openrouter": "or-key"})
        keys.save_key("huggingface", "hf-secret")
        saved = json.loads(self.credentials.read_text(encoding="utf-8"))
        self.assertEqual(saved, {"openrouter": "or-key", "huggingface": "hf-secret"})

    def test_forget_key_removes_only_that_platform(self) -> None:
        """Forgetting one key removes it and leaves the others; forgetting twice reports nothing removed."""
        self.write_credentials({"openrouter": "or-key", "huggingface": "hf-secret"})
        self.assertTrue(keys.forget_key("huggingface"))
        self.assertEqual(json.loads(self.credentials.read_text(encoding="utf-8")), {"openrouter": "or-key"})
        self.assertFalse(keys.forget_key("huggingface"))

    def test_save_key_refuses_unknown_platform(self) -> None:
        """An unknown platform id is refused, so a typo cannot create a useless saved key."""
        with self.assertRaises(ValueError):
            keys.save_key("no-such-platform", "some-key")
        self.assertFalse(self.credentials.exists())

    def test_save_key_refuses_blank_key(self) -> None:
        """A blank key is refused and no file is written."""
        with self.assertRaises(ValueError):
            keys.save_key("huggingface", "   ")
        self.assertFalse(self.credentials.exists())


class CredentialsLocationTests(KeyTestCase):
    """The credentials file sits under XDG_CONFIG_HOME when that is set, and under ~/.config when it is not."""

    def test_xdg_config_home_is_used_when_set(self) -> None:
        """With XDG_CONFIG_HOME set, the file goes in ordeal/credentials.json under that folder."""
        self.assertEqual(keys.credentials_path(), self.credentials)

    def test_home_config_is_used_when_xdg_is_not_set(self) -> None:
        """Without XDG_CONFIG_HOME, the file goes under the user's home .config folder."""
        os.environ.pop("XDG_CONFIG_HOME", None)
        fake_home = self.folder / "home"
        with mock.patch.object(keys.Path, "home", return_value=fake_home):
            self.assertEqual(keys.credentials_path(), fake_home / ".config" / "ordeal" / "credentials.json")


if __name__ == "__main__":
    unittest.main()
