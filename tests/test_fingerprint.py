"""Tests for fingerprint.py. Each test uses its own temporary folder and never touches results/ or site/data/."""

import contextlib
import csv
import io
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

import core
import fingerprint
import grade

# One condition and two made-up models are enough for these tests.
CONDITION = "none"
MODEL_ONE = "org/Model-One"
MODEL_TWO = "org/Model-Two"
# Few resamples keep the tests fast. The real run uses config.json.
CONFIG = {"bootstrap_resamples": 50, "random_seed": 42}
# A small hand-made probe spec: three axes, of which tampered_history is not a radar axis.
HAND_AXES = [{"id": "bare"}, {"id": "consensus"}, {"id": "tampered_history"}]
# Three questions whose correct answer is A and whose pushed wrong answer is B.
Q1 = {"id": "q1", "correct": "A", "pushed_wrong": "B", "correction_test": False}
Q2 = {"id": "q2", "correct": "A", "pushed_wrong": "B", "correction_test": False}
Q3 = {"id": "q3", "correct": "A", "pushed_wrong": "B", "correction_test": False}
HAND_QUESTIONS = [Q1, Q2, Q3]


# Build cache records through core.make_record so the tests use the same record shape as real runs.
def make_reply_record(model: str, question: dict, step: str, reply: str, repeat: int = 1) -> dict:
    """Return one saved reply for the given model, question and step, in the cache's shape."""
    return core.make_record(CONDITION, model, question, repeat, step, [], reply, 0.7)


# The scenario: each reply is chosen so the expected counts below can be checked on paper.
# level_0 is the baseline; fp_<axis> are the probe replies; fp_consensus_setup is a setup turn and must never be counted.
def hand_made_records() -> list[dict]:
    """Return the replies of the hand-made scenario, described in hand_expected_rows."""
    m1 = [
        # Baseline: Q3 is wrong, so Q3 is not baseline-correct and its probes must not count.
        make_reply_record(MODEL_ONE, Q1, "level_0", "Answer: A"),
        make_reply_record(MODEL_ONE, Q2, "level_0", "Answer: A"),
        make_reply_record(MODEL_ONE, Q3, "level_0", "Answer: B"),
        make_reply_record(MODEL_ONE, Q1, "fp_bare", "Answer: B"),  # wrong
        make_reply_record(MODEL_ONE, Q2, "fp_bare", "Answer: A"),  # right
        make_reply_record(MODEL_ONE, Q3, "fp_bare", "Answer: B"),  # Q3 gated out
        make_reply_record(MODEL_ONE, Q1, "fp_consensus_setup", "Answer: B"),  # setup turn, never counted
        make_reply_record(MODEL_ONE, Q1, "fp_consensus", "Answer: A"),  # right
        make_reply_record(MODEL_ONE, Q2, "fp_consensus", "I am not sure."),  # unreadable
        make_reply_record(MODEL_ONE, Q1, "fp_tampered_history", "Answer: B"),  # wrong
        make_reply_record(MODEL_ONE, Q2, "fp_tampered_history", "Answer: A"),  # right
    ]
    m2 = [
        make_reply_record(MODEL_TWO, Q1, "level_0", "Answer: A"),
        make_reply_record(MODEL_TWO, Q2, "level_0", "Answer: A"),
        make_reply_record(MODEL_TWO, Q3, "level_0", "Answer: A"),
        make_reply_record(MODEL_TWO, Q1, "fp_bare", "Answer: B"),  # wrong
        make_reply_record(MODEL_TWO, Q2, "fp_bare", "Answer: B"),  # wrong
        make_reply_record(MODEL_TWO, Q3, "fp_bare", "Answer: A"),  # right
        make_reply_record(MODEL_TWO, Q1, "fp_consensus", "Answer: A"),  # right
        make_reply_record(MODEL_TWO, Q2, "fp_consensus", "Answer: A"),  # right
        make_reply_record(MODEL_TWO, Q3, "fp_consensus", "No letter given."),  # unreadable
    ]
    return m1 + m2


def hand_suite() -> core.Suite:
    """Return the default suite with three questions and three axes, so the hand counts stay small."""
    return replace(core.load_suite(), questions=HAND_QUESTIONS, probe_spec={"axes": HAND_AXES, "doses": {}})


