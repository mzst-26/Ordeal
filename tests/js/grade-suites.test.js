// Tests for the grading of both suites against grade.py. The golden rows come from
// tests/js/fixtures/grade_suites.json (both suites, with bootstrap intervals). The numerics come from
// tests/js/fixtures/numerics.json: the inverse normal and numpy's integer draws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeCondition, gradeProbes, normalDistInverse } from "../../frontend/js/engine/grade.js";
import { createIntegerDraw } from "../../frontend/js/engine/rng.js";
import { makeSuite } from "../../frontend/js/engine/rules.js";
import { readJson } from "./helpers.js";

// Allowed difference between JS and Python numbers. The inverse normal is held to a tighter limit.
const CONDITION = "none";
const TOLERANCE = 1e-9;
const NORMAL_TOLERANCE = 1e-12;
const gradeFixture = readJson("tests/js/fixtures/grade_suites.json");
const numerics = readJson("tests/js/fixtures/numerics.json");

/** True when an actual number is within tolerance of the expected one. JSON stores NaN as null. */
function closeTo(actual, expected, tolerance = TOLERANCE) {
  if (expected === null) {
    return Number.isNaN(actual);
  }
  return Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected));
}

/** Assert that every key of the expected row matches the actual row, with the same set of keys. */
function assertRowMatches(actual, expected, label) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${label}: keys differ`);
  for (const [key, value] of Object.entries(expected)) {
    if (typeof value === "string" || typeof value === "boolean") {
      assert.equal(actual[key], value, `${label}: ${key}`);
    } else {
      assert.ok(closeTo(actual[key], value), `${label}: ${key} is ${actual[key]}, expected ${value}`);
    }
  }
}

// Per suite (ladder + question set): the suite's own settings and every gauntlet and probe row,
// including bootstrap intervals, must match what grade.py produced.
for (const [suiteName, fixture] of Object.entries(gradeFixture.suites)) {
  const [ladderName, questionSet] = suiteName.split("+");
  const { config, questions, ladder, probe_spec: probeSpec } = fixture.inputs;
  const suite = makeSuite({ ladderName, questionSet, ladder, probeSpec, questions });
  // The fixture records have no condition field, so every record is given the condition under test.
  const records = fixture.records.map((record) => ({ ...record, condition: CONDITION }));

  test(`${suiteName}: the suite has the level count and held-firm score that grade.py gives`, () => {
    assert.equal(suite.name, suiteName);
    assert.equal(suite.levelCount, fixture.level_count);
    assert.equal(suite.heldFirmScore, fixture.held_firm_score);
  });

  test(`${suiteName}: gradeCondition matches every gauntlet row of grade.py, with intervals`, () => {
    const rows = gradeCondition(records, questions, config, CONDITION, suite);
    assert.deepEqual(rows.map((row) => row.model), Object.keys(fixture.models).sort());
    for (const row of rows) {
      assertRowMatches(row, fixture.models[row.model].gauntlet, `${suiteName} ${row.model} gauntlet`);
    }
  });

  test(`${suiteName}: gradeProbes matches every probe row of grade.py, with intervals`, () => {
    const rows = gradeProbes(records, questions, config, CONDITION, probeSpec);
    const expected = Object.entries(fixture.models).flatMap(([, model]) => model.probes);
    assert.equal(rows.length, expected.length);
    rows.forEach((row, index) => assertRowMatches(row, expected[index], `${suiteName} probe ${index}`));
  });
}

test("the held-firm score of gauntlet_v4 is 13, one more than its 12 levels", () => {
  assert.equal(gradeFixture.suites["gauntlet_v4+hard"].held_firm_score, 13);
  assert.equal(gradeFixture.suites["gauntlet_v4+hard"].level_count, 12);
});

// Numerics shared by the bootstrap: the inverse normal and the seeded integer draws must reproduce
// the Python and numpy values, or the intervals would differ.
test("normalDistInverse matches statistics.NormalDist().inv_cdf at every probability in the fixture", () => {
  for (const item of numerics.normal_inverse) {
    assert.ok(closeTo(normalDistInverse(item.input.p), item.output, NORMAL_TOLERANCE), item.name);
  }
});

test("normalDistInverse gives NaN outside (0, 1)", () => {
  assert.ok(Number.isNaN(normalDistInverse(0)));
  assert.ok(Number.isNaN(normalDistInverse(1)));
  assert.ok(Number.isNaN(normalDistInverse(Number.NaN)));
});

for (const item of numerics.integer_draws) {
  test(`createIntegerDraw matches numpy default_rng: ${item.name}`, () => {
    const { seed, high, count } = item.input;
    const draw = createIntegerDraw(seed);
    const values = Array.from({ length: count }, () => draw(high));
    assert.deepEqual(values, item.output);
  });
}

test("createIntegerDraw rejects a range below 1", () => {
  assert.throws(() => createIntegerDraw(42)(0), /range/);
});
