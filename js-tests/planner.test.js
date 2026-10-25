// Tests for site/js/engine/planner.js, the browser port of the dry-run planner in runner.py.
// The golden cases come from js-tests/fixtures/planner.json. Each case holds the step list that
// flows.expected_steps returns, so the planner's counts are checked against those steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_FAMILIES, expectedSteps } from "../site/js/engine/flows.js";
import { readJson } from "./helpers.js";
import {
  buildCacheIndex,
  cacheKey,
  confessionCanFollow,
  makeUnits,
  planAllModels,
  planModelCalls,
} from "../site/js/engine/planner.js";

const fixture = readJson("js-tests/fixtures/planner.json");
// The settings come from the shipped copies in site/data/, which is what the browser loads. Their dose
// dials keep the source file order, which the golden step lists were written in.
const ladder = readJson("site/data/ladder.json");
const probeSpec = readJson("site/data/probe_spec.json");
const config = readJson("site/data/config.json");
const questions = fixture.inputs.questions;
const MODEL = "test-model";
const CONDITION = "none";

/** Return the fixture question with this id. */
function findQuestion(questionId) {
  return questions.find((question) => question.id === questionId);
}

/** Build one saved record for one step of one question, with the fields the cache stores. */
function savedRecord(question, step, reply, model = MODEL) {
  return { condition: CONDITION, model, question_id: question.id, repeat: 1, step, reply };
}

/** Return the saved records of a finished gauntlet: baseline, levels 1 to 10 and setup_4, all correct. */
function finishedGauntletRecords(question, wrongLevel = null, model = MODEL) {
  const records = [savedRecord(question, "level_0", `Answer: ${question.correct}`, model)];
  for (let level = 1; level <= 10; level += 1) {
    const letter = level === wrongLevel ? question.pushed_wrong : question.correct;
    records.push(savedRecord(question, `level_${level}`, `Answer: ${letter}`, model));
  }
  records.push(savedRecord(question, "setup_4", "Yes", model));
  return records;
}

/** Return the settings object planModelCalls takes, for one saved-reply index and a list of families. */
function settingsFor(cacheIndex, families) {
  return { cacheIndex, condition: CONDITION, families: new Set(families), ladder, probeSpec };
}

/** Return the saved baseline for a golden case: a correct or wrong answer, or no record when null. */
function baselineOnlyRecords(question, baselineCorrect) {
  if (baselineCorrect === null) {
    return [];
  }
  const letter = baselineCorrect ? question.correct : question.pushed_wrong;
  return [savedRecord(question, "level_0", `Answer: ${letter}`)];
}

// Golden cases: for every case in the fixture, the JavaScript step list must equal the Python reference,
// and the planner's counts must agree with that step list (one saved baseline at most, everything else new).
for (const testCase of fixture.cases) {
  test(`golden steps: ${testCase.name}`, () => {
    const { question_id: questionId, families, baseline_correct: baselineCorrect } = testCase.input;
    const steps = expectedSteps(findQuestion(questionId), new Set(families), ladder, probeSpec, baselineCorrect);
    assert.deepEqual(steps, testCase.output);
  });

  test(`planner counts match the golden steps: ${testCase.name}`, () => {
    const { question_id: questionId, families, baseline_correct: baselineCorrect } = testCase.input;
    const question = findQuestion(questionId);
    const records = baselineOnlyRecords(question, baselineCorrect);
    const plan = planModelCalls(MODEL, [question], 1, settingsFor(buildCacheIndex(records), families));
    // Only the baseline can be saved here, so every other golden step is a new call.
    assert.deepEqual(plan, { saved: records.length, atMostNew: testCase.output.length - records.length });
  });
}

// Resume planning: fully saved units cost no new calls, but a flipped level still leaves the confession to send.
test("a finished gauntlet unit plans zero new calls", () => {
  const question = findQuestion("m01");
  const cacheIndex = buildCacheIndex(finishedGauntletRecords(question));
  const plan = planModelCalls(MODEL, [question], 1, settingsFor(cacheIndex, ["gauntlet"]));
  assert.deepEqual(plan, { saved: 12, atMostNew: 0 });
});

test("a finished gauntlet unit with a flipped level keeps the confession step", () => {
  const question = findQuestion("m01");
  const cacheIndex = buildCacheIndex(finishedGauntletRecords(question, 3));
  const plan = planModelCalls(MODEL, [question], 1, settingsFor(cacheIndex, ["gauntlet"]));
  assert.deepEqual(plan, { saved: 12, atMostNew: 1 });
});

// The confession gate: only a complete, never-flipped gauntlet skips the confession. Missing levels keep it possible.
test("confessionCanFollow is false only when every level is saved and none flipped", () => {
  const question = findQuestion("m01");
  const unit = { model: MODEL, question, repeat: 1 };
  const finished = buildCacheIndex(finishedGauntletRecords(question));
  const flipped = buildCacheIndex(finishedGauntletRecords(question, 2));
  const missingLevel = buildCacheIndex(finishedGauntletRecords(question).slice(0, 5));
  assert.equal(confessionCanFollow(unit, finished, CONDITION), false);
  assert.equal(confessionCanFollow(unit, flipped, CONDITION), true);
  assert.equal(confessionCanFollow(unit, missingLevel, CONDITION), true);
});

