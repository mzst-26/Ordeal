// Tests for frontend/js/engine/grade.js. The golden cases come from js-tests/fixtures/grade.json,
// which was written by running the Python reference grade.py on the synthetic records in that file.
// The questions are read from the shipped questions.json in frontend/data/, which is what the browser loads.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  share,
  buildUnits,
  isRightAt,
  gradeCondition,
  gradeProbes,
  clusterBootstrapInterval,
  normalDistInverse,
  dPrime,
  evaluatePolynomial,
} from "../frontend/js/engine/grade.js";
import { readJson } from "./helpers.js";

// evaluatePolynomial is a small maths helper (used by the inverse normal), checked on its own first.
test("evaluatePolynomial applies the coefficients from the highest power down", () => {
  // 2x^2 + 3x + 4 at x = 5 is 50 + 15 + 4 = 69.
  assert.equal(evaluatePolynomial([2, 3, 4], 5), 69);
});

test("evaluatePolynomial returns the constant for a single coefficient", () => {
  assert.equal(evaluatePolynomial([7], 123), 7);
});

test("evaluatePolynomial gives 0 for no coefficients", () => {
  assert.equal(evaluatePolynomial([], 5), 0);
});

// Golden test setup: JS results are compared with grade.py output within TOLERANCE.
const TOLERANCE = 1e-9;
const CONDITION = "none";

const fixture = readJson("js-tests/fixtures/grade.json");
const questions = readJson("frontend/data/questions.json");
const config = fixture.inputs.config;
const probeSpec = fixture.inputs.probe_spec;

// The fixture records have no condition field, so every record is given the condition under test.
const records = fixture.records.map((record) => ({
  condition: CONDITION,
  model: record.model,
  question_id: record.question_id,
  repeat: record.repeat,
  reply: record.reply,
  step: record.step,
}));

const models = Object.keys(fixture.models).sort();

/** True when an actual value matches an expected value from the fixture. JSON stores NaN as null. */
function matchesExpected(actual, expected) {
  if (expected === null) {
    return actual === null || Number.isNaN(actual);
  }
  if (typeof expected === "number") {
    return typeof actual === "number" && Math.abs(actual - expected) <= TOLERANCE;
  }
  return actual === expected;
}

/** Return the gradeCondition row for one model. */
function gauntletRowFor(rows, model) {
  return rows.find((row) => row.model === model);
}

// Gauntlet: every point estimate in the fixture must equal the JavaScript value.

const gauntletRows = gradeCondition(records, questions, config, CONDITION);

test("gradeCondition returns one row per fixture model, sorted by model name", () => {
  assert.deepEqual(
    gauntletRows.map((row) => row.model),
    models,
  );
});

for (const model of models) {
  test(`gradeCondition matches the fixture gauntlet row for ${model}`, () => {
    const row = gauntletRowFor(gauntletRows, model);
    const expected = fixture.models[model].gauntlet;
    for (const [key, expectedValue] of Object.entries(expected)) {
      assert.ok(
        matchesExpected(row[key], expectedValue),
        `${model} ${key}: expected ${expectedValue}, got ${row[key]}`,
      );
    }
  });
}

// Sanity check that does not need the fixture: an estimate must sit inside its own interval.
test("every gauntlet estimate with an interval lies between its low and high ends", () => {
  const estimateNames = [
    ...Array.from({ length: 10 }, (_, index) => `flip_rate_level_${index + 1}`),
    "mean_spine_score",
    "final_correct_share",
    "capitulated_share",
    "converted_share",
    "acceptance_mean",
  ];
  for (const row of gauntletRows) {
    for (const name of estimateNames) {
      const estimate = row[name];
      const low = row[`${name}_low`];
      const high = row[`${name}_high`];
      if ([estimate, low, high].every((value) => typeof value === "number" && !Number.isNaN(value))) {
        assert.ok(low <= estimate && estimate <= high, `${row.model} ${name}: ${low} <= ${estimate} <= ${high}`);
      }
    }
  }
});

// Probes: every probe row in the fixture must have the same estimate in JavaScript.

const probeRows = gradeProbes(records, questions, config, CONDITION, probeSpec);

/** Return the key that identifies one probe row: family, probe, dose and measure. */
function probeKey(row) {
  return [row.family, row.probe, String(row.dose), row.measure].join("|");
}

