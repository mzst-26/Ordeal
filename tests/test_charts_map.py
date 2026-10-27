"""Tests for charts.py and map.py. They draw into a temporary folder and never touch results/."""

import contextlib
import io
import math
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ordeal import charts
from ordeal import core
from ordeal import grade
from ordeal import map as firm_open_map

CONDITION = "none"
MODEL_ONE = "org/Model-One"
MODEL_TWO = "org/Model-Two"
# The 12-level suite used by the v4 chart tests. The older 10-level layout is called the legacy suite.
V4_HARD = core.load_suite(ladder="gauntlet_v4", questions="hard")


# Row builders: fake results and probe rows, so the drawing code can be tested without running any model.
# CSV values are read back as text, so rows go through the real save and read functions in the base class.
def make_gauntlet_row(model: str, flip_at_top: float, mean_spine: float) -> dict:
    """Build one results row with every column filled. Flip rates rise evenly up to the top level."""
    row = {column: 0.5 for column in grade.GAUNTLET_COLUMNS}
    row["condition"] = CONDITION
    row["model"] = model
    row["suite"] = grade.LEGACY_SUITE_NAME
    for level in grade.LEVELS:
        rate = flip_at_top * level / core.LEVEL_COUNT
        row[f"flip_rate_level_{level}"] = rate
        row[f"flip_rate_level_{level}_low"] = rate - 0.05
        row[f"flip_rate_level_{level}_high"] = rate + 0.05
    row["mean_spine_score"] = mean_spine
    return row


def make_probe_row(
    model: str, probe: str, estimate: float, family: str = "fingerprint", measure: str = "flip_rate"
) -> dict:
    """Build one probe row with every column of grade.PROBE_COLUMNS filled."""
    return {
        "condition": CONDITION,
        "model": model,
        "family": family,
        "probe": probe,
        "dose": "",
        "measure": measure,
        "units": 10,
        "estimate": estimate,
        "low": estimate - 0.1,
        "high": estimate + 0.1,
    }


# Shared base for the chart and map tests: a fresh temporary folder per test, so nothing in results/ is touched.
class SpineFileTestCase(unittest.TestCase):
    """Base class that gives each test its own temporary folder and reads rows back the way the scripts do."""

    def setUp(self):
        temporary_folder = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_folder.cleanup)
        self.folder = Path(temporary_folder.name)

    def write_gauntlet_rows(self, rows: list[dict]) -> list[dict[str, str]]:
        """Save results rows in the temporary folder and return them as read back for one condition."""
        results_path = self.folder / "results.csv"
        grade.merge_csv_rows(rows, results_path, grade.GAUNTLET_COLUMNS, ("condition", "model"))
        return grade.read_condition_rows(results_path, CONDITION)

    def write_probe_rows(self, rows: list[dict]) -> list[dict[str, str]]:
        """Save probe rows in the temporary folder and return them as read back for one condition."""
        probes_path = self.folder / "probes.csv"
        grade.merge_csv_rows(rows, probes_path, grade.PROBE_COLUMNS, ("condition", "model"))
        return grade.read_probe_rows(probes_path, CONDITION)


# Guards the flip-rate line chart: it writes a non-empty PNG for several models and reads one rate with its
# low and high interval ends per level (ten for the legacy suite).
class FlipByLevelChartTests(SpineFileTestCase):
    """Tests for the flip-rate line chart in charts.py."""

    def test_draw_chart_saves_a_png_for_two_models(self):
        rows = self.write_gauntlet_rows(
            [make_gauntlet_row(MODEL_ONE, 0.4, 9.0), make_gauntlet_row(MODEL_TWO, 0.2, 10.0)]
        )
        output_path = self.folder / "flip_by_level.png"
        charts.draw_chart(rows, output_path)
        self.assertTrue(output_path.is_file())
        self.assertGreater(output_path.stat().st_size, 0)

    def test_read_flip_series_returns_ten_rates_lows_and_highs(self):
        row = self.write_gauntlet_rows([make_gauntlet_row(MODEL_ONE, 0.4, 9.0)])[0]
        rates, lows, highs = charts.read_flip_series(row)
        self.assertEqual(len(rates), 10)
        self.assertEqual(len(lows), 10)
        self.assertEqual(len(highs), 10)
        self.assertAlmostEqual(rates[-1], 0.4, places=3)


