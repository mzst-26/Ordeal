"""Tests for the mixed easy and hard run order (ordeal/mix.py) and its exported files.

These check the rules the mixed run depends on: the same seed gives the same order, every question
appears once, the two sets keep their fixed pushback sets, and the percents add up to 100.
"""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from ordeal import core
from ordeal import grade
from ordeal import mix
from ordeal import runner
from tests.fake_clock import isolated_run

EASY = core.load_questions(core.DATA_DIR / "questions.json")
HARD = core.load_questions(core.DATA_DIR / "questions_hard.json")
MIXED_FRONTEND_DIR = core.PROJECT_DIR / "frontend" / "data" / "mixed"


def ids_in_order(slots: list[dict]) -> list[str]:
    """Return the question ids of the slots, in slot order."""
    return [slot["question"]["id"] for slot in slots]


class SameSeedTests(unittest.TestCase):
    """The same seed must always give the same order, so a run can be repeated and checked."""

    def test_same_seed_gives_the_same_order(self) -> None:
        """Two calls with seed 3 give the same ids in the same positions."""
        first = mix.build_mixed_order(EASY, HARD, 3)
        second = mix.build_mixed_order(EASY, HARD, 3)
        self.assertEqual(ids_in_order(first), ids_in_order(second))
        self.assertEqual([slot["question_set"] for slot in first], [slot["question_set"] for slot in second])

    def test_different_seeds_give_different_orders(self) -> None:
        """Seeds 1 to 10 all give a different order, so no two exported files are the same."""
        orders = {tuple(ids_in_order(mix.build_mixed_order(EASY, HARD, seed))) for seed in range(1, 11)}
        self.assertEqual(len(orders), 10)


class OrderContentTests(unittest.TestCase):
    """The order holds every question once, from the right set, with the right pushback set."""

    def setUp(self) -> None:
        """Build the order for seed 1 once for every test in this class."""
        self.slots = mix.build_mixed_order(EASY, HARD, 1)

    def test_all_91_questions_appear_exactly_once(self) -> None:
        """Every easy and hard question is in the order, and none is repeated."""
        expected = sorted(question["id"] for question in EASY + HARD)
        self.assertEqual(len(self.slots), 91)
        self.assertEqual(sorted(ids_in_order(self.slots)), expected)

    def test_counts_are_32_easy_and_59_hard(self) -> None:
        """The easy set has 32 questions and the hard set 59, and the order keeps both totals."""
        easy_slots = [slot for slot in self.slots if slot["question_set"] == "easy"]
        hard_slots = [slot for slot in self.slots if slot["question_set"] == "hard"]
        self.assertEqual(len(easy_slots), 32)
        self.assertEqual(len(hard_slots), 59)

    def test_positions_run_from_1_to_91(self) -> None:
        """Positions are 1-based and in order, so the first slot is position 1."""
        self.assertEqual([slot["position"] for slot in self.slots], list(range(1, 92)))

    def test_pairing_never_changes(self) -> None:
        """Easy questions always use gauntlet_v3 and hard questions always use gauntlet_v4."""
        for slot in self.slots:
            with self.subTest(question=slot["question"]["id"]):
                expected = "gauntlet_v3" if slot["question_set"] == "easy" else "gauntlet_v4"
                self.assertEqual(slot["pushback_set"], expected)

    def test_input_lists_are_not_changed(self) -> None:
        """Building the order leaves the easy and hard lists in their file order."""
        before = [question["id"] for question in EASY]
        mix.build_mixed_order(EASY, HARD, 7)
        self.assertEqual([question["id"] for question in EASY], before)


class CountTests(unittest.TestCase):
    """The counts and percents shown before a run starts."""

    def test_counts_for_the_full_order(self) -> None:
        """32 easy and 59 hard out of 91, with the percents rounded to one decimal."""
        counts = mix.mix_counts(mix.build_mixed_order(EASY, HARD, 1))
        self.assertEqual(counts["total"], 91)
        self.assertEqual(counts["easy"], {"count": 32, "percent": 35.2})
        self.assertEqual(counts["hard"], {"count": 59, "percent": 64.8})

    def test_percents_sum_to_100(self) -> None:
        """The two percents add up to exactly 100.0 for the full order and for a short one."""
        for slots in (mix.build_mixed_order(EASY, HARD, 2), mix.build_mixed_order(EASY[:1], HARD[:2], 2)):
            counts = mix.mix_counts(slots)
            self.assertEqual(round(counts["easy"]["percent"] + counts["hard"]["percent"], 1), 100.0)

    def test_zero_total_is_refused(self) -> None:
        """An empty order has no percents, so counting it is refused with a clear message."""
        with self.assertRaises(ValueError):
            mix.mix_counts([])
        with self.assertRaisesRegex(ValueError, "zero"):
            mix.mix_counts(mix.build_mixed_order([], [], 1))


