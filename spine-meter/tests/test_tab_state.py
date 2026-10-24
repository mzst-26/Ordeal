"""Browser tests that the three views keep their state when the visitor switches between them.

The tests serve site/ on 127.0.0.1 and abort every request to any other host. They use a fake key that
never leaves the browser, so no paid API call can be made. Nothing in the project is changed.

Run from the spine-meter folder:
    ../.venv-spine/bin/python -m unittest tests.test_tab_state -v
"""

import contextlib
import functools
import socket
import threading
import time
import unittest
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

PROJECT_DIR = Path(__file__).resolve().parent.parent
SITE_DIR = PROJECT_DIR / "site"
LOCAL_HOST = "127.0.0.1"
# Port 8791 is tried first so the address is predictable; any free port is used if it is taken.
PREFERRED_PORT = 8791
DESKTOP = {"width": 1280, "height": 800}
# Playwright wait limits in milliseconds: short for UI that reacts at once, long for loading the page data and a finished batch run.
SHORT_MS = 5000
LONG_MS = 10000
# Models and a question that have saved replies in site/data/sample_run.json, so the run needs no new calls.
SAVED_MODELS = ["Qwen/Qwen3-30B-A3B-Instruct-2507", "google/gemma-3-27b-it"]
SAVED_QUESTION = "c01"
FAKE_KEY = "tab-state-test-" + "k" * 13  # 30 characters, with no real key in it

# Module-level handles, set by setUpModule and cleared by tearDownModule, so one server and one browser serve every test.
_SERVER = None
_SERVER_THREAD = None
_PLAYWRIGHT = None
_BROWSER = None
_BASE_URL = ""