# Guards the fingerprint chart: it is drawn only when rows of the fingerprint family exist. With none, it
# returns False and leaves no file, so a run without those probes does not produce an empty picture.
class FingerprintChartTests(SpineFileTestCase):
    """Tests for the fingerprint bar chart in charts.py."""

    def test_draw_fingerprint_saves_a_png_from_fingerprint_rows(self):
        rows = self.write_probe_rows(
            [
                make_probe_row(MODEL_ONE, "bare", 0.3),
                make_probe_row(MODEL_ONE, "authority", 0.6),
                make_probe_row(MODEL_TWO, "bare", 0.1),
                make_probe_row(MODEL_TWO, "authority", 0.5),
            ]
        )
        output_path = self.folder / "fingerprint.png"
        self.assertTrue(charts.draw_fingerprint(rows, output_path))
        self.assertTrue(output_path.is_file())
        self.assertGreater(output_path.stat().st_size, 0)

    def test_draw_fingerprint_writes_nothing_without_fingerprint_rows(self):
        rows = self.write_probe_rows([make_probe_row(MODEL_ONE, "bare", 0.3, family="twin", measure="hit_rate")])
        output_path = self.folder / "fingerprint.png"
        self.assertFalse(charts.draw_fingerprint(rows, output_path))
        self.assertFalse(output_path.exists())

    def test_skip_note_names_the_missing_family_and_the_saved_units(self):
        # A family that was never run still has rows, with zero units, so the note must read the units, not the rows.
        empty_probe = make_probe_row(MODEL_ONE, "bare", math.nan, family="fingerprint", measure="flip_rate")
        empty_probe["units"] = 0
        probe_rows = self.write_probe_rows([empty_probe])
        gauntlet_row = make_gauntlet_row(MODEL_ONE, 0.4, 9.0)
        gauntlet_row["units"] = 40
        gauntlet_rows = self.write_gauntlet_rows([gauntlet_row])
        note = charts.skip_note(probe_rows, gauntlet_rows)
        self.assertIn("no fingerprint replies", note)
        self.assertIn("Saved units: 40", note)

    def test_skip_note_keeps_the_short_message_when_the_family_is_present(self):
        # The family has saved units (make_probe_row sets ten), so the short message is the right one.
        probe_rows = self.write_probe_rows([make_probe_row(MODEL_ONE, "bare", 0.3)])
        gauntlet_rows = self.write_gauntlet_rows([make_gauntlet_row(MODEL_ONE, 0.4, 9.0)])
        self.assertEqual(
            charts.skip_note(probe_rows, gauntlet_rows),
            "Skipped fingerprint picture: no fingerprint flip rates for this condition.",
        )


# Guards the firm-versus-open map: models with a missing (NaN) top-level flip rate are left off the map,
# are sorted last on the leaderboard, and labels are placed on the side that faces the middle of the plot.
class LeaderboardMapTests(SpineFileTestCase):
    """Tests for the firm-versus-open map and leaderboard in map.py."""

    def test_draw_map_saves_a_png_for_rows_with_both_values(self):
        rows = self.write_gauntlet_rows(
            [make_gauntlet_row(MODEL_ONE, 0.4, 9.0), make_gauntlet_row(MODEL_TWO, 0.8, 7.0)]
        )
        output_path = self.folder / "map.png"
        firm_open_map.draw_map([row for row in rows if firm_open_map.has_both_values(row)], output_path)
        self.assertTrue(output_path.is_file())
        self.assertGreater(output_path.stat().st_size, 0)

    def test_has_both_values_is_false_when_top_level_flip_rate_is_nan(self):
        row = self.write_gauntlet_rows([make_gauntlet_row(MODEL_ONE, 0.4, 9.0)])[0]
        row["flip_rate_level_10"] = "nan"
        self.assertFalse(firm_open_map.has_both_values(row))

    def test_spine_sort_value_puts_nan_last(self):
        rows = self.write_gauntlet_rows(
            [make_gauntlet_row(MODEL_ONE, 0.4, math.nan), make_gauntlet_row(MODEL_TWO, 0.2, 9.5)]
        )
        self.assertEqual(firm_open_map.spine_sort_value(rows[0]), -math.inf)
        self.assertEqual(firm_open_map.spine_sort_value(rows[1]), 9.5)

    def test_label_offset_aligns_labels_towards_the_middle(self):
        self.assertEqual(firm_open_map.label_offset(0.8, 0)[0], "right")
        self.assertEqual(firm_open_map.label_offset(0.2, 0)[0], "left")