for (const model of models) {
  test(`gradeProbes matches the fixture probe rows for ${model}`, () => {
    const actualRows = probeRows.filter((row) => row.model === model);
    const expectedRows = fixture.models[model].probes;
    assert.equal(actualRows.length, expectedRows.length, `${model}: number of probe rows`);
    const actualByKey = new Map(actualRows.map((row) => [probeKey(row), row]));
    for (const expected of expectedRows) {
      const key = probeKey(expected);
      const actual = actualByKey.get(key);
      assert.ok(actual, `${model}: missing probe row ${key}`);
      assert.ok(
        matchesExpected(actual.estimate, expected.estimate),
        `${model} ${key}: expected ${expected.estimate}, got ${actual.estimate}`,
      );
    }
  });
}

test("every probe estimate with an interval lies between its low and high ends", () => {
  for (const row of probeRows) {
    const { estimate, low, high } = row;
    if ([estimate, low, high].every((value) => typeof value === "number" && !Number.isNaN(value))) {
      assert.ok(
        low <= estimate && estimate <= high,
        `${row.model} ${probeKey(row)}: ${low} <= ${estimate} <= ${high}`,
      );
    }
  }
});

// Unit tests for the helpers.

// Unit tests for the small helpers: share, buildUnits, isRightAt, normalDistInverse, dPrime and the bootstrap.
test("share returns NaN when the total is zero", () => {
  assert.ok(Number.isNaN(share(0, 0)));
});

test("share divides count by total", () => {
  assert.equal(share(1, 4), 0.25);
});

test("buildUnits groups replies by question and repeat, and parses each letter", () => {
  const questionsById = Object.fromEntries(questions.map((question) => [question.id, question]));
  const units = buildUnits(
    [
      { question_id: "m01", repeat: 1, step: "level_0", reply: "Answer: C" },
      { question_id: "m01", repeat: 1, step: "level_1", reply: "I am not sure." },
      { question_id: "m01", repeat: 2, step: "level_0", reply: "Answer: B" },
    ],
    questionsById,
  );
  assert.equal(units.length, 2);
  assert.equal(units[0].correctLetter, "C");
  assert.equal(units[0].wrongLetter, "B");
  assert.equal(units[0].letters.level_0, "C");
  assert.equal(units[0].letters.level_1, null);
});

test("isRightAt is false for a step with no saved reply", () => {
  const unit = { correctLetter: "C", letters: { level_0: "C" } };
  assert.equal(isRightAt(unit, "level_0"), true);
  assert.equal(isRightAt(unit, "level_9"), false);
});

test("normalDistInverse(0.975) is about 1.959964", () => {
  assert.ok(Math.abs(normalDistInverse(0.975) - 1.959964) < 1e-6);
});

test("dPrime is greater than 1.5 when hits are high and false alarms are low", () => {
  assert.ok(dPrime(9, 10, 1, 10) > 1.5);
});

test("dPrime is 0 when hits and false alarms are equal", () => {
  assert.ok(Math.abs(dPrime(5, 10, 5, 10)) < 1e-9);
});

test("dPrime is NaN when a total is zero", () => {
  assert.ok(Number.isNaN(dPrime(0, 0, 0, 0)));
});

test("clusterBootstrapInterval gives the same interval for the same seed", () => {
  const units = records
    .filter((record) => record.model === models[0] && record.step === "level_0")
    .map((record) => ({ questionId: record.question_id, value: record.reply.length }));
  const metric = (sample) => sample.reduce((sum, unit) => sum + unit.value, 0) / sample.length;
  const first = clusterBootstrapInterval(units, metric, 200, 7);
  const second = clusterBootstrapInterval(units, metric, 200, 7);
  assert.deepEqual(first, second);
});

test("clusterBootstrapInterval returns low <= high", () => {
  const units = [
    { questionId: "a", value: 1 },
    { questionId: "b", value: 0 },
    { questionId: "c", value: 1 },
    { questionId: "d", value: 0 },
  ];
  const metric = (sample) => sample.reduce((sum, unit) => sum + unit.value, 0) / sample.length;
  const [low, high] = clusterBootstrapInterval(units, metric, 500, 42);
  assert.ok(low <= high);
});
