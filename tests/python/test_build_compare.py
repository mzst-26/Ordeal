"""Tests for scripts/build_compare.py, run on the fixtures in tests/python/fixtures/compare.

The fixtures hold five fake models: alpha (normal), bravo (no mitigation and no twin data, every
baseline wrong), charlie (low sample), delta (data warning, quote_mine not run) and echo (final-correct
check fails, no transcripts, no metadata entry). Question ids are real ids from questions.json, because
the builder checks baseline answers against that file. Every run writes into a temporary folder. The real
results/ and frontend/ folders are only listed before and after, never written.
"""

import contextlib
import csv
import hashlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

PROJECT_DIR = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = PROJECT_DIR / "scripts"
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "compare"
sys.path.insert(0, str(SCRIPTS_DIR))
sys.path.insert(0, str(PROJECT_DIR))

import build_compare  # noqa: E402
from ordeal import core  # noqa: E402
from ordeal import grade  # noqa: E402

ALPHA = "fake/alpha-7b"
BRAVO = "fake/bravo-no-extras"
CHARLIE = "fake/charlie-low-sample"
DELTA = "fake/delta-data-warning"
ECHO = "fake/echo-bad-final"
# GHOST has replies in the fixture cache under another experiment code; the builder must ignore it.
GHOST = "fake/ghost-other-experiment"
# Token in the fixture cache that setUp replaces with the real experiment code of the suite.
PLACEHOLDER = "__EXPERIMENT__"
# Exact key sets of the output contract: a transcript, and a rate (rate, confidence bounds, sample size).
TRANSCRIPT_KEYS = {"axis", "question_id", "repeat", "messages", "reply", "outcome", "confession"}
RATE_KEYS = {"rate", "ci_low", "ci_high", "n"}
# A rate for data that was not run: every field is null, never 0, so the page can show "not run".
EMPTY_RATE = {"rate": None, "ci_low": None, "ci_high": None, "n": None}
# A fake key-shaped string, used to check that the builder refuses output that looks like it holds an API key.
FAKE_SK_KEY = "sk-" + "abcdefghijklmnopqrst"
# A minimal page with the data script element, used to test embedding the data into compare.html.
PAGE_HEAD = '<!doctype html>\n<html><body><p>Before the data.</p>\n<script id="compare-data" type="application/json">[]</script>\n<p>After the data.</p></body></html>\n'


def file_digest(path):
    """Return the SHA-256 of a file, or None when it does not exist."""
    if not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


# Used to prove that the real results/ and frontend/ folders are not written by the tests.
def snapshot(folder):
    """Return the file names, sizes and modification times under a folder, so writes can be detected."""
    if not folder.exists():
        return []
    return sorted(
        (str(path.relative_to(folder)), path.stat().st_size, path.stat().st_mtime_ns)
        for path in folder.rglob("*")
        if path.is_file()
    )


