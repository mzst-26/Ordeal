"""Browser tests for the Compare providers panel on the batch view (frontend/index.html#batch), run in Chromium through Playwright.

The tests serve the Vite build on 127.0.0.1 and abort every request to any other host, so a page that tries to reach
the network fails the test. Each test uses a fake key of the right shape, and checks that the key never reaches the page
text or the console, and that it is written to local storage only when Remember is ticked.

Run from the project folder:
    .venv-spine/bin/python -m unittest tests.python.test_batch_side_by_side_browser -v
"""

import contextlib
import socket
import subprocess
import sys
import time
import unittest
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

PROJECT_DIR = Path(__file__).resolve().parents[2]
DIST_DIR = PROJECT_DIR / "dist"
LOCAL_HOST = "127.0.0.1"
PREFERRED_PORT = 8791
DESKTOP = {"width": 1280, "height": 800}
SHORT_MS = 5000
LONG_MS = 10000
# A fake key of the right shape. It is not a real key, and it must never appear in the page or the console.
FAKE_KEY = "fake-nebius-key-" + "5" * 24
KEY_STORAGE_NAME = "ordeal.provider-keys"
TOO_MANY_TEXT = "You can compare up to 3 providers at once"
CLI_POINTER_TEXT = "ordeal test groq"

_SERVER = None
_PLAYWRIGHT = None
_BROWSER = None
_BASE_URL = ""


