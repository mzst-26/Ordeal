// Parity check for the browser grader, seen from the JavaScript side.
// frontend/js/engine/grade.js must give the same numbers as grade.py for the same saved replies. This file
// grades the shared fixture in tests/fixtures/grader-parity with the browser grader and compares every field
// with expected.json. That file was written by the Python grader, so this test checks the browser against it.
// tests/python/test_grader_parity.py reads the same two files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeCondition } from "../../frontend/js/engine/grade.js";
import { readJson } from "./helpers.js";

const FIXTURE_FOLDER = "tests/fixtures/grader-parity";
const CONDITIONS = ["none", "mitigation"];
// Interval ends come from the random bootstrap, so only they get a tolerance. Every other value must be equal.
const INTERVAL_TOLERANCE = 1e-9;
// The estimates whose intervals are compared. Each one also has _low and _high fields.
const ESTIMATES = [
  ...Array.from({ length: 10 }, (_, index) => `flip_rate_level_${index + 1}`),
  "mean_spine_score",
  "final_correct_share",
  "capitulated_share",
  "converted_share",
  "recovery_rate",
  "test_retest_agreement",
  "acceptance_mean",
];
// Every field compared with grade.py, the same list as in tests/python/test_grader_parity.py.
const PARITY_FIELDS = [
  "suite",
  "questions",
  "units",
  "baseline_accuracy",
  "unparsed_share",
  ...ESTIMATES.flatMap((name) => [name, `${name}_low`, `${name}_high`]),
  "acceptance_a",
  "acceptance_b",
  "correction_units",
  "confession_units",
  "flip_count",
  "flip_count_units",
];
// Fields that grade.py reports and the browser grader does not compute yet. They are skipped by name below.
const BROWSER_GAPS = new Set(["test_retest_agreement", "test_retest_agreement_low", "test_retest_agreement_high"]);

const records = readJson(`${FIXTURE_FOLDER}/replies.json`);
const questions = readJson(`${FIXTURE_FOLDER}/questions.json`);
const config = readJson(`${FIXTURE_FOLDER}/config.json`);
const expected = readJson(`${FIXTURE_FOLDER}/expected.json`).conditions;

/**
 * True when an actual number matches an expected value from expected.json. JSON stores NaN as null.
 * Interval ends may differ by INTERVAL_TOLERANCE; every other number must be exactly equal.
 */
function matchesExpected(name, actual, expectedValue) {
  if (expectedValue === null) {
    return actual === null || Number.isNaN(actual);
  }
  if (name.endsWith("_low") || name.endsWith("_high")) {
    return typeof actual === "number" && Math.abs(actual - expectedValue) <= INTERVAL_TOLERANCE;
  }
  return actual === expectedValue;
}

for (const condition of CONDITIONS) {
  const rows = gradeCondition(records, questions, config, condition);
  const rowByModel = new Map(rows.map((row) => [row.model, row]));

  test(`gradeCondition has the expected models for ${condition}`, () => {
    assert.deepEqual([...rowByModel.keys()].sort(), Object.keys(expected[condition]).sort());
  });

  for (const [model, expectedRow] of Object.entries(expected[condition])) {
    test(`${condition} ${model} matches the grade.py numbers in expected.json`, () => {
      const row = rowByModel.get(model);
      assert.ok(row, `no row for ${model}`);
      for (const name of PARITY_FIELDS) {
        if (BROWSER_GAPS.has(name)) {
          continue;
        }
        assert.ok(
          matchesExpected(name, row[name], expectedRow[name]),
          `${name}: expected ${expectedRow[name]}, got ${row[name]}`,
        );
      }
    });
  }
}

// Known gap, reported to the owner. grade.py computes test-retest agreement (ordeal/grade.py retest_agreement);
// the browser grader (frontend/js/engine/grade.js gradeModel) does not. It is skipped here so the gap stays visible.
test("browser grader computes test_retest_agreement like grade.py", { skip: "not implemented in engine/grade.js: grade.py:390-409 and grade.py:513 have it; this batch does not add it" }, () => {});
