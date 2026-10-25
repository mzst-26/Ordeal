"""Finds and saves the API key for each platform, so a person can set a key once and forget it.

A key is looked up in three places, in this order: the environment variable named by the platform,
the .env file, and a per-user credentials file. The credentials file lives outside the project, so a
saved key can never be committed to the repository. Keys are never printed. Errors name the
variable that is missing, never its value.
"""

import json
import os
from pathlib import Path

from ordeal import core, providers

# The per-user credentials file sits in a folder named "ordeal" under the config folder.
CONFIG_FOLDER_NAME = "ordeal"
CREDENTIALS_FILE_NAME = "credentials.json"
# Owner read and write only. The file holds secrets, so other users on the computer must not read it.
CREDENTIALS_MODE = 0o600
# The folder holds the credentials file, so only its owner may enter it.
CREDENTIALS_FOLDER_MODE = 0o700


def credentials_path() -> Path:
    """Return the path of the credentials file.

    The XDG_CONFIG_HOME variable is the standard place for user settings on Linux and macOS. When it is
    not set, the default is the .config folder in the user's home folder.
    """
    config_home = os.environ.get("XDG_CONFIG_HOME", "")
    base_folder = Path(config_home) if config_home else Path.home() / ".config"
    return base_folder / CONFIG_FOLDER_NAME / CREDENTIALS_FILE_NAME


def read_saved_keys() -> dict:
    """Return the saved keys as {platform id: key}. A missing file gives an empty dict.

    A file that is not a JSON object is refused. The error names the file, never its contents.
    """
    path = credentials_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"{path} is not valid JSON. Fix it or delete it.") from error
    if not isinstance(data, dict):
        raise ValueError(f"{path} must hold one JSON object.")
    return data


def write_saved_keys(keys: dict) -> None:
    """Write the saved keys to the credentials file, creating the folder, and keep the file private.

    The keys go into a new temporary file that is created with owner-only permissions, and that file then
    replaces the credentials file. This way the key is never written to a file other people can read, even
    when an old credentials file already exists with looser permissions (os.open applies its mode only to a
    newly created file, so it cannot fix an old one).
    """
    path = credentials_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=CREDENTIALS_FOLDER_MODE)
    text = json.dumps(keys, indent=2, sort_keys=True) + "\n"
    temporary = path.with_name(path.name + ".tmp")
    # Remove a leftover temporary file first, so os.open really creates a new file with the owner-only mode.
    temporary.unlink(missing_ok=True)
    file_descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, CREDENTIALS_MODE)
    with os.fdopen(file_descriptor, "w", encoding="utf-8") as file:
        file.write(text)
    os.replace(temporary, path)


def get_key(platform: providers.Platform) -> str:
    """Return the key for one platform, looking in the environment, the .env file, then the credentials file.

    A local platform with no key variable returns "" because it needs no key. A hosted platform with no
    key anywhere raises RuntimeError that names the variable, so the person knows what to set.
    """
    if platform.key_env is None:
        return ""
    # The environment comes first, so an exported variable always beats the .env file and the saved key.
    value = os.environ.get(platform.key_env, "")
    if not value:
        # load_env_file keeps any variable already set, so this only fills in what is missing.
        core.load_env_file()
        value = os.environ.get(platform.key_env, "")
    if not value:
        saved_value = read_saved_keys().get(platform.id, "")
        value = saved_value if isinstance(saved_value, str) else ""
    if not value:
        raise RuntimeError(
            f"No key for {platform.name}. Set {platform.key_env} in the environment or the .env file, "
            "or save a key for this platform."
        )
    return value


def save_key(platform_id: str, key: str) -> None:
    """Save the key for one platform in the credentials file. Raises ValueError for an unknown platform or a blank key."""
    platform = providers.get_platform(platform_id)
    cleaned = key.strip()
    if not cleaned:
        raise ValueError("The key is empty, so nothing was saved.")
    saved = read_saved_keys()
    saved[platform.id] = cleaned
    write_saved_keys(saved)


def forget_key(platform_id: str) -> bool:
    """Remove the saved key for one platform. Returns True if one was removed, False if none was saved."""
    saved = read_saved_keys()
    if platform_id not in saved:
        return False
    del saved[platform_id]
    write_saved_keys(saved)
    return True