def pick_port():
    """Return port 8791 when it is free on 127.0.0.1, otherwise any free port there."""
    for port in (PREFERRED_PORT, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((LOCAL_HOST, port))
            except OSError:
                continue
            return sock.getsockname()[1]
    raise RuntimeError("No free port on 127.0.0.1.")


def wait_for_server(url, timeout_s=15.0):
    """Poll the URL until it answers, so no test starts before the server is ready."""
    deadline = time.monotonic() + timeout_s
    last_error = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except OSError as error:
            last_error = error
        time.sleep(0.1)
    raise RuntimeError(f"The local server did not answer at {url}: {last_error}")


def setUpModule():
    """Build the site, serve dist/ on 127.0.0.1 and launch Chromium once for the whole module."""
    global _SERVER, _PLAYWRIGHT, _BROWSER, _BASE_URL
    subprocess.run(["npm", "run", "build"], cwd=PROJECT_DIR, check=True, capture_output=True, text=True)
    port = pick_port()
    _BASE_URL = f"http://{LOCAL_HOST}:{port}"
    _SERVER = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", LOCAL_HOST, "--directory", str(DIST_DIR)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_for_server(_BASE_URL + "/index.html")
        _PLAYWRIGHT = sync_playwright().start()
        _BROWSER = _PLAYWRIGHT.chromium.launch()
    except Exception:
        tearDownModule()
        raise


def tearDownModule():
    """Close the browser and stop the server that setUpModule started."""
    global _SERVER, _PLAYWRIGHT, _BROWSER
    if _BROWSER is not None:
        _BROWSER.close()
        _BROWSER = None
    if _PLAYWRIGHT is not None:
        _PLAYWRIGHT.stop()
        _PLAYWRIGHT = None
    if _SERVER is not None:
        _SERVER.terminate()
        try:
            _SERVER.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _SERVER.kill()
        _SERVER = None


def guard_route(route, blocked):
    """Abort every request to a host other than 127.0.0.1, and record its address."""
    parsed = urlparse(route.request.url)
    if parsed.scheme in ("http", "https", "ws", "wss") and parsed.hostname != LOCAL_HOST:
        blocked.append(route.request.url)
        route.abort()
    else:
        route.continue_()


@contextlib.contextmanager
def open_batch_page(remember_storage=None):
    """Open the batch view in a fresh browser context. Yields (page, console_lines, blocked_requests)."""
    context = _BROWSER.new_context(viewport=DESKTOP)
    blocked = []
    context.route("**/*", lambda route: guard_route(route, blocked))
    page = context.new_page()
    console_lines = []
    page.on("console", lambda message: console_lines.append(message.text))
    page.goto(_BASE_URL + "/index.html#batch")
    try:
        yield page, console_lines, blocked
    finally:
        context.close()


def panel(page):
    """Return the Compare providers panel, the element that holds its picker, rows and results."""
    return page.locator("#side-by-side")


def add_provider(page, provider_id):
    """Pick a provider in the compare panel's list and press Add provider."""
    panel(page).locator("select").select_option(provider_id)
    panel(page).get_by_role("button", name="Add provider").click()


def row_for(page, name):
    """Return the row in the compare panel that names this provider."""
    # The name sits in its own element, so a reason that mentions the same word does not match another row.
    return panel(page).locator(".side-by-side-row", has=page.locator("strong", has_text=name))


def save_fake_key(page, name, remember):
    """Open the key dialog from a provider's row, enter the fake key, tick Remember if asked, and save."""
    row_for(page, name).get_by_role("button", name="Add or change key").click()
    page.locator("#token-dialog-field").fill(FAKE_KEY)
    if remember:
        page.locator("#token-dialog-remember").check()
    page.get_by_role("button", name="Save key").click()


class BatchSideBySideBrowserTests(unittest.TestCase):
    """The compare panel: limits, blocked providers, keys per provider, and what reaches the page and the console."""

    def test_fourth_provider_is_refused_and_blocked_providers_point_to_the_command_line(self):
        with open_batch_page() as (page, _console, blocked):
            expect(panel(page).get_by_role("heading", name="Compare providers")).to_be_visible(timeout=LONG_MS)
            for provider_id in ("groq", "together", "nebius"):
                add_provider(page, provider_id)
            add_provider(page, "openrouter")
            expect(panel(page).locator("[role=status]").first).to_contain_text(TOO_MANY_TEXT, timeout=SHORT_MS)
            expect(row_for(page, "Groq")).to_contain_text("Not available here")
            expect(row_for(page, "Groq")).to_contain_text(CLI_POINTER_TEXT)
            expect(row_for(page, "Nebius")).to_contain_text("Needs a key")
            self.assertEqual(blocked, [])

    def test_key_is_not_in_the_page_or_the_console_and_is_not_stored_without_remember(self):
        with open_batch_page() as (page, console_lines, _blocked):
            expect(panel(page).get_by_role("heading", name="Compare providers")).to_be_visible(timeout=LONG_MS)
            add_provider(page, "nebius")
            save_fake_key(page, "Nebius", remember=False)
            expect(row_for(page, "Nebius")).to_contain_text("Ready", timeout=SHORT_MS)
            self.assertNotIn(FAKE_KEY, page.content())
            self.assertFalse(any(FAKE_KEY in line for line in console_lines))
            stored = page.evaluate(f"() => localStorage.getItem('{KEY_STORAGE_NAME}')")
            self.assertIsNone(stored)

    def test_key_is_stored_only_when_remember_is_ticked_and_survives_a_reload(self):
        with open_batch_page() as (page, _console, _blocked):
            expect(panel(page).get_by_role("heading", name="Compare providers")).to_be_visible(timeout=LONG_MS)
            add_provider(page, "nebius")
            save_fake_key(page, "Nebius", remember=True)
            expect(row_for(page, "Nebius")).to_contain_text("Ready", timeout=SHORT_MS)
            stored = page.evaluate(f"() => localStorage.getItem('{KEY_STORAGE_NAME}')")
            self.assertIsNotNone(stored)
            page.reload()
            expect(panel(page).get_by_role("heading", name="Compare providers")).to_be_visible(timeout=LONG_MS)
            add_provider(page, "nebius")
            expect(row_for(page, "Nebius")).to_contain_text("Ready", timeout=SHORT_MS)
            self.assertNotIn(FAKE_KEY, page.content())

    def test_one_provider_only_is_ready_when_its_key_is_set_and_the_others_stay_blocked(self):
        with open_batch_page() as (page, _console, _blocked):
            expect(panel(page).get_by_role("heading", name="Compare providers")).to_be_visible(timeout=LONG_MS)
            for provider_id in ("groq", "together", "nebius"):
                add_provider(page, provider_id)
            expect(panel(page).locator("[role=status]").first).to_contain_text("0 of 3", timeout=SHORT_MS)
            save_fake_key(page, "Nebius", remember=False)
            expect(panel(page).locator("[role=status]").first).to_contain_text("1 of 3", timeout=SHORT_MS)
            expect(row_for(page, "Groq")).to_contain_text("Not available here")


if __name__ == "__main__":
    unittest.main()