def pick_port():
    """Returns port 8791 when it is free on 127.0.0.1, otherwise any free port there."""
    for port in (PREFERRED_PORT, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((LOCAL_HOST, port))
            except OSError:
                continue
            return sock.getsockname()[1]
    raise RuntimeError("No free port on 127.0.0.1.")


def wait_for_server(url, timeout_s=15.0):
    """Polls the URL until it answers, so no test starts before the server is ready."""
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
    """Starts the static server on 127.0.0.1 and launches Chromium once for the whole module."""
    global _SERVER, _SERVER_THREAD, _PLAYWRIGHT, _BROWSER, _BASE_URL
    port = pick_port()
    _BASE_URL = f"http://{LOCAL_HOST}:{port}"
    handler = functools.partial(QuietHandler, directory=str(SITE_DIR))
    _SERVER = SiteServer((LOCAL_HOST, port), handler)
    _SERVER_THREAD = threading.Thread(target=_SERVER.serve_forever, daemon=True)
    _SERVER_THREAD.start()
    try:
        wait_for_server(_BASE_URL + "/index.html")
        _PLAYWRIGHT = sync_playwright().start()
        _BROWSER = _PLAYWRIGHT.chromium.launch()
    except Exception:
        tearDownModule()
        raise


def tearDownModule():
    """Closes the browser and stops the server that setUpModule started."""
    global _SERVER, _PLAYWRIGHT, _BROWSER
    if _BROWSER is not None:
        _BROWSER.close()
        _BROWSER = None
    if _PLAYWRIGHT is not None:
        _PLAYWRIGHT.stop()
        _PLAYWRIGHT = None
    if _SERVER is not None:
        _SERVER.shutdown()
        _SERVER.server_close()
        _SERVER = None


class QuietHandler(SimpleHTTPRequestHandler):
    """The static file handler, without a log line for every request."""

    def log_message(self, format, *args):
        """Does nothing, so the test output stays readable."""


class SiteServer(ThreadingHTTPServer):
    """A threaded server with a longer listen queue, so the page's many module requests are not reset."""

    request_queue_size = 64


class Session:
    """What one test page recorded: the page and the hosts that were blocked."""

    def __init__(self):
        self.page = None
        self.blocked = []


# The network guard: nothing but 127.0.0.1 may be reached, so the page can never contact the real API.
def guard_route(route, session):
    """Aborts every http, https, ws or wss request whose host is not 127.0.0.1, and records it."""
    parsed = urlparse(route.request.url)
    if parsed.scheme in ("http", "https", "ws", "wss") and parsed.hostname != LOCAL_HOST:
        session.blocked.append(route.request.url)
        route.abort()
    else:
        route.continue_()


@contextlib.contextmanager
# Each test gets its own browser context, so storage and history never leak between tests.
# On exit it fails the test if the guard blocked any outside request.
def open_page(path="/index.html"):
    """A fresh browser context and page for one test, with the network guard, opened at the given path."""
    context = _BROWSER.new_context(viewport=DESKTOP)
    session = Session()
    context.route("**/*", lambda route: guard_route(route, session))
    page = context.new_page()
    session.page = page
    page.goto(_BASE_URL + path, wait_until="load")
    try:
        yield session
    finally:
        context.close()
        assert session.blocked == [], f"Requests to hosts other than 127.0.0.1: {session.blocked}"


def visible_view(page):
    """Returns the data-view name of the section that is not hidden."""
    return page.locator("section[data-view]:not([hidden])").get_attribute("data-view")


def expect_view(page, view):
    """Waits until the given view is the one on screen."""
    expect(page.locator(f'section[data-view="{view}"]')).to_be_visible(timeout=SHORT_MS)


def checked_models(page):
    """Returns the values of the ticked model boxes on the Batch page, in page order."""
    return page.eval_on_selector_all(
        "#batch-model-list input[type=checkbox]:checked", "els => els.map(el => el.value)"
    )


def save_fake_key(page):
    """Opens the key dialog from the Key button, types the fake key, and saves it."""
    page.locator(".site-tools button", has_text="Key").first.click()
    dialog = page.locator("dialog.token-dialog")
    expect(dialog).to_be_visible(timeout=SHORT_MS)
    page.locator("#token-dialog-field").fill(FAKE_KEY)
    dialog.get_by_role("button", name="Save key").click()
    expect(dialog).to_be_hidden(timeout=SHORT_MS)


def press_batch_start(page):
    """Presses Start on the Batch page and gets past the key and the confirmation step, if they appear."""
    # The site currently repeats these two ids, so the first match is the one the page script binds to.
    page.locator("#batch-start-button").first.click()
    dialog = page.locator("dialog.token-dialog")
    if dialog.count() and dialog.is_visible():
        page.locator("#token-dialog-field").fill(FAKE_KEY)
        dialog.get_by_role("button", name="Save key").click()
    confirm = page.locator("#confirm-continue").first
    expect(confirm).to_be_visible(timeout=SHORT_MS)
    confirm.click()


# Test names start with a_, b_, c_, and unittest runs them in that order. Group proves the site is a single page whose views
# (Gauntlet, Batch, Live) keep their data and the URL hash in step while the visitor switches between them.
class TabStateTests(unittest.TestCase):
    """Checks that switching views keeps the batch run, the key status and the history in step."""

    # Guards against losing the batch selection and run status when the visitor leaves the Batch view and returns.
    def test_a_batch_state_survives_view_switch(self):
        """Ticked models and the batch status line are the same after switching to Gauntlet and back."""
        with open_page("/index.html#batch") as session:
            page = session.page
            expect_view(page, "batch")
            expect(page.locator("#batch-model-list label.check").first).to_be_visible(timeout=LONG_MS)
            page.locator("#model-clear").click()
            for model_id in SAVED_MODELS:
                page.locator(f'#batch-model-list label.check:has(input[value="{model_id}"])').click()
            page.locator(f'#question-list label.check:has(input[value="{SAVED_QUESTION}"])').click()
            ticked = checked_models(page)
            self.assertEqual(len(ticked), 2, "Two models should be ticked before the switch")

            press_batch_start(page)
            status = page.locator("#batch-status-line")
            # A saved run finishes at once, so wait for the finished line before recording it.
            expect(status).to_contain_text("Finished", timeout=LONG_MS)
            status_before = status.text_content()

            page.locator('a[data-nav-view="gauntlet"]').click()
            expect_view(page, "gauntlet")
            page.locator('a[data-nav-view="batch"]').click()
            expect_view(page, "batch")

            self.assertEqual(checked_models(page), ticked, "Ticked models changed after a view switch")
            self.assertEqual(status.text_content(), status_before, "Batch status line changed after a view switch")

    # Guards the key status across views, and that the key itself is never written into the page HTML.
    def test_b_key_status_survives_view_switch(self):
        """Key status reads Key saved after a view switch, and the fake key is not in the page HTML."""
        with open_page("/index.html#gauntlet") as session:
            page = session.page
            expect_view(page, "gauntlet")
            save_fake_key(page)
            expect(page.locator(".key-status")).to_have_text("Key saved", timeout=SHORT_MS)

            page.locator('a[data-nav-view="live"]').click()
            expect_view(page, "live")
            page.locator('a[data-nav-view="gauntlet"]').click()
            expect_view(page, "gauntlet")

            expect(page.locator(".key-status")).to_have_text("Key saved", timeout=SHORT_MS)
            self.assertNotIn(FAKE_KEY, page.content(), "The fake key appears in the page HTML")

    # Guards browser history: the hash, the visible section and the Back button always agree.
    def test_c_history_matches_visible_view(self):
        """After Gauntlet, Batch, Live and two Backs, the hash and the visible view agree at each step."""
        with open_page("/index.html#gauntlet") as session:
            page = session.page
            steps = [
                ("open Gauntlet", None, "gauntlet"),
                ("go to Batch", 'a[data-nav-view="batch"]', "batch"),
                ("go to Live", 'a[data-nav-view="live"]', "live"),
                ("Back once", "back", "batch"),
                ("Back twice", "back", "gauntlet"),
            ]
            for step, action, expected in steps:
                with self.subTest(step=step):
                    if action == "back":
                        page.go_back()
                    elif action is not None:
                        page.locator(action).click()
                    expect_view(page, expected)
                    self.assertEqual(page.evaluate("() => location.hash"), f"#{expected}")
                    self.assertEqual(visible_view(page), expected)


if __name__ == "__main__":
    unittest.main()
