"""Browser test for the comparison views (FIG. 8) on the compare page, run in Chromium through Playwright.

The test builds the site, serves dist/ on 127.0.0.1, and loads compare.html with the Content-Security-Policy from
netlify.toml added to each response. The site's real CSP is not applied by the local server, so this test adds it.
A CSP violation is then a console error, and the test fails on any. It turns on "Differences only", checks that Vega
draws a chart, and checks that the page injected no style element. Requests to any other host are aborted.
Nothing in the project is changed; the built site is the only output, as in test_compare_browser.py.

Run from the project folder:
    .venv-spine/bin/python -m unittest tests.python.test_compare_views_browser -v
"""

import re
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
NETLIFY_TOML = PROJECT_DIR / "netlify.toml"
RESULTS_PATH = PROJECT_DIR / "frontend" / "data" / "compare" / "results.json"
LOCAL_HOST = "127.0.0.1"
PREFERRED_PORT = 8791
DESKTOP = {"width": 1280, "height": 800}
LONG_MS = 15000
# The note shown under FIG. 8 when differences only is on and at least one dimension varies.
DIFFERENCES_NOTE_START = "Showing the varying dimension:"

# Module-level handles, set by setUpModule and cleared by tearDownModule.
_SERVER = None
_PLAYWRIGHT = None
_BROWSER = None
_BASE_URL = ""
_POLICY = ""


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


def content_security_policy():
    """The Content-Security-Policy value from netlify.toml, with its line continuations joined into one line.

    Reading it from the file means this test checks the policy the site really ships, not a copy of it.
    """
    text = NETLIFY_TOML.read_text(encoding="utf-8")
    match = re.search(r'Content-Security-Policy = """\\\n(.*?)"""', text, re.DOTALL)
    if match is None:
        raise RuntimeError("netlify.toml has no Content-Security-Policy block to test against.")
    joined = match.group(1).replace("\\\n", " ")
    return " ".join(joined.split())


def build_site():
    """Builds the static site into dist/ with npm run build. Raises CalledProcessError if the build fails."""
    subprocess.run(["npm", "run", "build"], cwd=PROJECT_DIR, check=True, capture_output=True, text=True)


def setUpModule():
    """Builds the site, starts the static server on 127.0.0.1 and launches Chromium once for the module."""
    build_site()
    global _SERVER, _PLAYWRIGHT, _BROWSER, _BASE_URL, _POLICY
    port = pick_port()
    _BASE_URL = f"http://{LOCAL_HOST}:{port}"
    _POLICY = content_security_policy()
    _SERVER = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", LOCAL_HOST, "--directory", str(DIST_DIR)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_for_server(_BASE_URL + "/compare.html")
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
        _SERVER.terminate()
        try:
            _SERVER.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _SERVER.kill()
        _SERVER = None


def serve_with_policy(route):
    """Aborts any request to another host. For the local site, adds the shipped Content-Security-Policy to the response."""
    parsed = urlparse(route.request.url)
    if parsed.scheme in ("http", "https", "ws", "wss") and parsed.hostname != LOCAL_HOST:
        route.abort()
        return
    response = route.fetch()
    headers = dict(response.headers)
    headers["content-security-policy"] = _POLICY
    route.fulfill(response=response, headers=headers)


class CompareViewsBrowserTest(unittest.TestCase):
    """One scenario: open the compare page under the real CSP, turn on differences only, and check the chart."""

    def test_differences_only_draws_a_vega_chart_with_no_csp_errors(self):
        """Vega draws the small multiples, the differences-only note appears, and the console has no errors."""
        console_errors = []
        page_errors = []
        context = _BROWSER.new_context(viewport=DESKTOP)
        context.route("**/*", serve_with_policy)
        page = context.new_page()
        page.on(
            "console",
            lambda message: console_errors.append(f"{message.text} @ {message.location}")
            if message.type == "error"
            else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        try:
            page.goto(_BASE_URL + "/compare.html", wait_until="load")
            chart = page.locator("#fig-views-root .views-chart svg")
            expect(chart).to_have_count(1, timeout=LONG_MS)
            self.assertGreater(page.locator("#fig-views-root .views-chart .mark-symbol").count(), 0)

            page.locator("label[for='filter-differences']").click()
            expect(page.locator("#fig-views-root p.field-hint")).to_contain_text(
                DIFFERENCES_NOTE_START, timeout=LONG_MS,
            )
            expect(chart).to_have_count(1, timeout=LONG_MS)
            # Hovering a mark runs Vega's tooltip handler, which must use the page's own tooltip and no injected style.
            page.locator("#fig-views-root .views-chart .mark-symbol path").first.hover()
            expect(page.locator("#compare-tooltip")).to_contain_text("Flip rate at last level", timeout=LONG_MS)
            injected_styles = page.evaluate("document.querySelectorAll('style').length")
        finally:
            context.close()

        self.assertEqual(console_errors, [], "the page logged console errors")
        self.assertEqual(page_errors, [], "the page raised uncaught errors")
        self.assertEqual(injected_styles, 0, "the page injected a style element, which style-src 'self' would block")
