"""Browser tests for the comparison page (site/compare.html), run in Chromium through Playwright.

The tests serve site/ on 127.0.0.1 and abort every request to any other host. A page that tries
to reach the network therefore fails the test. The expected values come from the real
site/data/compare/results.json, and the only file written is the set of screenshots in the
scratchpad folder. Nothing in the project is changed.

Run from the spine-meter folder:
    .venv-spine/bin/python -m unittest tests.test_compare_browser -v
"""

import contextlib
import json
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

PROJECT_DIR = Path(__file__).resolve().parent.parent
SITE_DIR = PROJECT_DIR / "site"
RESULTS_PATH = SITE_DIR / "data" / "compare" / "results.json"
# The screenshots are the only files these tests write, and the folder is outside the project.
SCREENSHOT_DIR = Path(
    "/private/tmp/claude-501/-Users-mobinzaki-Github-Hacktest/086e93f4-bbdc-43a6-b76c-2a6c2a5f2c65/scratchpad/compare-shots"
)
LOCAL_HOST = "127.0.0.1"
PREFERRED_PORT = 8790
DESKTOP = {"width": 1280, "height": 800}
PHONE = {"width": 390, "height": 844}
SHORT_MS = 5000
LONG_MS = 10000
# Longest wait for the transcript replay to play to its end on its own (the replay is animated, so it is slow).
REPLAY_MS = 90000
HOLD_LIMIT = 0.5  # the survivors figure counts a model as holding at or below 50% (fig-survivors.js)
# The note the mitigation figure shows when the results file has no data for the chosen condition.
MITIGATION_NOTE = "No saved data for this condition, so every bar shows not run."

# Module-level handles, set by setUpModule and cleared by tearDownModule. _DATA is the real results.json,
# so expected values are computed from the same data the page loads.
_SERVER = None
_PLAYWRIGHT = None
_BROWSER = None
_BASE_URL = ""
_DATA = {}


def pick_port():
    """Returns port 8790 when it is free on 127.0.0.1, otherwise any free port there."""
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
    global _SERVER, _PLAYWRIGHT, _BROWSER, _BASE_URL, _DATA
    port = pick_port()
    _BASE_URL = f"http://{LOCAL_HOST}:{port}"
    _DATA = json.loads(RESULTS_PATH.read_text(encoding="utf-8"))
    _SERVER = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", LOCAL_HOST, "--directory", str(SITE_DIR)],
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


# The tests run with a network guard, so a page that reaches any other host fails (recorded in blocked).
class Session:
    """What one test page recorded: console errors, page errors, failed requests and blocked hosts."""

    def __init__(self):
        self.page = None
        self.console_errors = []
        self.page_errors = []
        self.failed = []
        self.blocked = []


def guard_route(route, session):
    """Aborts every http, https, ws or wss request whose host is not 127.0.0.1, and records it."""
    parsed = urlparse(route.request.url)
    if parsed.scheme in ("http", "https", "ws", "wss") and parsed.hostname != LOCAL_HOST:
        session.blocked.append(route.request.url)
        route.abort()
    else:
        route.continue_()


@contextlib.contextmanager
# Only console messages of type error are kept, so ordinary logging does not fail a test.
def open_page(viewport=DESKTOP, color_scheme="light"):
    """A fresh browser context and page for one test, with the network guard and event recording."""
    context = _BROWSER.new_context(viewport=viewport, color_scheme=color_scheme)
    session = Session()
    context.route("**/*", lambda route: guard_route(route, session))
    page = context.new_page()
    session.page = page
    page.on(
        "console",
        lambda message: session.console_errors.append(f"{message.text} @ {message.location}")
        if message.type == "error"
        else None,
    )
    page.on("pageerror", lambda error: session.page_errors.append(str(error)))
    page.on("requestfailed", lambda request: session.failed.append(f"{request.url} ({request.failure})"))
    try:
        yield session
    finally:
        context.close()


def load_ready(page, path="/compare.html"):
    """Opens the page and waits until the filter count shows every model, which means boot has finished."""
    page.goto(_BASE_URL + path, wait_until="load")
    total = len(_DATA["models"])
    expect(page.locator("#filter-count")).to_have_text(f"{total} of {total} models shown", timeout=LONG_MS)


def model_by_family(family):
    """The first model of a family in the results file."""
    return next(model for model in _DATA["models"] if model.get("family") == family)


def axis_label(axis_id):
    """The label of a fingerprint axis, as the page shows it."""
    return next(axis["label"] for axis in _DATA["axes"] if axis["id"] == axis_id)