class MixedRunTests(unittest.TestCase):
    """The mixed run's experiment code, its saved record and the stub run from start to finish."""

    def test_mixed_code_is_stable_and_not_a_default_code(self) -> None:
        """The mixed code is the same on every call and differs from the four fixed codes."""
        code = core.load_mixed_suite().experiment
        self.assertEqual(code, core.load_mixed_suite().experiment)
        fixed = {core.load_suite(ladder=ladder, questions=questions).experiment for ladder in core.LADDER_FILES
                 for questions in core.QUESTION_FILES}
        self.assertNotIn(code, fixed)

    def test_units_carry_their_pushback_set_and_fields(self) -> None:
        """A unit built from a mixed slot knows its pushback set, and its reply fields include the seed and position."""
        plan = runner.plan_mixed_run(4, 1)
        units = runner.make_units(["m"], plan.questions, 1, None, plan.mix_fields_by_question)
        hard_units = [unit for unit in units if unit.mix_fields["question_set"] == "hard"]
        self.assertTrue(hard_units)
        for unit in units:
            with self.subTest(question=unit.question["id"]):
                self.assertEqual(unit.pushback_set, unit.mix_fields["pushback_set"])
                self.assertEqual(set(unit.mix_fields), {"mix_seed", "mix_position", "pushback_set", "question_set"})

    def test_each_unit_gets_its_own_ladder(self) -> None:
        """Easy units use the gauntlet_v3 ladder and hard units use gauntlet_v4 in the same run."""
        plan = runner.plan_mixed_run(4, 1)
        units = runner.make_units(["m"], plan.questions, 1, None, plan.mix_fields_by_question)
        for unit in units:
            ladder, _ = runner.ladder_and_probes_for(unit, plan.pushback_plans, None, None)
            with self.subTest(question=unit.question["id"]):
                expected = "gauntlet_v3" if unit.mix_fields["question_set"] == "easy" else "gauntlet_v4"
                self.assertEqual(ladder["name"], expected)

    def test_limit_applies_to_each_set_before_the_order(self) -> None:
        """With --limit 2 the run plans 2 easy and 2 hard questions, and the counts describe those 4."""
        plan = runner.plan_mixed_run(9, 2)
        self.assertEqual(len(plan.questions), 4)
        self.assertEqual(plan.counts["easy"]["count"], 2)
        self.assertEqual(plan.counts["hard"]["count"], 2)

    def test_run_record_is_replaced_for_the_same_seed(self) -> None:
        """Writing a record twice for one seed keeps one entry, and another seed adds a second entry."""
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / core.MIXED_RUNS_FILE_NAME
            record = {"experiment": "e", "seed": 1, "completed": None}
            core.write_run_record(record, path)
            core.write_run_record({**record, "completed": 5}, path)
            core.write_run_record({**record, "seed": 2}, path)
            records = core.read_run_records(path)
            self.assertEqual(len(records), 2)
            self.assertEqual(core.find_run_record(path, "e", 1)["completed"], 5)

    def test_stub_run_then_grade_writes_only_mixed_files(self) -> None:
        """A stub mixed run with --limit 1 saves a record and grading writes the mixed files, not results.csv."""
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder) / "cache.jsonl"
            out_dir = Path(folder) / "out"
            # The stub is paced like an unknown model, so the run would wait minutes in real time without this.
            with isolated_run(Path(folder) / "results"), contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()):
                code = runner.main(["--stub", "--shuffle-mix", "3", "--limit", "1", "--repeats", "1",
                                    "--cache", str(cache)])
                grade_code = grade.main(["--shuffle-mix", "3", "--cache", str(cache), "--out-dir", str(out_dir)])
            self.assertEqual((code, grade_code), (0, 0))
            record = core.find_run_record(core.mixed_runs_path(cache), core.load_mixed_suite().experiment, 3)
            self.assertEqual(record["planned"], 2)
            self.assertEqual(record["completed"], 2)
            self.assertEqual(record["counts"]["easy"]["percent"], 50.0)
            self.assertTrue((out_dir / "mixed_results.csv").is_file())
            self.assertTrue((out_dir / "mixed_by_run.csv").is_file())
            self.assertFalse((out_dir / "results.csv").exists())
            self.assertFalse((out_dir / "by_difficulty.csv").exists())
            by_run = (out_dir / "mixed_by_run.csv").read_text(encoding="utf-8")
            self.assertIn("3,easy,gauntlet_v3,1,50.0,1", by_run)


class ExportedFileTests(unittest.TestCase):
    """The files in frontend/data/mixed must match the function output for their seed."""

    def test_each_exported_file_matches_the_function(self) -> None:
        """Seeds 1 to 10 each have a file, and the file equals mix.order_document for that seed."""
        for seed in range(1, 11):
            with self.subTest(seed=seed):
                path = MIXED_FRONTEND_DIR / f"mixed_{seed}.json"
                exported = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(exported, mix.order_document(seed, EASY, HARD))


if __name__ == "__main__":
    unittest.main()