# Same idea as make_gauntlet_row, but with the 12-level v4 column layout and its suite name.
def make_v4_row(model: str, flip_at_top: float, mean_spine: float) -> dict:
    """Build one gauntlet_v4 + hard results row. Flip rates rise evenly up to level 12."""
    row = {column: 0.5 for column in grade.gauntlet_columns(V4_HARD.level_count)}
    row["condition"] = CONDITION
    row["model"] = model
    row["suite"] = V4_HARD.name
    for level in range(1, V4_HARD.level_count + 1):
        rate = flip_at_top * level / V4_HARD.level_count
        row[f"flip_rate_level_{level}"] = rate
        row[f"flip_rate_level_{level}_low"] = rate - 0.05
        row[f"flip_rate_level_{level}_high"] = rate + 0.05
    row["mean_spine_score"] = mean_spine
    return row


# Guards the 12-level suite path: everything that was fixed at 10 levels (series length, last level,
# held-firm score text) follows the suite's level count, and picture file names include the suite name
# except for the legacy suite, so results of different suites never overwrite each other.
class GauntletV4ChartTests(SpineFileTestCase):
    """Charts, map and leaderboard for a 12-level suite, and the file names that keep suites apart."""

    def write_v4_rows(self, rows: list[dict]) -> list[dict[str, str]]:
        """Save gauntlet_v4 rows in the temporary folder and return them as read back for the suite."""
        results_path = self.folder / "results.csv"
        grade.merge_csv_rows(rows, results_path, grade.gauntlet_columns(V4_HARD.level_count), grade.SUITE_KEY)
        return grade.read_condition_rows(results_path, CONDITION, V4_HARD.name)

    def test_read_flip_series_reads_all_twelve_levels(self):
        row = self.write_v4_rows([make_v4_row(MODEL_ONE, 0.4, 9.0)])[0]
        rates, lows, highs = charts.read_flip_series(row, V4_HARD.level_count)
        self.assertEqual((len(rates), len(lows), len(highs)), (12, 12, 12))
        self.assertAlmostEqual(rates[-1], 0.4, places=3)

    def test_draw_chart_for_v4_saves_a_picture(self):
        rows = self.write_v4_rows([make_v4_row(MODEL_ONE, 0.4, 9.0), make_v4_row(MODEL_TWO, 0.2, 10.0)])
        output_path = self.folder / "flip_v4.png"
        charts.draw_chart(rows, output_path, V4_HARD)
        self.assertTrue(output_path.is_file())
        self.assertGreater(output_path.stat().st_size, 0)

    def test_has_both_values_reads_the_last_level_of_the_suite(self):
        row = make_v4_row(MODEL_ONE, 0.4, 9.0)
        self.assertTrue(firm_open_map.has_both_values(row, V4_HARD))
        row["flip_rate_level_12"] = "nan"
        self.assertFalse(firm_open_map.has_both_values(row, V4_HARD))

    def test_leaderboard_names_the_held_firm_score_of_each_suite(self):
        rows = self.write_v4_rows([make_v4_row(MODEL_ONE, 0.4, 9.0)])
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            firm_open_map.print_leaderboard(rows, V4_HARD)
        self.assertIn("(13 = never flipped)", buffer.getvalue())
        self.assertIn("Breaking Point [95% CI]", buffer.getvalue())

    def test_picture_names_add_the_suite_only_when_it_is_not_the_legacy_suite(self):
        self.assertEqual(grade.picture_path(self.folder, "flip_by_level", CONDITION, grade.legacy_suite()).name,
                         "flip_by_level_none.png")
        self.assertEqual(grade.picture_path(self.folder, "map", CONDITION, V4_HARD).name,
                         "map_none_gauntlet_v4_hard.png")

    def test_charts_and_map_main_write_v4_pictures_into_the_output_folder(self):
        self.write_v4_rows([make_v4_row(MODEL_ONE, 0.4, 9.0), make_v4_row(MODEL_TWO, 0.8, 7.0)])
        argv = ["--suite", "gauntlet_v4+hard", "--out-dir", str(self.folder)]
        with mock.patch.object(sys, "argv", ["charts.py", *argv]), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(charts.main(), 0)
        with mock.patch.object(sys, "argv", ["map.py", *argv]), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(firm_open_map.main(), 0)
        for name in ("flip_by_level_none_gauntlet_v4_hard.png", "map_none_gauntlet_v4_hard.png"):
            self.assertGreater((self.folder / name).stat().st_size, 0)


if __name__ == "__main__":
    unittest.main()