def expected_survivors_sentence(level):
    """The survivors count at a level, computed from the flip curves: held at or below 50%, not-run left out."""
    held = 0
    flipped = 0
    for model in _DATA["models"]:
        point = next((entry for entry in model["flip_curve"] if entry["level"] == level), None)
        value = point["rate"]["rate"] if point and point["rate"] else None
        if value is None:
            continue
        if value <= HOLD_LIMIT:
            held += 1
        else:
            flipped += 1
    return f"{held} of {held + flipped} still holding at level {level}."


def set_range(page, selector, value):
    """Sets a range input to a value and fires the input event that the page listens for."""
    page.locator(selector).evaluate(
        "(el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }",
        value,
    )


# Test groups: boot without errors; filters, sorting and the survivors slider against values computed from results.json;
# head-to-head, replay, mitigation and model card interactions; keyboard use of the heatmap; layout at phone width; screenshots.
class CompareBrowserTests(unittest.TestCase):
    """Browser checks for the comparison page. Each test opens its own fresh page."""

    def test_page_loads_offline_without_console_errors(self):
        """The page boots at 1280 px with every figure mounted, and makes no console error or failed request."""
        with open_page(DESKTOP) as session:
            load_ready(session.page)
            session.page.wait_for_load_state("networkidle")
            figure_texts = session.page.locator(".figure-root").all_inner_texts()
            stuck = [
                text for text in figure_texts
                if "Loading the figure" in text or "Not built yet" in text or "could not start" in text
            ]
            self.assertEqual(stuck, [], "Figures that did not mount")
            self.assertEqual(session.console_errors, [], "Console errors")
            self.assertEqual(session.page_errors, [], "Uncaught page errors")
            self.assertEqual(session.failed, [], "Failed requests")
            self.assertEqual(session.blocked, [], "Requests to hosts other than 127.0.0.1")

    def test_each_filter_changes_the_count(self):
        """Each filter moves the "N of 3 models shown" count to the value the data implies, and reset restores 3 of 3."""
        total = len(_DATA["models"])
        # Each case: label, the action, the expected shown count, and why.
        cases = [
            (
                "family chip: untick Gemma",
                lambda p: p.locator("#filter-family .filter-chip", has_text="Gemma").click(),
                2,
                "Gemma is one of three families, so unticking it leaves Qwen and Nemotron.",
            ),
            (
                "search: gemma",
                lambda p: p.fill("#filter-search", "gemma"),
                1,
                "Only the Gemma model's name or ID contains 'gemma'.",
            ),
            (
                "search: no match",
                lambda p: p.fill("#filter-search", "zzz"),
                0,
                "No model name or ID contains 'zzz'.",
            ),
            (
                "size slider: up to 50 B",
                lambda p: set_range(p, "#filter-size", 50),
                2,
                "Qwen (30 B) and Gemma (27 B) are at or under 50 B; Nemotron (120 B) is not.",
            ),
            (
                "reasoning select: reasoning models",
                lambda p: p.select_option("#filter-reasoning", "yes"),
                0,
                "No model is recorded as a reasoning model: Qwen and Gemma are false, and Nemotron is unknown (null), which fails a yes or no choice.",
            ),
            (
                "reasoning select: non-reasoning models",
                lambda p: p.select_option("#filter-reasoning", "no"),
                2,
                "Qwen and Gemma are recorded as non-reasoning. Nemotron is unknown (null), so it is hidden.",
            ),
            (
                "open-weights select: closed weights",
                lambda p: p.select_option("#filter-open", "no"),
                0,
                "All three models have open weights, so none passes a closed-weights choice.",
            ),
            (
                "open-weights select: open weights",
                lambda p: p.select_option("#filter-open", "yes"),
                total,
                "All three models have open weights, so every model passes.",
            ),
            (
                "low-sample checkbox: unticked",
                lambda p: p.click("label[for=filter-lowsample]"),
                total,
                "No model has the low-sample gate set (every cell has n of at least 15), so showing low-sample models changes nothing with this data.",
            ),
        ]
        for label, action, shown, reason in cases:
            with self.subTest(filter=label, reason=reason):
                with open_page(DESKTOP) as session:
                    page = session.page
                    load_ready(page)
                    action(page)
                    expect(page.locator("#filter-count")).to_have_text(
                        f"{shown} of {total} models shown", timeout=SHORT_MS
                    )
                    page.click("#filter-reset")
                    expect(page.locator("#filter-count")).to_have_text(
                        f"{total} of {total} models shown", timeout=SHORT_MS
                    )
                    expect(page.locator("#filter-search")).to_have_value("")

        # The condition control does not change the count. It changes the mitigation figure instead.
        with self.subTest(filter="condition: mitigation", reason="The count stays 3 of 3, and FIG 7 shows the mitigation prompt."):
            with open_page(DESKTOP) as session:
                page = session.page
                load_ready(page)
                page.locator("#filter-condition .segmented-option", has_text="Mitigation").click()
                expect(page.locator("#fig-mitigation .fg-caption")).to_contain_text(
                    _DATA["mitigation_prompts"]["mitigation"], timeout=SHORT_MS
                )
                expect(page.locator("#filter-count")).to_have_text(f"{total} of {total} models shown")

    def test_heatmap_column_sort_and_reverse(self):
        """Clicking the Bare assertion header sorts the rows highest first; clicking it again reverses them."""
        models = _DATA["models"]
        bare = {model["id"]: model["fingerprint"]["bare"]["rate"] for model in models}
        names = {model["id"]: model["display_name"] for model in models}
        ids_by_rate_desc = sorted(bare, key=lambda model_id: -bare[model_id])
        desc_names = [names[model_id] for model_id in ids_by_rate_desc]
        asc_names = list(reversed(desc_names))
        initial_names = [model["display_name"] for model in models]
        self.assertNotEqual(initial_names, desc_names, "The sort must change the order, so the check is meaningful")

        with open_page(DESKTOP) as session:
            page = session.page
            load_ready(page)
            rows = page.locator("#fig-fingerprint-root .fp-grid tbody th.fp-rowhead .fp-rowname")
            header = page.locator(
                "#fig-fingerprint-root .fp-grid thead th.fp-th",
                has=page.locator("button.fp-sort", has_text=axis_label("bare")),
            )
            expect(rows).to_have_text(initial_names, timeout=SHORT_MS)

            header.locator("button.fp-sort").click()
            expect(header).to_have_attribute("aria-sort", "descending", timeout=SHORT_MS)
            expect(rows).to_have_text(desc_names, timeout=SHORT_MS)

            header.locator("button.fp-sort").click()
            expect(header).to_have_attribute("aria-sort", "ascending", timeout=SHORT_MS)
            expect(rows).to_have_text(asc_names, timeout=SHORT_MS)

    def test_survivors_slider_changes_count(self):
        """The survivors slider moves from level 1 to the top level, and the count follows the flip curves."""
        top = _DATA["level_count"]
        with open_page(DESKTOP) as session:
            page = session.page
            load_ready(page)
            slider = page.locator("#fig-survivors-root input[type=range]")
            count = page.locator("#fig-survivors-root .sv-count")
            expect(count).to_have_text(expected_survivors_sentence(top), timeout=SHORT_MS)

            slider.focus()
            page.keyboard.press("Home")
            expect(slider).to_have_attribute("aria-valuetext", "Level 1 of 10", timeout=SHORT_MS)
            expect(count).to_have_text(expected_survivors_sentence(1), timeout=SHORT_MS)

            page.keyboard.press("End")
            expect(slider).to_have_attribute("aria-valuetext", f"Level {top} of {top}", timeout=SHORT_MS)
            expect(count).to_have_text(expected_survivors_sentence(top), timeout=SHORT_MS)

    def test_head_to_head_and_replay(self):
        """FIG 4 draws its radar and table, and the example button opens FIG 5 on the Gemma oracle transcript."""
        gemma = model_by_family("Gemma")
        oracle_runs = [t for t in gemma["transcripts"] if t["axis"] == "oracle"]
        expected_stamp = "HELD" if oracle_runs[0]["outcome"] == "held" else "FOLDED"
        with open_page(DESKTOP) as session:
            page = session.page
            load_ready(page)
            expect(page.locator("#fig-h2h-root table.h2h-table")).to_be_visible(timeout=SHORT_MS)
            expect(page.locator("#fig-h2h-root svg.h2h-radar")).to_be_visible()
            # One row per metric in fig-h2h.js METRICS: eight numbers plus the units row.
            expect(page.locator("#fig-h2h-root table.h2h-table tbody tr")).to_have_count(9)

            example = page.locator("#fig-h2h-root button", has_text="Show me a real example")
            expect(example).to_be_enabled()
            example.click()

            expect(page.locator("#replay-model")).to_have_value(gemma["id"], timeout=SHORT_MS)
            expect(page.locator("#fig-replay .replay-meta")).to_contain_text(
                f"Transcript 1 of {len(oracle_runs)} for {axis_label('oracle')}", timeout=SHORT_MS
            )
            expect(page.locator("#fig-replay .replay-stamp")).to_have_text(expected_stamp, timeout=REPLAY_MS)
            # The example sets the stamp only once playback ends. Skip, then confirm the stamp is shown.
            page.locator("#fig-replay button", has_text="Skip to the end").click()
            expect(page.locator("#fig-replay .replay-stamp")).to_be_visible(timeout=SHORT_MS)
            expect(page.locator("#fig-replay .replay-stamp")).to_have_text(expected_stamp)

    def test_transcript_replay_reaches_stamp_without_skip(self):
        """The replay plays on its own from the first transcript of the first model to its HELD or FOLDED stamp."""
        first = next(model for model in _DATA["models"] if model["transcripts"])
        first_outcome = first["transcripts"][0]["outcome"]
        expected_stamp = "HELD" if first_outcome == "held" else "FOLDED"
        with open_page(DESKTOP) as session:
            page = session.page
            load_ready(page)
            stamp = page.locator("#fig-replay .replay-stamp")
            expect(stamp).to_be_visible(timeout=REPLAY_MS)
            expect(stamp).to_have_text(expected_stamp)
            expect(page.locator("#fig-replay .replay-status")).to_have_text("Finished.", timeout=SHORT_MS)

    def test_replay_skip_jumps_to_the_stamp(self):
        """Skip to the end shows the stamp at once, without waiting for playback."""
        first = next(model for model in _DATA["models"] if model["transcripts"])
        first_outcome = first["transcripts"][0]["outcome"]
        expected_stamp = "HELD" if first_outcome == "held" else "FOLDED"
        with open_page(DESKTOP) as session:
            page = session.page
            load_ready(page)
            page.locator("#fig-replay button", has_text="Skip to the end").click()
            stamp = page.locator("#fig-replay .replay-stamp")
            expect(stamp).to_be_visible(timeout=SHORT_MS)
            expect(stamp).to_have_text(expected_stamp)

    def test_mitigation_toggle_changes_bars(self):
        """With no mitigation or control data, every FIG 7 bar reads not run and has no width."""
        mitigation_prompts = _DATA["mitigation_prompts"]
        with open_page(DESKTOP) as session:
            page = session.page
            load_ready(page)
            values = page.locator("#fig-mitigation-root .mit-value")
            fills = page.locator("#fig-mitigation-root .mit-fill")
            expect(values.first).to_have_text(re.compile(r"\d+%"), timeout=SHORT_MS)

            for condition, label in (("mitigation", "Mitigation"), ("control", "Control")):
                with self.subTest(condition=condition):
                    page.locator("#fig-mitigation-root .mit-switch label", has_text=label).click()
                    expect(page.locator(f"#fig-mitigation-root input[value={condition}]")).to_be_checked()
                    expect(page.locator("#filter-condition input[value=%s]" % condition)).to_be_checked()
                    expect(values).to_have_text(["not run"] * len(_DATA["models"]), timeout=SHORT_MS)
                    widths = fills.evaluate_all("els => els.map(el => el.getBoundingClientRect().width)")
                    self.assertTrue(all(width <= 0 for width in widths), f"Bar widths for {condition}: {widths}")
                    expect(page.locator("#fig-mitigation-root p", has_text=MITIGATION_NOTE)).to_be_visible(
                        timeout=SHORT_MS
                    )
                    expect(page.locator("#fig-mitigation-root .fg-caption")).to_contain_text(
                        mitigation_prompts[condition], timeout=SHORT_MS
                    )

    def test_model_card_opens_and_esc_closes(self):
        """A click on a FIG 1 point opens the Model Card, and Escape closes it."""
        gemma = model_by_family("Gemma")
        with open_page(DESKTOP) as session:
            page = session.page
            load_ready(page)
            card = page.locator("#model-card")
            # The point's group box includes its label, so its centre can fall on empty space. Click the circle,
            # after centring it, because the sticky filter bar would otherwise cover it.
            circle = page.locator(f'#fig-scatter-root g.scatter-point[data-id="{gemma["id"]}"] circle')
            circle.evaluate("el => el.scrollIntoView({ block: 'center' })")
            circle.click()
            expect(card).to_have_class(re.compile(r"\bis-open\b"), timeout=SHORT_MS)
            expect(card).to_be_visible(timeout=SHORT_MS)
            expect(page.locator("#model-card-title")).to_have_text(gemma["display_name"], timeout=SHORT_MS)

            page.keyboard.press("Escape")
            expect(card).not_to_have_class(re.compile(r"\bis-open\b"), timeout=SHORT_MS)
            expect(card).to_be_hidden(timeout=SHORT_MS)

    def test_keyboard_only_fig2(self):
        """With the keyboard alone: Tab reaches FIG 2, Enter sorts, and the arrow keys move between cells."""
        axis_ids = [axis["id"] for axis in _DATA["axes"] if axis["family"] == "fingerprint"]
        with open_page(DESKTOP) as session:
            page = session.page
            load_ready(page)

            def focus_is(selector):
                return page.evaluate("(sel) => !!document.activeElement && document.activeElement.matches(sel)", selector)

            def tab_until(selector, limit=200):
                for _ in range(limit):
                    page.keyboard.press("Tab")
                    if focus_is(selector):
                        return True
                return False

            self.assertTrue(tab_until("#fig-fingerprint .fp-sort"), "Tab did not reach a FIG 2 header button")
            page.keyboard.press("Enter")
            # Enter on the focused header sorts the rows, and the focused header's cell reports the direction.
            expect(
                page.locator("#fig-fingerprint-root .fp-grid thead th.fp-th", has=page.locator("button.fp-sort:focus"))
            ).to_have_attribute("aria-sort", "descending", timeout=SHORT_MS)
            rows = page.locator("#fig-fingerprint-root .fp-grid tbody th.fp-rowhead .fp-rowname")
            bare = {model["id"]: model["fingerprint"]["bare"]["rate"] for model in _DATA["models"]}
            names = {model["id"]: model["display_name"] for model in _DATA["models"]}
            expected_names = [names[i] for i in sorted(bare, key=lambda i: -bare[i])]
            expect(rows).to_have_text(expected_names, timeout=SHORT_MS)

            self.assertTrue(tab_until("#fig-fingerprint td.fp-cell"), "Tab did not reach a FIG 2 cell")

            def cell_position():
                return page.evaluate(
                    "() => { const c = document.activeElement; return { row: c.dataset.row, col: c.dataset.col }; }"
                )

            start = cell_position()
            col_index = axis_ids.index(start["col"])
            page.keyboard.press("ArrowRight")
            after_right = cell_position()
            self.assertEqual(after_right["row"], start["row"], "ArrowRight should stay on the same row")
            self.assertEqual(after_right["col"], axis_ids[col_index + 1], "ArrowRight should move one column right")

            page.keyboard.press("ArrowLeft")
            self.assertEqual(cell_position(), start, "ArrowLeft should move back to the starting cell")

            page.keyboard.press("ArrowDown")
            after_down = cell_position()
            self.assertNotEqual(after_down["row"], start["row"], "ArrowDown should change the row")
            self.assertEqual(after_down["col"], start["col"], "ArrowDown should stay in the same column")

            page.keyboard.press("ArrowUp")
            self.assertEqual(cell_position(), start, "ArrowUp should move back to the starting cell")

    def test_no_horizontal_scroll_at_390px(self):
        """The document is no wider than the window at 390 px and at 1280 px."""
        for viewport in (PHONE, DESKTOP):
            with self.subTest(width=viewport["width"], height=viewport["height"]):
                with open_page(viewport) as session:
                    load_ready(session.page)
                    measure = session.page.evaluate(
                        "() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })"
                    )
                    self.assertLessEqual(
                        measure["scroll"],
                        measure["inner"],
                        f"scrollWidth {measure['scroll']} is wider than innerWidth {measure['inner']}",
                    )

    def test_screenshots_saved_at_both_widths_and_dark(self):
        """Full-page screenshots at 1280 px, 390 px and a dark-mode 1280 px are saved, and dark mode really changes the page."""
        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
        shots = [
            ("compare-1280x800-light-full.png", DESKTOP, "light"),
            ("compare-390x844-light-full.png", PHONE, "light"),
            ("compare-1280x800-dark-full.png", DESKTOP, "dark"),
        ]
        backgrounds = {}
        for name, viewport, scheme in shots:
            with self.subTest(shot=name):
                with open_page(viewport, color_scheme=scheme) as session:
                    page = session.page
                    load_ready(page)
                    path = SCREENSHOT_DIR / name
                    page.screenshot(path=str(path), full_page=True)
                    self.assertTrue(path.exists() and path.stat().st_size > 0, f"No screenshot at {path}")
                    backgrounds[scheme] = page.evaluate("() => getComputedStyle(document.body).backgroundColor")
        self.assertNotEqual(backgrounds.get("light"), backgrounds.get("dark"), "Dark mode did not change the background")


if __name__ == "__main__":
    unittest.main()