// Whole-batch planning: one row per model plus totals, and the family list may be an array or a Set.
test("planAllModels gives one row per model and the totals of those rows", () => {
  const question = findQuestion("m01");
  const cacheIndex = buildCacheIndex(finishedGauntletRecords(question, null, "finished-model"));
  const result = planAllModels(
    ["finished-model", "empty-model"], [question], 1, cacheIndex, CONDITION,
    new Set(["gauntlet"]), ladder, probeSpec, config,
  );
  // With no saved first answer, the gauntlet has level_0, 10 levels, setup_4 and the confession: 13 steps.
  assert.deepEqual(result.models, [
    { model: "finished-model", saved: 12, atMostNew: 0 },
    { model: "empty-model", saved: 0, atMostNew: 13 },
  ]);
  assert.deepEqual(result.totals, { saved: 12, atMostNew: 13 });
});

test("planAllModels accepts the ALL_FAMILIES array as well as a Set", () => {
  const question = findQuestion("m01");
  const cacheIndex = buildCacheIndex(finishedGauntletRecords(question));
  const fromArray = planAllModels(
    [MODEL], [question], 1, cacheIndex, CONDITION, ALL_FAMILIES, ladder, probeSpec, config,
  );
  const fromSet = planAllModels(
    [MODEL], [question], 1, cacheIndex, CONDITION, new Set(ALL_FAMILIES), ladder, probeSpec, config,
  );
  assert.deepEqual(fromArray, fromSet);
});

// Cache keys and indexing: every part of the key matters, separators inside a part cannot make two keys collide,
// and the index finds a record only for an exact match.
test("cacheKey differs when any one of the five parts differs", () => {
  const key = cacheKey("none", "model-a", "m01", 1, "level_1");
  const changedKeys = [
    cacheKey("mitigation", "model-a", "m01", 1, "level_1"),
    cacheKey("none", "model-b", "m01", 1, "level_1"),
    cacheKey("none", "model-a", "f01", 1, "level_1"),
    cacheKey("none", "model-a", "m01", 2, "level_1"),
    cacheKey("none", "model-a", "m01", 1, "level_2"),
  ];
  for (const changedKey of changedKeys) {
    assert.notEqual(changedKey, key);
  }
});

test("cacheKey does not clash when a part contains a separator character", () => {
  assert.notEqual(cacheKey("a", "b|c", "d", 1, "e"), cacheKey("a|b", "c", "d", 1, "e"));
});

test("buildCacheIndex finds a saved record by the key of its five parts", () => {
  const record = { condition: "none", model: MODEL, question_id: "m01", repeat: 1, step: "level_1", reply: "x" };
  const cacheIndex = buildCacheIndex([record]);
  assert.equal(cacheIndex.get(cacheKey("none", MODEL, "m01", 1, "level_1")), record);
  assert.equal(cacheIndex.get(cacheKey("none", MODEL, "m01", 2, "level_1")), undefined);
});

// Unit order: models outermost, then questions, then repeats. The runner and the planner rely on this order.
test("makeUnits lists every model, question and repeat in that order", () => {
  const units = makeUnits(["m1", "m2"], [{ id: "q1" }, { id: "q2" }], 2);
  const summary = units.map((unit) => [unit.model, unit.question.id, unit.repeat]);
  assert.deepEqual(summary, [
    ["m1", "q1", 1], ["m1", "q1", 2], ["m1", "q2", 1], ["m1", "q2", 2],
    ["m2", "q1", 1], ["m2", "q1", 2], ["m2", "q2", 1], ["m2", "q2", 2],
  ]);
});


// A mixed run gives each question its own pushback set. With a pairFor function, the count for both sets together
// must equal the two fixed counts added up, because each question is counted with its own ladder and probe spec.
test("planAllModels with pairFor counts each question with its own pushback set", () => {
  const hardQuestionList = readJson("site/data/questions_hard.json").slice(0, 3);
  const easyQuestionList = readJson("site/data/questions.json").slice(0, 3);
  const ladderV4 = readJson("site/data/ladder_v4.json");
  const probeSpecV4 = readJson("site/data/probe_spec_v4.json");
  const emptyCache = new Map();
  const families = new Set(ALL_FAMILIES);
  const easyOnly = planAllModels([MODEL], easyQuestionList, 1, emptyCache, CONDITION, families, ladder, probeSpec, config);
  const hardOnly = planAllModels([MODEL], hardQuestionList, 1, emptyCache, CONDITION, families, ladderV4, probeSpecV4, config);
  const pairFor = (question) => (question.id.startsWith("h") ? { ladder: ladderV4, probeSpec: probeSpecV4 } : { ladder, probeSpec });
  const mixed = planAllModels(
    [MODEL], [...easyQuestionList, ...hardQuestionList], 1, emptyCache, CONDITION, families, ladder, probeSpec, config, pairFor,
  );
  assert.equal(mixed.totals.atMostNew, easyOnly.totals.atMostNew + hardOnly.totals.atMostNew);
});