# Test groups, by the section markers below: outputs and paths; nulls stay null; gates and warnings;
# transcript selection; backbone, personality and twins; then the safety refusals (bad inputs, key-like text, output location).
class BuildCompareTests(unittest.TestCase):
    """Each test builds the results file in a temporary folder from the fixtures and checks the result."""

    @classmethod
    def setUpClass(cls):
        """Work out the experiment code of the suite, the same way the builder does."""
        cls.experiment = core.load_suite(ladder="gauntlet_v3", questions="easy").experiment
        cls.questions = {q["id"]: q for q in core.load_questions()}

    def setUp(self):
        """Copy the fixtures into a temporary folder and point the builder at it."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.results_dir = self.root / "results"
        self.frontend_dir = self.root / "frontend"
        self.results_dir.mkdir()
        (self.frontend_dir / "data").mkdir(parents=True)
        shutil.copy(FIXTURES_DIR / "results.csv", self.results_dir / "results.csv")
        shutil.copy(FIXTURES_DIR / "probes.csv", self.results_dir / "probes.csv")
        self.write_cache(self.cache_text())
        self.models_path = self.root / "models.json"
        shutil.copy(FIXTURES_DIR / "models.json", self.models_path)
        self.config_path = self.root / "config_subset.json"
        shutil.copy(FIXTURES_DIR / "config_subset.json", self.config_path)
        self.out_path = self.frontend_dir / "data" / "compare" / "results.json"
        self.page_path = self.frontend_dir / "compare.html"

    def tearDown(self):
        """Delete the temporary folder."""
        self.temp_dir.cleanup()

    def cache_text(self):
        """Return the fixture cache with the experiment code of the current suite filled in."""
        return (FIXTURES_DIR / "cache.jsonl").read_text(encoding="utf-8").replace(PLACEHOLDER, self.experiment)

    def write_cache(self, text):
        """Write a cache file into the temporary results folder."""
        (self.results_dir / "cache.jsonl").write_text(text, encoding="utf-8")

    def run_build(self, *extra):
        """Run main() on the temporary folders. Return the exit code, printed output and error output."""
        output, errors = io.StringIO(), io.StringIO()
        args = [
            "--results-dir", str(self.results_dir),
            "--frontend-dir", str(self.frontend_dir),
            "--models", str(self.models_path),
            "--out", str(self.out_path),
            "--config", str(self.config_path),
            *extra,
        ]
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            code = build_compare.main(args)
        return code, output.getvalue(), errors.getvalue()

    def build(self):
        """Build with no page and return the parsed data file."""
        code, _, errors = self.run_build()
        self.assertEqual(code, 0, errors)
        return json.loads(self.out_path.read_text(encoding="utf-8"))

    def models(self, data):
        """Return the model entries keyed by id."""
        return {model["id"]: model for model in data["models"]}

    def fixture_probe_rows(self, model, family, measure):
        """Return the fixture probe rows of one model, family and measure, read with the csv module."""
        with open(FIXTURES_DIR / "probes.csv", newline="", encoding="utf-8") as file:
            return [
                row for row in csv.DictReader(file)
                if row["model"] == model and row["family"] == family and row["measure"] == measure
                and row["condition"] == "none"
            ]

    # ------------------------------------------------------------ outputs and paths

    def test_writes_only_inside_the_temp_folder(self):
        """The real results/ and frontend/ folders are unchanged, and the output lands in the temporary folder."""
        real_results = snapshot(PROJECT_DIR / "results")
        real_site_data = snapshot(PROJECT_DIR / "frontend" / "data")
        real_page = file_digest(PROJECT_DIR / "frontend" / "compare.html")
        self.build()
        self.assertTrue(self.out_path.is_file())
        self.assertEqual(real_results, snapshot(PROJECT_DIR / "results"))
        self.assertEqual(real_site_data, snapshot(PROJECT_DIR / "frontend" / "data"))
        self.assertEqual(real_page, file_digest(PROJECT_DIR / "frontend" / "compare.html"))

    def test_top_level_keys_and_fixed_values(self):
        """The top-level keys match section 3 of the plan, and the suite values come from the suite."""
        data = self.build()
        expected_keys = {
            "schema_version", "suite", "experiment", "generated_at", "level_count", "held_firm_score", "axes",
            "twin_axes", "conditions", "mitigation_prompts", "warnings", "models",
        }
        self.assertEqual(set(data), expected_keys)
        self.assertEqual(data["suite"], "gauntlet_v3+easy")
        self.assertEqual(data["experiment"], self.experiment)
        self.assertEqual(data["level_count"], 10)
        self.assertEqual(data["held_firm_score"], 11)
        self.assertEqual(data["conditions"], ["none", "mitigation", "control"])
        self.assertEqual(len(data["axes"]), 12)
        self.assertNotIn("tampered_history", [axis["id"] for axis in data["axes"]])
        self.assertEqual(len(data["twin_axes"]), 9)
        self.assertEqual(data["mitigation_prompts"]["mitigation"], "Fixture mitigation text: re-check your reasoning before you change an answer.")
        self.assertEqual(data["mitigation_prompts"]["control"], "Fixture control text: write in plain English.")

    def test_model_keys_match_the_contract(self):
        """Each model has exactly the keys of section 3, and every rate has exactly the four rate keys."""
        data = self.build()
        # "provider" is the platform each model's replies came from; it is "unknown" for replies saved before the field.
        expected = {
            "id", "provider", "display_name", "family", "params_b", "active_params_b", "reasoning", "open_weights",
            "release_date", "units", "questions", "baseline_accuracy", "unparsed_share", "unparsed_at_last_level", "flip_curve",
            "flip_rate_last", "mean_spine_score", "flip_count", "recovery_rate", "final_correct_share",
            "capitulated_share", "converted_share", "acceptance_a", "acceptance_b", "acceptance_mean",
            "fingerprint", "backbone_index", "personality", "mitigation", "twin", "transcripts", "gates",
            "question_flip_rates",
        }
        for model in data["models"]:
            self.assertEqual(set(model), expected, model["id"])
            self.assertEqual(set(model["fingerprint"]), {axis["id"] for axis in data["axes"]})
            self.assertEqual(len(model["flip_curve"]), data["level_count"])
            self.assertEqual([point["level"] for point in model["flip_curve"]], list(range(1, 11)))
            self.assertEqual(model["flip_rate_last"], model["flip_curve"][-1]["rate"])
            self.assertEqual(set(model["mitigation"]), {"none", "mitigation", "control"})
            self.assertEqual(
                set(model["gates"]),
                {"low_sample", "low_sample_cells", "data_warning", "consistency_flag", "final_correct_check"},
            )

    def test_question_flip_rates_list_each_question_once_with_its_count(self):
        """Each question appears once, keyed by its id, with the count of its initially-right units as n."""
        data = self.build()
        entries = self.models(data)[ALPHA]["question_flip_rates"]
        self.assertTrue(entries, "alpha has initially-right units, so it must list questions")
        ids = [entry["question_id"] for entry in entries]
        self.assertEqual(len(ids), len(set(ids)))
        for entry in entries:
            self.assertEqual(set(entry), {"question_id", "flip_rate_last"})
            self.assertEqual(set(entry["flip_rate_last"]), RATE_KEYS)
            self.assertIsNone(entry["flip_rate_last"]["ci_low"])
            self.assertIsNone(entry["flip_rate_last"]["ci_high"])
            self.assertGreaterEqual(entry["flip_rate_last"]["n"], 1)

    def test_every_rate_has_exactly_four_keys(self):
        """Walk the whole data file: any dict with a 'rate' key must have exactly rate, ci_low, ci_high and n."""
        data = self.build()

        def walk(value):
            if isinstance(value, dict):
                if "rate" in value and "level" not in value and "axes_missing" not in value:
                    self.assertEqual(set(value), RATE_KEYS, value)
                for child in value.values():
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)

        walk(data)

    # ------------------------------------------------------------ nulls stay null

    def test_missing_cells_stay_null_and_are_never_zero(self):
        """Not-run cells are null in every field, never 0: quote_mine (nan), bravo's blank level and twins, and mitigation."""
        models = self.models(self.build())
        self.assertEqual(models[DELTA]["fingerprint"]["quote_mine"], EMPTY_RATE)
        self.assertEqual(models[BRAVO]["flip_curve"][4]["rate"], EMPTY_RATE)
        self.assertEqual(models[BRAVO]["flip_curve"][4]["level"], 5)
        self.assertEqual(models[BRAVO]["mean_spine_score"], EMPTY_RATE)
        self.assertIsNone(models[BRAVO]["twin"])
        self.assertIsNone(models[BRAVO]["mitigation"]["mitigation"])
        self.assertIsNone(models[BRAVO]["mitigation"]["control"])
        self.assertIsNone(models[ALPHA]["mitigation"]["control"])
        self.assertEqual(models[BRAVO]["flip_rate_last"]["rate"], 0.6)

    def test_backbone_uses_the_axes_with_data(self):
        """Delta has no quote_mine value: its backbone is 1 minus the mean flip rate of the other 11 axes, n is 11, and axes_missing names quote_mine (D5, amended)."""
        model = self.models(self.build())[DELTA]
        index = model["backbone_index"]
        rows = [row for row in self.fixture_probe_rows(DELTA, "fingerprint", "flip_rate") if row["estimate"] != "nan"]
        self.assertEqual(len(rows), 11)
        self.assertAlmostEqual(index["rate"], 1 - sum(float(row["estimate"]) for row in rows) / 11)
        self.assertAlmostEqual(index["ci_low"], 1 - sum(float(row["high"]) for row in rows) / 11)
        self.assertAlmostEqual(index["ci_high"], 1 - sum(float(row["low"]) for row in rows) / 11)
        self.assertEqual(index["n"], 11)
        self.assertEqual(index["axes_missing"], ["quote_mine"])
        self.assertEqual(model["fingerprint"]["quote_mine"], EMPTY_RATE)
        self.assertIsNotNone(self.models(self.build())[ALPHA]["backbone_index"])

    def test_every_transcript_has_a_parseable_probe_letter(self):
        """Only units whose probe reply has a letter become transcripts (D8); the unparsed reply never does."""
        models = self.models(self.build())
        for model in models.values():
            for item in model["transcripts"]:
                self.assertIsNotNone(core.parse_answer(item["reply"]))

    def test_unit_with_an_unparsed_probe_reply_is_not_a_candidate(self):
        """Transcript candidates need a parseable probe letter: an unparsed probe reply drops its unit, a parseable one keeps it."""
        steps = {
            ("m01", 1): {core.BASELINE_STEP: {"reply": "Answer: C"}, "fp_trojan": {"reply": "Answer: C"}},
            ("m01", 2): {core.BASELINE_STEP: {"reply": "Answer: C"}, "fp_trojan": {"reply": "I cannot pick one."}},
        }
        ctx = SimpleNamespace(
            steps_by_model={"fake/x": steps},
            axis_ids=["trojan"],
            questions_by_id={"m01": {"correct": "C"}},
        )
        candidates = build_compare.transcript_candidates(ctx, "fake/x")
        self.assertEqual([(item.question_id, item.repeat, item.outcome) for item in candidates], [("m01", 1, "held")])

    # ------------------------------------------------------------ gates and warnings

    def test_gate_flags(self):
        """Each fake model gets exactly the flags the brief describes."""
        models = self.models(self.build())
        self.assertFalse(models[ALPHA]["gates"]["low_sample"])
        self.assertFalse(models[ALPHA]["gates"]["data_warning"])
        self.assertFalse(models[ALPHA]["gates"]["consistency_flag"])
        self.assertTrue(models[ALPHA]["gates"]["final_correct_check"]["ok"])
        self.assertTrue(models[CHARLIE]["gates"]["low_sample"])
        self.assertTrue(any("gauntlet units: 4" in cell for cell in models[CHARLIE]["gates"]["low_sample_cells"]))
        self.assertTrue(models[DELTA]["gates"]["data_warning"])
        self.assertTrue(models[ECHO]["gates"]["consistency_flag"])
        self.assertFalse(models[ECHO]["gates"]["final_correct_check"]["ok"])
        self.assertFalse(models[BRAVO]["gates"]["low_sample"])
        self.assertFalse(models[BRAVO]["gates"]["consistency_flag"])

    def test_check_status_matches_ok_and_only_fail_sets_the_flag(self):
        """The status is ok for alpha and fail for echo; consistency_flag is set exactly when the status is fail."""
        models = self.models(self.build())
        self.assertEqual(models[ALPHA]["gates"]["final_correct_check"]["status"], "ok")
        self.assertEqual(models[ECHO]["gates"]["final_correct_check"]["status"], "fail")
        for model in models.values():
            check = model["gates"]["final_correct_check"]
            self.assertEqual(model["gates"]["consistency_flag"], check["status"] == "fail", model["id"])

    def test_consistency_bounds_follow_d15(self):
        """The check uses lower = 1 - f and upper = lower + f * r, with f the last-level flip rate and r the recovery rate."""
        check = self.models(self.build())[ALPHA]["gates"]["final_correct_check"]
        self.assertAlmostEqual(check["lower"], 0.5)
        self.assertAlmostEqual(check["upper"], 0.75)
        self.assertAlmostEqual(check["final"], 0.6)
        self.assertAlmostEqual(check["unparsed_at_last_level"], 0.0)

    def test_warnings_name_each_flagged_model_and_missing_metadata(self):
        """Warnings are added for each flagged model and for the model without metadata; alpha has none."""
        data = self.build()
        text = "\n".join(data["warnings"])
        self.assertIn(CHARLIE, text)
        self.assertIn(DELTA, text)
        self.assertIn(ECHO, text)
        self.assertIn(f"{ECHO}: no entry in the details of models.json", text)
        self.assertFalse(any(warning.startswith(ALPHA) for warning in data["warnings"]))

    # ------------------------------------------------------------ transcripts

    def test_transcript_counts_and_fields(self):
        """Each model has 0 to 6 transcripts; alpha has 3 held and 3 folded; each transcript has the required fields."""
        models = self.models(self.build())
        for model_id, model in models.items():
            count = len(model["transcripts"])
            self.assertTrue(0 <= count <= 6, model_id)
        self.assertEqual(len(models[ALPHA]["transcripts"]), 6)
        outcomes = [item["outcome"] for item in models[ALPHA]["transcripts"]]
        self.assertEqual(outcomes.count("held"), 3)
        self.assertEqual(outcomes.count("folded"), 3)
        for item in models[ALPHA]["transcripts"]:
            self.assertEqual(set(item), TRANSCRIPT_KEYS)
            self.assertTrue(item["messages"])
            for message in item["messages"]:
                self.assertEqual(set(message), {"role", "content"})
            self.assertIsInstance(item["reply"], str)

    def test_held_and_folded_come_from_different_axes_where_possible(self):
        """The three held transcripts and the three folded ones each use three different axes."""
        transcripts = self.models(self.build())[ALPHA]["transcripts"]
        for outcome in ("held", "folded"):
            axes = [item["axis"] for item in transcripts if item["outcome"] == outcome]
            self.assertEqual(len(axes), len(set(axes)), outcome)

    def test_transcript_confessions_only_on_folded(self):
        """Folded transcripts carry the confession when one was saved (with its letter); held ones never do."""
        transcripts = self.models(self.build())[ALPHA]["transcripts"]
        for item in transcripts:
            if item["outcome"] == "held":
                self.assertIsNone(item["confession"])
            elif item["confession"] is not None:
                self.assertEqual(item["confession"]["letter"], self.questions[item["question_id"]]["correct"])
                self.assertIn("I was misled", item["confession"]["text"])
        folded = [item for item in transcripts if item["outcome"] == "folded"]
        self.assertTrue(any(item["confession"] is not None for item in folded))
        self.assertTrue(any(item["confession"] is None for item in folded))

    def test_transcripts_skip_units_with_a_wrong_baseline(self):
        """Alpha's repeat-2 unit for m04 has a wrong baseline, so none of its transcripts use it."""
        transcripts = self.models(self.build())[ALPHA]["transcripts"]
        self.assertFalse(any(item["question_id"] == "m04" and item["repeat"] == 2 for item in transcripts))

    def test_no_transcripts_when_nothing_qualifies(self):
        """Bravo and echo have no fingerprint replies in the cache, so both have an empty list."""
        models = self.models(self.build())
        self.assertEqual(models[BRAVO]["transcripts"], [])
        self.assertEqual(models[ECHO]["transcripts"], [])

    def test_other_experiment_replies_are_ignored(self):
        """A reply saved under another experiment code is never used, and its model is not listed."""
        data = self.build()
        self.assertNotIn(GHOST, self.models(data))
        for model in data["models"]:
            for item in model["transcripts"]:
                self.assertNotIn("ghost-other-experiment", item["reply"])

    # ------------------------------------------------------------ backbone, personality and twins

    def test_backbone_is_the_mean_of_the_fingerprint(self):
        """Alpha's backbone is 1 minus the mean of its 12 flip rates; the interval flips the ends (D5, amended)."""
        model = self.models(self.build())[ALPHA]
        rows = self.fixture_probe_rows(ALPHA, "fingerprint", "flip_rate")
        self.assertEqual(len(rows), 12)
        mean = sum(float(row["estimate"]) for row in rows) / 12
        low = sum(float(row["low"]) for row in rows) / 12
        high = sum(float(row["high"]) for row in rows) / 12
        self.assertAlmostEqual(model["backbone_index"]["rate"], 1 - mean)
        self.assertAlmostEqual(model["backbone_index"]["ci_low"], 1 - high)
        self.assertAlmostEqual(model["backbone_index"]["ci_high"], 1 - low)
        self.assertEqual(model["backbone_index"]["n"], 12)
        self.assertEqual(model["backbone_index"]["axes_missing"], [])

    def test_personality_is_the_weakest_axis_with_ties_broken_by_axis_order(self):
        """Alpha's weakest axis is authority and its second is flattery; charlie ties on every axis except commitment (D17)."""
        models = self.models(self.build())
        alpha = models[ALPHA]["personality"]
        self.assertEqual(alpha, {"label": "Defers to titles", "primary_axis": "authority", "secondary_axis": "flattery"})
        charlie = models[CHARLIE]["personality"]
        self.assertEqual(charlie["primary_axis"], "commitment")
        self.assertEqual(charlie["label"], "Keeps its word, even when wrong")
        self.assertEqual(charlie["secondary_axis"], "bare")
        bravo = models[BRAVO]["personality"]
        self.assertEqual(bravo["primary_axis"], "bare")
        self.assertEqual(bravo["secondary_axis"], "doubt_only")

    def test_twin_pool_is_unit_weighted_and_discrimination_is_hit_minus_false_alarm(self):
        """Alpha's pooled hit and false-alarm rates are unit-weighted over the 9 axes (D6), recomputed from the fixture."""
        twin = self.models(self.build())[ALPHA]["twin"]
        hits = self.fixture_probe_rows(ALPHA, "twin", "hit_rate")
        false_alarms = self.fixture_probe_rows(ALPHA, "twin", "false_alarm_rate")
        self.assertEqual(len(hits), 9)
        total = sum(int(row["units"]) for row in hits)
        pooled_hit = sum(int(row["units"]) * float(row["estimate"]) for row in hits) / total
        pooled_fa = sum(int(row["units"]) * float(row["estimate"]) for row in false_alarms) / total
        self.assertAlmostEqual(twin["hit_rate"]["rate"], pooled_hit)
        self.assertAlmostEqual(twin["false_alarm_rate"]["rate"], pooled_fa)
        self.assertAlmostEqual(twin["discrimination"]["rate"], pooled_hit - pooled_fa)
        self.assertEqual(twin["hit_rate"]["n"], total)
        self.assertEqual(set(twin["per_axis"]), set(self.build()["twin_axes"]))
        self.assertEqual(set(twin["per_axis"]["bare"]), {"hit_rate", "false_alarm_rate", "discrimination", "d_prime"})

    def test_twin_is_null_when_there_is_no_twin_data(self):
        """Bravo has no twin rows, so its twin block is null and the twin pool is never guessed."""
        self.assertIsNone(self.models(self.build())[BRAVO]["twin"])

    def test_mitigation_block_is_filled_only_where_it_was_run(self):
        """Alpha has mitigation rows, so its mitigation block is filled; its control block stays null (D7)."""
        models = self.models(self.build())
        block = models[ALPHA]["mitigation"]["mitigation"]
        self.assertAlmostEqual(block["flip_rate_last"]["rate"], 0.3)
        self.assertAlmostEqual(block["fingerprint_mean"]["rate"], 0.2)
        self.assertEqual(block["fingerprint_mean"]["n"], 12)
        self.assertAlmostEqual(models[ALPHA]["mitigation"]["none"]["flip_rate_last"]["rate"], 0.5)

    def test_metadata_fields_and_fallbacks(self):
        """Metadata fills the family and size fields; a model without an entry gets nulls and its id as the name."""
        models = self.models(self.build())
        self.assertEqual(models[ALPHA]["display_name"], "Alpha 7B (fixture)")
        self.assertEqual(models[ALPHA]["family"], "Alpha")
        self.assertIsNone(models[ALPHA]["active_params_b"])
        self.assertIsNone(models[ECHO]["family"])
        self.assertIsNone(models[ECHO]["params_b"])
        self.assertEqual(models[ECHO]["display_name"], ECHO)

    def test_recovery_and_capitulated_counts(self):
        """Recovery is among flipped units (round of flip rate times units); capitulated uses the confession count."""
        alpha = self.models(self.build())[ALPHA]
        self.assertEqual(alpha["units"], 19)
        self.assertEqual(alpha["recovery_rate"]["n"], round(0.5 * 19))
        self.assertEqual(alpha["capitulated_share"]["n"], 2)
        self.assertEqual(alpha["mean_spine_score"]["n"], 19)

    def test_unparsed_at_last_level_counts_only_units_that_never_went_wrong(self):
        """Alpha's only unparsed-last unit also flips at level 6, so it is excluded (rate 0 over 19 units); delta has 1 of 2 units (rate 0.5)."""
        models = self.models(self.build())
        self.assertEqual(models[ALPHA]["unparsed_at_last_level"], {"rate": 0.0, "ci_low": None, "ci_high": None, "n": 19})
        self.assertEqual(models[DELTA]["unparsed_at_last_level"], {"rate": 0.5, "ci_low": None, "ci_high": None, "n": 2})

    def test_unparsed_at_last_level_drives_the_data_warning_with_the_number(self):
        """Delta is flagged for its unparsed-at-last-level share, and the warning names that share."""
        data = self.build()
        delta = self.models(data)[DELTA]
        self.assertTrue(delta["gates"]["data_warning"])
        self.assertTrue(any(
            warning.startswith(f"{DELTA}: 50% of the initially-right units have no parseable answer at the last level")
            for warning in data["warnings"]
        ))

    def test_stops_when_results_csv_and_cache_disagree_on_units(self):
        """If results.csv gives a different unit count from the cache, the build stops with exit 1."""
        path = self.results_dir / "results.csv"
        with open(path, newline="", encoding="utf-8") as file:
            reader = csv.DictReader(file)
            fieldnames = reader.fieldnames
            rows = list(reader)
        for row in rows:
            if row["model"] == ALPHA and row["condition"] == "none":
                row["units"] = "9"
        with open(path, "w", newline="", encoding="utf-8") as file:
            writer = csv.DictWriter(file, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        code, _, errors = self.run_build()
        self.assertEqual(code, 1)
        self.assertIn("disagree", errors)
        self.assertFalse(self.out_path.exists())

    def test_embeds_the_data_into_the_page_with_escaping(self):
        """The page's data element holds the same JSON, with '</' escaped, and the rest of the page is unchanged."""
        self.page_path.write_text(PAGE_HEAD, encoding="utf-8")
        code, _, errors = self.run_build()
        self.assertEqual(code, 0, errors)
        page = self.page_path.read_text(encoding="utf-8")
        start = page.index('<script id="compare-data" type="application/json">') + len('<script id="compare-data" type="application/json">')
        end = page.index("</script>", start)
        embedded = page[start:end]
        self.assertNotIn("</", embedded)
        self.assertIn("<\\/script>", embedded)
        self.assertEqual(json.loads(embedded), json.loads(self.out_path.read_text(encoding="utf-8")))
        self.assertTrue(page.startswith(PAGE_HEAD[: PAGE_HEAD.index('<script id="compare-data"')]))
        self.assertTrue(page.endswith("<p>After the data.</p></body></html>\n"))

    def test_missing_page_exits_zero_with_a_notice(self):
        """With no compare.html, the data file is written, a notice is printed, and no page is created."""
        code, output, _ = self.run_build()
        self.assertEqual(code, 0)
        self.assertIn("Notice", output)
        self.assertTrue(self.out_path.is_file())
        self.assertFalse(self.page_path.exists())

    def test_key_like_text_is_refused_and_nothing_is_written(self):
        """If a key-like string reaches an output, the build exits 1 and writes neither the data file nor the page."""
        self.page_path.write_text(PAGE_HEAD, encoding="utf-8")
        before = self.page_path.read_text(encoding="utf-8")
        self.write_cache(self.cache_text().replace("FIXTURE QUESTION", FAKE_SK_KEY + " FIXTURE QUESTION"))
        code, _, errors = self.run_build()
        self.assertEqual(code, 1)
        self.assertIn("key-like", errors)
        self.assertFalse(self.out_path.exists())
        self.assertEqual(before, self.page_path.read_text(encoding="utf-8"))

    def test_disagreeing_cache_stops_the_build(self):
        """A model with replies under this suite's code but no row in results.csv stops the build with exit 1."""
        extra = {
            "experiment": self.experiment, "condition": "none", "model": "fake/extra", "question_id": "m01",
            "repeat": 1, "step": "level_0", "temperature": 0.7,
            "messages": [{"role": "user", "content": "x"}], "reply": "Answer: C", "timestamp": "2026-10-24T09:00:00+00:00",
        }
        self.write_cache(self.cache_text() + json.dumps(extra) + "\n")
        code, _, errors = self.run_build()
        self.assertEqual(code, 1)
        self.assertIn("disagree", errors)
        self.assertFalse(self.out_path.exists())

    def test_output_inside_results_is_refused(self):
        """An --out path inside the results folder is refused, so results/ is never written."""
        code, _, errors = self.run_build("--out", str(self.results_dir / "results.json"))
        self.assertEqual(code, 1)
        self.assertIn("results folder", errors)
        self.assertFalse((self.results_dir / "results.json").exists())

    def test_escape_for_script_round_trips(self):
        """Escaping keeps the JSON valid and parses back to the original text."""
        value = {"text": "a</script><!--b </x"}
        text = json.dumps(value)
        escaped = build_compare.escape_for_script(text)
        self.assertNotIn("</", escaped)
        self.assertNotIn("<!--", escaped)
        self.assertEqual(json.loads(escaped), value)



# The axes are made up here (12 of them, like the fixtures), so only the arithmetic of build_compare is tested.
class QuestionFlipRateTests(unittest.TestCase):
    """Checks question_flip_rates on units built by hand, so the expected numbers do not depend on the fixtures."""

    def setUp(self):
        """Load the suite the builder uses, and make a context with only the suite, which is all the helper reads."""
        self.suite = core.load_suite(ladder="gauntlet_v3", questions="easy")
        self.ctx = SimpleNamespace(suite=self.suite)
        self.steps = list(grade.level_steps(self.suite))

    def unit(self, question_id, baseline_letter, level_letters):
        """Return a unit with a baseline reply and one reply per pushback level. The correct letter is A and the wrong one B."""
        letters = {core.BASELINE_STEP: baseline_letter}
        letters.update(dict(zip(self.steps, level_letters)))
        return grade.Unit(
            question_id=question_id, repeat=1, correct_letter="A", wrong_letter="B", correction_test=False,
            letters=letters,
        )

    def held_all_levels(self):
        """Return the level letters of a unit that keeps the right answer at every level."""
        return ["A"] * len(self.steps)

    def flipped_at_level_one(self):
        """Return the level letters of a unit that gives the wrong answer at the first level."""
        return ["B"] + ["A"] * (len(self.steps) - 1)

    def test_each_question_gets_its_flip_rate_and_count_of_initially_right_units(self):
        """Question q1 has two initially-right units, one flipped, so 0.5 with n 2; q2 has one flipped unit, so 1.0 with n 1."""
        units = [
            self.unit("q1", "A", self.flipped_at_level_one()),
            self.unit("q1", "A", self.held_all_levels()),
            self.unit("q2", "A", self.flipped_at_level_one()),
        ]
        entries = build_compare.question_flip_rates(self.ctx, units)
        self.assertEqual(
            entries,
            [
                {"question_id": "q1", "flip_rate_last": {"rate": 0.5, "ci_low": None, "ci_high": None, "n": 2}},
                {"question_id": "q2", "flip_rate_last": {"rate": 1.0, "ci_low": None, "ci_high": None, "n": 1}},
            ],
        )

    def test_a_question_with_no_initially_right_unit_is_left_out(self):
        """A wrong baseline answer makes the unit not initially right, so its question gets no cell at all."""
        units = [self.unit("q3", "B", self.flipped_at_level_one())]
        self.assertEqual(build_compare.question_flip_rates(self.ctx, units), [])

    def test_no_units_gives_no_entries(self):
        """A model with no replies has an empty list, never a list of zero rates."""
        self.assertEqual(build_compare.question_flip_rates(self.ctx, []), [])


class BackboneSignTests(unittest.TestCase):
    """Pins the sign and the ends of the backbone index: 1 minus the mean flip rate, with the interval flipped."""

    AXES = [f"axis{index}" for index in range(12)]

    def rates(self, flip, low=None, high=None):
        """Return fingerprint rates where every axis has the same flip rate and interval."""
        low = flip if low is None else low
        high = flip if high is None else high
        return {axis: {"rate": flip, "ci_low": low, "ci_high": high, "n": 10} for axis in self.AXES}

    def test_all_zero_flip_rates_give_backbone_one(self):
        """If no axis is flipped, the backbone index is 1.0."""
        index = build_compare.backbone_index(self.rates(0.0), self.AXES)
        self.assertEqual(index["rate"], 1.0)
        self.assertEqual(index["n"], 12)
        self.assertEqual(index["axes_missing"], [])

    def test_all_one_flip_rates_give_backbone_zero(self):
        """If every axis is flipped, the backbone index is 0.0."""
        index = build_compare.backbone_index(self.rates(1.0), self.AXES)
        self.assertEqual(index["rate"], 0.0)

    def test_interval_flips_the_ends(self):
        """With flip 0.3 and interval [0.2, 0.4], the backbone is 0.7 with interval [0.6, 0.8]."""
        index = build_compare.backbone_index(self.rates(0.3, low=0.2, high=0.4), self.AXES)
        self.assertAlmostEqual(index["rate"], 0.7)
        self.assertAlmostEqual(index["ci_low"], 0.6)
        self.assertAlmostEqual(index["ci_high"], 0.8)

    def test_mitigation_fingerprint_mean_stays_the_flip_rate(self):
        """fingerprint_mean is the mean flip rate, not the backbone index."""
        mean = build_compare.flip_mean(self.rates(0.25), self.AXES)
        self.assertAlmostEqual(mean["rate"], 0.25)


class FinalCheckStatusTests(unittest.TestCase):
    """The check reports ok, fail or not_run, and only fail sets consistency_flag."""

    # A rate with no data, as the builder produces for a cell that was not run.
    MISSING = {"rate": None, "ci_low": None, "ci_high": None, "n": None}

    def present(self, value):
        """Return a Rate with a value and no interval."""
        return {"rate": value, "ci_low": None, "ci_high": None, "n": 10}

    def test_missing_input_is_not_run_and_sets_no_flag(self):
        """With u missing the check cannot run: status not_run, ok None, consistency_flag false."""
        check = build_compare.final_correct_check(self.present(0.5), self.present(0.5), self.present(0.5), self.MISSING)
        self.assertIsNone(check["ok"])
        self.assertEqual(check["status"], "not_run")
        gates = build_compare.build_gates(10, {}, None, self.MISSING, self.MISSING, check)
        self.assertFalse(gates["consistency_flag"])

    def test_pass_and_fail_statuses(self):
        """A final share inside the bounds is ok; one below the lower bound is fail and sets the flag."""
        passing = build_compare.final_correct_check(self.present(0.5), self.present(0.5), self.present(0.6), self.present(0.0))
        self.assertEqual((passing["ok"], passing["status"]), (True, "ok"))
        failing = build_compare.final_correct_check(self.present(0.5), self.present(0.5), self.present(0.1), self.present(0.0))
        self.assertEqual((failing["ok"], failing["status"]), (False, "fail"))
        gates = build_compare.build_gates(10, {}, None, self.MISSING, self.MISSING, failing)
        self.assertTrue(gates["consistency_flag"])


class LoadMetaTests(unittest.TestCase):
    """load_meta reads the details block from models.json, and an empty dict when there is none."""

    def setUp(self):
        """Give each test its own folder, so the files it writes never clash."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self):
        """Delete the temporary folder."""
        self.temp_dir.cleanup()

    def test_reads_the_details_block(self):
        path = self.root / "models.json"
        path.write_text(json.dumps({"checked": "2026-10-25", "details": {"a/b": {"family": "A"}}}), encoding="utf-8")
        self.assertEqual(build_compare.load_meta(path), {"a/b": {"family": "A"}})

    def test_empty_when_the_details_key_is_missing(self):
        path = self.root / "models.json"
        path.write_text(json.dumps({"checked": "2026-10-25", "platforms": {}}), encoding="utf-8")
        self.assertEqual(build_compare.load_meta(path), {})

    def test_empty_when_the_file_is_missing(self):
        self.assertEqual(build_compare.load_meta(self.root / "missing.json"), {})


# The provider of the second copy of the fixtures. Its model names are the fixture names with this prefix.
SECOND_PROVIDER = "together"


# Group: results from several providers. The fixture models are copied under a second provider, with their own cache
# file, and the builder must take both, while still refusing when the results and the caches disagree.
class MultiProviderBuildTests(unittest.TestCase):
    """The builder reads every cache file it is given, and names each model's provider in the data file."""

    @classmethod
    def setUpClass(cls):
        """Work out the experiment code of the suite, the same way the builder does."""
        cls.experiment = core.load_suite(ladder="gauntlet_v3", questions="easy").experiment

    def setUp(self):
        """Build a results folder with the fixture models under two providers, each with its own cache file."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)
        self.results_dir = self.root / "results"
        self.frontend_dir = self.root / "frontend"
        self.results_dir.mkdir()
        (self.frontend_dir / "data").mkdir(parents=True)
        self.models_path = self.root / "models.json"
        shutil.copy(FIXTURES_DIR / "models.json", self.models_path)
        self.config_path = self.root / "config_subset.json"
        shutil.copy(FIXTURES_DIR / "config_subset.json", self.config_path)
        self.out_path = self.frontend_dir / "data" / "compare" / "results.json"
        base_gauntlet = read_fixture_csv("results.csv")
        base_probes = read_fixture_csv("probes.csv")
        base_records = fixture_records(self.experiment)
        # The fixture rows are the first provider's. They have no provider column, so they read as unknown.
        second_gauntlet = [renamed_for_provider(row, SECOND_PROVIDER) for row in base_gauntlet]
        second_probes = [renamed_for_provider(row, SECOND_PROVIDER) for row in base_probes]
        write_csv(self.results_dir / "results.csv", [*base_gauntlet, *second_gauntlet])
        write_csv(self.results_dir / "probes.csv", [*base_probes, *second_probes])
        write_jsonl(self.results_dir / "cache.jsonl", base_records)
        self.second_cache = self.results_dir / "cache_together.jsonl"
        write_jsonl(
            self.second_cache, [renamed_record_for_provider(record, SECOND_PROVIDER) for record in base_records]
        )

    def run_build(self, *extra):
        """Run main() on the temporary folders. Return the exit code and the error output."""
        output, errors = io.StringIO(), io.StringIO()
        args = [
            "--results-dir", str(self.results_dir),
            "--frontend-dir", str(self.frontend_dir),
            "--models", str(self.models_path),
            "--out", str(self.out_path),
            "--config", str(self.config_path),
            *extra,
        ]
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            code = build_compare.main(args)
        return code, errors.getvalue()

    def run_both_caches(self):
        """Run the build with the first provider's cache and the second provider's cache, both named."""
        return self.run_build("--cache", str(self.results_dir / "cache.jsonl"), "--cache", str(self.second_cache))

    def test_both_providers_build_when_every_cache_is_given(self):
        """With both cache files named, the build succeeds and every model says which provider served it."""
        code, errors = self.run_both_caches()
        self.assertEqual(code, 0, errors)
        models = {model["id"]: model for model in json.loads(self.out_path.read_text(encoding="utf-8"))["models"]}
        self.assertEqual(models[ALPHA]["provider"], "unknown")
        self.assertEqual(models[f"{SECOND_PROVIDER}/{ALPHA}"]["provider"], SECOND_PROVIDER)

    def test_build_stops_when_a_provider_cache_is_left_out(self):
        """Without the second cache, its models are in results.csv but not in the caches, so the build stops."""
        code, errors = self.run_build()
        self.assertEqual(code, 1)
        self.assertIn("disagree", errors)
        self.assertIn(SECOND_PROVIDER, errors)

    def test_build_stops_when_a_cache_names_a_different_provider(self):
        """A cache whose replies name another provider than results.csv does is a real mismatch, so the build stops."""
        # Same model names as results.csv, but the replies say they came from groq.
        write_jsonl(
            self.second_cache,
            [
                {**renamed_record_for_provider(record, SECOND_PROVIDER), "provider": "groq"}
                for record in fixture_records(self.experiment)
            ],
        )
        code, errors = self.run_both_caches()
        self.assertEqual(code, 1)
        self.assertIn("disagree", errors)


def read_fixture_csv(name):
    """Return the rows of a fixture CSV file as dicts."""
    with open(FIXTURES_DIR / name, newline="", encoding="utf-8") as file:
        return list(csv.DictReader(file))


def fixture_records(experiment):
    """Return the fixture cache records, with the experiment code of the suite filled in."""
    text = (FIXTURES_DIR / "cache.jsonl").read_text(encoding="utf-8").replace(PLACEHOLDER, experiment)
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def renamed_for_provider(row, provider):
    """Return a copy of a results row for another provider: its model gets the provider as a prefix."""
    return {**row, "model": f"{provider}/{row['model']}", "provider": provider}


def renamed_record_for_provider(record, provider):
    """Return a copy of a saved reply for another provider, with the same prefixed model name as its rows."""
    return {**record, "model": f"{provider}/{record['model']}", "provider": provider}


def write_csv(path, rows):
    """Write rows to a CSV file. The columns are every key seen, in the order first seen."""
    columns = []
    for row in rows:
        columns.extend(name for name in row if name not in columns)
    with open(path, "w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=columns, restval="")
        writer.writeheader()
        writer.writerows(rows)


def write_jsonl(path, records):
    """Write saved replies to a JSON lines file, one record per line."""
    path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
