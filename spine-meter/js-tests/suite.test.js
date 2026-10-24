// Tests for building suites from data (rules.makeSuite), the level and held-firm helpers, and the confession
// gate of the planner on a ladder with more than 10 levels. The data comes from the golden fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeSuite,
  pushbackSteps,
  heldFirmScore,
  setupLevel,
  spineScore,
  HELD_FIRM_SCORE,
  PUSHBACK_STEPS,
  LEVEL_COUNT,
} from "../site/js/engine/rules.js";
import { buildCacheIndex, confessionCanFollow } from "../site/js/engine/planner.js";
import { readJson } from "./helpers.js";

const v3Fixture = readJson("js-tests/fixtures/adaptive.json");
const v4Fixture = readJson("js-tests/fixtures/adaptive_v4_hard.json");
const questions = readJson("js-tests/fixtures/grade_suites.json").suites["gauntlet_v4+hard"].inputs.questions;

/** Return the parts that makeSuite takes for the v4 suite, with a fresh copy of the ladder. */
function v4Parts() {
  return {
    ladderName: "gauntlet_v4",
    questionSet: "hard",
    ladder: structuredClone(v4Fixture.inputs.ladder),
    probeSpec: structuredClone(v4Fixture.inputs.probe_spec),
    questions,
  };
}

test("pushbackSteps names level_1 to level_N", () => {
  assert.deepEqual(pushbackSteps(3), ["level_1", "level_2", "level_3"]);
  assert.equal(pushbackSteps(12).at(-1), "level_12");
});

test("heldFirmScore is one more than the level count", () => {
  assert.equal(heldFirmScore(10), 11);
  assert.equal(heldFirmScore(12), 13);
  assert.equal(HELD_FIRM_SCORE, 11);
  assert.equal(LEVEL_COUNT, 10);
  assert.deepEqual(PUSHBACK_STEPS, pushbackSteps(10));
});

test("the v3 ladder has its setup turn at level 4, and the v4 ladder at level 5", () => {
  assert.equal(setupLevel(v3Fixture.inputs.ladder), 4);
  assert.equal(setupLevel(v4Fixture.inputs.ladder), 5);
  assert.equal(setupLevel({ levels: [{ level: 1 }] }), null);
});

test("spineScore uses the held score it is given, or the default for 10 levels", () => {
  assert.equal(spineScore(["C", "C", "C"], "C", 13), 13);
  assert.equal(spineScore(["C", "C", "C"], "C"), 11);
  assert.equal(spineScore(["C", "B"], "C", 13), 2);
});

test("makeSuite builds the v4 suite with 12 levels, held score 13 and the right name", () => {
  const suite = makeSuite(v4Parts());
  assert.equal(suite.name, "gauntlet_v4+hard");
  assert.equal(suite.levelCount, 12);
  assert.equal(suite.heldFirmScore, 13);
  assert.equal(suite.pushbackSteps.length, 12);
  assert.equal(suite.questions.length, questions.length);
  assert.equal(Object.isFrozen(suite), true);
});

test("makeSuite sorts the levels by their level number", () => {
  const parts = v4Parts();
  parts.ladder.levels.reverse();
  const suite = makeSuite(parts);
  assert.deepEqual(suite.ladder.levels.map((entry) => entry.level), [...Array(12).keys()].map((n) => n + 1));
});

test("makeSuite refuses a ladder whose level numbers are not 1 to N", () => {
  const parts = v4Parts();
  parts.ladder.levels[0].level = 2;
  assert.throws(() => makeSuite(parts), /must be 1 to 12, each used once/);
});

test("makeSuite refuses a level without a type or an axis", () => {
  const parts = v4Parts();
  delete parts.ladder.levels[3].axis;
  assert.throws(() => makeSuite(parts), /missing: axis/);
});

test("makeSuite refuses a probe spec with a repeated axis id", () => {
  const parts = v4Parts();
  parts.probeSpec.axes[1].id = parts.probeSpec.axes[0].id;
  assert.throws(() => makeSuite(parts), /must be unique/);
});

test("makeSuite refuses a probe spec without the four dose dials", () => {
  const parts = v4Parts();
  delete parts.probeSpec.doses.stakes;
  assert.throws(() => makeSuite(parts), /exactly these dose dials/);
});

test("makeSuite refuses an empty question set", () => {
  const parts = v4Parts();
  parts.questions = [];
  assert.throws(() => makeSuite(parts), /at least one question/);
});

test("the confession gate uses the level count of the ladder", () => {
  const unit = { model: "m", repeat: 1, question: { id: "h01", correct: "A" } };
  /** Return the cache index of twelve saved levels, where the level with this number gives this reply. */
  function indexWith(levelNumber, reply) {
    const records = [];
    for (let level = 1; level <= 12; level += 1) {
      const text = level === levelNumber ? reply : "Answer: A";
      records.push({ condition: "none", model: "m", question_id: "h01", repeat: 1, step: `level_${level}`,
        reply: text });
    }
    return buildCacheIndex(records);
  }
  assert.equal(confessionCanFollow(unit, indexWith(0, ""), "none", 12), false, "all 12 correct: no confession");
  assert.equal(confessionCanFollow(unit, indexWith(12, "Answer: B"), "none", 12), true, "level 12 wrong");
  // The default gate has ten levels, so a wrong answer at level 12 is not seen by it.
  assert.equal(confessionCanFollow(unit, indexWith(12, "Answer: B"), "none"), false, "default gate ignores level 12");
});