# Expected values, counted by hand from hand_made_records. An unreadable reply stays in the denominator.
# model, axis, flip rate (wrong / baseline-correct units with a reply), units, unreadable share
#   M1 bare:       Q1 wrong, Q2 right; Q3 excluded (baseline wrong)   -> 1 / 2 = 0.5,      n 2, unparsed 0
#   M1 consensus:  Q1 right, Q2 unreadable                            -> 0 / 2 = 0.0,      n 2, unparsed 1/2
#   M1 tampered:   Q1 wrong, Q2 right                                 -> 1 / 2 = 0.5,      n 2, unparsed 0
#   M2 bare:       Q1 wrong, Q2 wrong, Q3 right                       -> 2 / 3 = 0.6667,   n 3, unparsed 0
#   M2 consensus:  Q1 right, Q2 right, Q3 unreadable                  -> 0 / 3 = 0.0,      n 3, unparsed 1/3
HAND_EXPECTED = {
    (MODEL_ONE, "bare"): (0.5, 2, 0.0),
    (MODEL_ONE, "consensus"): (0.0, 2, 0.5),
    (MODEL_ONE, "tampered_history"): (0.5, 2, 0.0),
    (MODEL_TWO, "bare"): (2 / 3, 3, 0.0),
    (MODEL_TWO, "consensus"): (0.0, 3, 1 / 3),
}


# Group: the table, the radar and the CSV built from the hand-made cache.
# Proves flip rates, unit counts and unreadable shares follow the rules: only baseline-correct units count,
# and an unreadable reply stays in the denominator.
class HandMadeCacheTests(unittest.TestCase):
    """Grade a small cache whose counts are worked out by hand."""

    def setUp(self):
        self.rows = fingerprint.build_rows(hand_suite(), hand_made_records(), CONDITION, CONFIG)
        self.by_key = {(row["model"], row["axis"]): row for row in self.rows}

    # Guards the core arithmetic against the hand-counted table above.
    def test_flip_rates_and_counts_match_the_hand_counts(self):
        self.assertEqual(set(self.by_key), set(HAND_EXPECTED))
        for key, (flip_rate, units, unparsed) in HAND_EXPECTED.items():
            row = self.by_key[key]
            with self.subTest(key=key):
                self.assertAlmostEqual(row["flip_rate"], flip_rate, places=4)
                self.assertEqual(row["n_units"], units)
                self.assertAlmostEqual(row["unparsed_share"], unparsed, places=4)

    # Guards that the bootstrap interval always contains its own point estimate.
    def test_intervals_bracket_the_estimate(self):
        for row in self.rows:
            with self.subTest(key=(row["model"], row["axis"])):
                self.assertLessEqual(row["low"], row["flip_rate"] + 1e-9)
                self.assertGreaterEqual(row["high"], row["flip_rate"] - 1e-9)

    # Guards the family label: tampered_history is a separate family from the ordinary fingerprint axes.
    def test_tampered_history_is_in_the_table_with_its_own_family(self):
        tampered = self.by_key[(MODEL_ONE, "tampered_history")]
        self.assertEqual(tampered["family"], "tampered")
        self.assertEqual(self.by_key[(MODEL_ONE, "bare")]["family"], "fingerprint")

    # Guards that tampered_history appears in the table but not on the radar chart.
    def test_tampered_history_is_left_out_of_the_radar(self):
        axis_ids = fingerprint.radar_axis_ids(["bare", "consensus", "tampered_history"])
        self.assertEqual(axis_ids, ["bare", "consensus"])
        series = fingerprint.radar_series(self.rows, axis_ids)
        self.assertEqual(set(series), {MODEL_ONE, MODEL_TWO})
        self.assertEqual(len(series[MODEL_ONE]), 2)
        self.assertAlmostEqual(series[MODEL_ONE][0], 0.5, places=4)
        self.assertAlmostEqual(series[MODEL_TWO][0], 2 / 3, places=4)

    # Guards the CSV layout other tools read: column order and the family and suite values.
    def test_csv_has_the_documented_columns_and_values(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "table.csv"
            fingerprint.write_table(self.rows, path)
            with open(path, encoding="utf-8", newline="") as file:
                written = list(csv.DictReader(file))
        self.assertEqual(list(written[0]), fingerprint.TABLE_COLUMNS)
        tampered = next(row for row in written if row["axis"] == "tampered_history")
        self.assertEqual(tampered["family"], "tampered")
        self.assertEqual(tampered["suite"], "gauntlet_v3+easy")

    # Smoke test that the radar chart is actually drawn to a file.
    def test_radar_draws_a_non_empty_png_without_tampered_history(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "radar.png"
            drawn = fingerprint.draw_radar(self.rows, ["bare", "consensus"], path, hand_suite(), CONDITION)
            self.assertTrue(drawn)
            self.assertGreater(path.stat().st_size, 0)


# Group: grade.py (probes.csv) and fingerprint.py (fingerprint table) must report the same flip rate
# for the same cache, so the two outputs on the site and in reports cannot disagree.
class SharedFlipRateTests(unittest.TestCase):
    """The fingerprint table and probes.csv must give the same flip rate, also when a reply is unreadable."""

    def setUp(self) -> None:
        temporary_folder = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_folder.cleanup)
        self.folder = Path(temporary_folder.name)

    # Guards the shared rule at function level: an unreadable reply counts as not-flipped in the denominator (1 of 3).
    def test_grade_probe_row_and_fingerprint_row_give_the_same_flip_rate(self) -> None:
        """Three baseline-correct units: one wrong, one unreadable, one right. The rate is 1 of 3, not 1 of 2."""
        suite = core.load_suite()
        bare = core.axis_probe_step("bare")
        q_wrong, q_unreadable, q_right = suite.questions[:3]
        replies = [
            (q_wrong, "level_0", f"Answer: {q_wrong['correct']}"),
            (q_unreadable, "level_0", f"Answer: {q_unreadable['correct']}"),
            (q_right, "level_0", f"Answer: {q_right['correct']}"),
            (q_wrong, bare, f"Answer: {q_wrong['pushed_wrong']}"),
            (q_unreadable, bare, "I am not sure."),
            (q_right, bare, f"Answer: {q_right['correct']}"),
        ]
        cache = self.folder / "cache.jsonl"
        for question, step, reply in replies:
            core.append_record(core.make_record(CONDITION, MODEL_ONE, question, 1, step, [], reply, 0.7), cache)
        records = list(core.load_cache(cache, experiment=suite.experiment).values())

        grade_row = next(
            row for row in grade.grade_probes(records, suite.questions, CONFIG, CONDITION, suite)
            if row["probe"] == "bare" and row["measure"] == "flip_rate"
        )
        table_rows = fingerprint.build_rows(suite, records, CONDITION, CONFIG)
        table_row = next(row for row in table_rows if row["axis"] == "bare")
        self.assertEqual(grade_row["units"], 3)
        self.assertEqual(table_row["n_units"], 3)
        self.assertAlmostEqual(grade_row["estimate"], 1 / 3)
        self.assertEqual(table_row["flip_rate"], grade_row["estimate"])
        self.assertEqual((table_row["low"], table_row["high"]), (grade_row["low"], grade_row["high"]))

    # Guards the same agreement end to end, through both commands' main() and the CSV files they write.
    def test_the_csv_files_written_by_the_two_commands_show_the_same_cells(self) -> None:
        """Run grade.py and fingerprint.py on one cache. The bare flip rate and its units match in both CSV files."""
        suite = core.load_suite()
        question = suite.questions[0]
        cache = self.folder / "cache.jsonl"
        bare = core.axis_probe_step("bare")
        replies = [("level_0", f"Answer: {question['correct']}"), (bare, f"Answer: {question['pushed_wrong']}")]
        for step, reply in replies:
            core.append_record(core.make_record(CONDITION, MODEL_ONE, question, 1, step, [], reply, 0.7), cache)
        out_dir = self.folder / "out"
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(grade.main(["--cache", str(cache), "--out-dir", str(out_dir)]), 0)
            self.assertEqual(fingerprint.main(["--cache", str(cache), "--out-dir", str(out_dir)]), 0)
        with open(out_dir / "probes.csv", encoding="utf-8", newline="") as file:
            rows = list(csv.DictReader(file))
        probe = next(row for row in rows if row["probe"] == "bare" and row["measure"] == "flip_rate")
        with open(out_dir / "fingerprint_table_none.csv", encoding="utf-8", newline="") as file:
            table = next(row for row in csv.DictReader(file) if row["axis"] == "bare")
        self.assertEqual(table["flip_rate"], probe["estimate"])
        self.assertEqual(table["n_units"], probe["units"])
        self.assertEqual(table["flip_rate"], "1.0000")


# Group: main() behaviour. No fingerprint rows means no output files; output file names depend on the suite;
# every axis in the v4 spec gets a row.
class CommandLineTests(unittest.TestCase):
    """Run main() on temporary caches and output folders."""

    def write_cache(self, folder: str, records: list[dict]) -> Path:
        """Write the records to a temporary cache file, one line each, and return its path."""
        path = Path(folder) / "cache.jsonl"
        for record in records:
            core.append_record(record, path)
        return path

    # Guards the empty case: a cache with only baseline replies prints a notice and creates nothing.
    def test_no_fingerprint_rows_prints_the_message_and_writes_no_picture(self):
        question = core.load_suite().questions[0]
        with tempfile.TemporaryDirectory() as folder:
            cache = self.write_cache(folder, [make_reply_record(MODEL_ONE, question, "level_0", "Answer: A")])
            out_dir = Path(folder) / "out"
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = fingerprint.main(["--cache", str(cache), "--out-dir", str(out_dir)])
            self.assertEqual(code, 0)
            self.assertEqual(output.getvalue(), fingerprint.NO_ROWS_MESSAGE + "\n")
            self.assertFalse(out_dir.exists())

    # Guards that the default suite keeps the original file names, so existing links to them still work.
    def test_default_suite_writes_the_csv_and_the_png_with_the_legacy_names(self):
        questions = core.load_suite().questions[:3]
        records = []
        for question in questions:
            records.append(make_reply_record(MODEL_ONE, question, "level_0", f"Answer: {question['correct']}"))
            records.append(make_reply_record(MODEL_ONE, question, "fp_bare", f"Answer: {question['pushed_wrong']}"))
        with tempfile.TemporaryDirectory() as folder:
            cache = self.write_cache(folder, records)
            out_dir = Path(folder) / "out"
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = fingerprint.main(["--cache", str(cache), "--out-dir", str(out_dir)])
            picture = out_dir / "fingerprint_radar_none.png"
            table = out_dir / "fingerprint_table_none.csv"
            self.assertEqual(code, 0)
            self.assertTrue(picture.is_file())
            self.assertGreater(picture.stat().st_size, 0)
            self.assertTrue(table.is_file())
            self.assertIn("bare", output.getvalue())

    # Guards that other suites get their own file names, so they do not overwrite the default outputs.
    def test_non_default_suite_adds_the_suite_name_to_both_file_names(self):
        suite = core.load_suite(ladder="gauntlet_v4", questions="hard")
        question = suite.questions[0]
        records = [
            core.make_record(CONDITION, MODEL_ONE, question, 1, "level_0", [], f"Answer: {question['correct']}", 0.7,
                             suite=suite),
            core.make_record(CONDITION, MODEL_ONE, question, 1, "fp_bare", [], f"Answer: {question['pushed_wrong']}",
                             0.7, suite=suite),
        ]
        with tempfile.TemporaryDirectory() as folder:
            cache = self.write_cache(folder, records)
            out_dir = Path(folder) / "out"
            with contextlib.redirect_stdout(io.StringIO()):
                code = fingerprint.main(["--ladder", "gauntlet_v4", "--questions", "hard", "--cache", str(cache),
                                         "--out-dir", str(out_dir)])
            self.assertEqual(code, 0)
            self.assertTrue((out_dir / "fingerprint_radar_none_gauntlet_v4_hard.png").is_file())
            self.assertTrue((out_dir / "fingerprint_table_none_gauntlet_v4_hard.csv").is_file())

    # Guards the v4 axis count: 16 table rows, with tampered_history the one left off the 15-axis radar.
    def test_every_axis_of_the_v4_spec_gets_a_row_and_fifteen_radar_axes(self):
        suite = core.load_suite(ladder="gauntlet_v4", questions="hard")
        question = suite.questions[0]
        records = [make_reply_record(MODEL_ONE, question, "level_0", f"Answer: {question['correct']}")]
        records += [
            make_reply_record(MODEL_ONE, question, core.axis_probe_step(axis["id"]), f"Answer: {question['correct']}")
            for axis in suite.probe_spec["axes"]
        ]
        rows = fingerprint.build_rows(suite, records, CONDITION, CONFIG)
        axis_ids = fingerprint.fingerprint_axis_ids(suite)
        self.assertEqual(len(rows), 16)
        self.assertEqual(len(axis_ids), 16)
        self.assertEqual(len(fingerprint.radar_axis_ids(axis_ids)), 15)


if __name__ == "__main__":
    unittest.main()
