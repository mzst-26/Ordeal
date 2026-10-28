// Tests for frontend/js/suites/mixed-order.js: the mixed order of easy and hard questions, its file names, its counts and
// the pairing of each question with its pushback set. The order files in frontend/data/mixed/ are checked here too,
// because the browser shows them and the Python side made them with the same rule (ordeal/mix.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMixedOrder,
  buildMixedSuite,
  countsSentence,
  mixCounts,
  mixedOrderPath,
  orderRows,
  pairLookup,
  pickMixedSeed,
  selectSlots,
} from "../../frontend/js/suites/mixed-order.js";
import { readJson } from "./helpers.js";

const easyQuestions = readJson("frontend/data/questions.json");
const hardQuestions = readJson("frontend/data/questions_hard.json");
const ALL_IDS = [...easyQuestions, ...hardQuestions].map((question) => question.id).sort();

/** Read the shipped order file for one seed. */
function orderFile(seed) {
  return readJson(`frontend/data/mixed/mixed_${seed}.json`);
}

test("the seed is a whole number from 1 to 10, picked from a random number", () => {
  assert.equal(pickMixedSeed(() => 0), 1);
  assert.equal(pickMixedSeed(() => 0.999), 10);
  assert.equal(pickMixedSeed(() => 0.5), 6);
});

test("the order file path is /data/mixed/mixed_<seed>.json", () => {
  assert.equal(mixedOrderPath(3), "/data/mixed/mixed_3.json");
  assert.throws(() => mixedOrderPath(0), /seed/);
  assert.throws(() => mixedOrderPath(11), /seed/);
  assert.throws(() => mixedOrderPath(2.5), /seed/);
});

test("every shipped order file lists all 91 questions once, in positions 1 to 91", () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const rows = orderFile(seed).order;
    assert.deepEqual(rows.map((row) => row.id).sort(), ALL_IDS, `seed ${seed}`);
    assert.deepEqual(rows.map((row) => row.position), Array.from({ length: 91 }, (_, index) => index + 1));
  }
});

test("every shipped order file pairs easy with gauntlet_v3 and hard with gauntlet_v4", () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    for (const row of orderFile(seed).order) {
      const expected = row.question_set === "easy" ? "gauntlet_v3" : "gauntlet_v4";
      assert.equal(row.pushback_set, expected, `seed ${seed}, ${row.id}`);
    }
  }
});

test("every shipped order file has counts 32 easy and 59 hard, with percents that add up to 100", () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const file = orderFile(seed);
    assert.equal(file.counts.total, 91);
    assert.equal(file.counts.easy.count, 32);
    assert.equal(file.counts.hard.count, 59);
    assert.equal(file.counts.easy.percent + file.counts.hard.percent, 100);
  }
});

test("applyMixedOrder gives the slots of a file in its order, with the set and pushback set of each", () => {
  const slots = applyMixedOrder(orderFile(1).order, easyQuestions, hardQuestions);
  assert.equal(slots.length, 91);
  assert.equal(slots[0].question.id, "h42");
  assert.equal(slots[0].questionSet, "hard");
  assert.equal(slots[0].pushbackSet, "gauntlet_v4");
  assert.equal(slots[0].position, 1);
});

test("applyMixedOrder throws when the order is missing a question", () => {
  const rows = orderFile(1).order.slice(1);
  assert.throws(() => applyMixedOrder(rows, easyQuestions, hardQuestions), /91|match|missing/i);
});

test("applyMixedOrder throws when the order has an id twice or an unknown id", () => {
  const rows = orderFile(1).order.map((row) => ({ ...row }));
  rows[1] = { ...rows[1], id: rows[0].id };
  assert.throws(() => applyMixedOrder(rows, easyQuestions, hardQuestions), /match|twice|once/i);
  const unknown = orderFile(1).order.map((row) => ({ ...row }));
  unknown[0] = { ...unknown[0], id: "zz99" };
  assert.throws(() => applyMixedOrder(unknown, easyQuestions, hardQuestions), /match|unknown|not/i);
});

test("applyMixedOrder throws when a row names the wrong question set or pushback set", () => {
  const wrongSet = orderFile(1).order.map((row) => ({ ...row }));
  wrongSet[0] = { ...wrongSet[0], question_set: "easy" };
  assert.throws(() => applyMixedOrder(wrongSet, easyQuestions, hardQuestions), /set/);
  const wrongPushback = orderFile(1).order.map((row) => ({ ...row }));
  wrongPushback[0] = { ...wrongPushback[0], pushback_set: "gauntlet_v3" };
  assert.throws(() => applyMixedOrder(wrongPushback, easyQuestions, hardQuestions), /pushback/);
});

test("applyMixedOrder does not change the question lists it is given", () => {
  const before = JSON.stringify([easyQuestions, hardQuestions]);
  applyMixedOrder(orderFile(2).order, easyQuestions, hardQuestions);
  assert.equal(JSON.stringify([easyQuestions, hardQuestions]), before);
});

test("mixCounts gives the counts and the one-decimal percents, the hard percent being 100 minus the easy one", () => {
  const slots = applyMixedOrder(orderFile(4).order, easyQuestions, hardQuestions);
  assert.deepEqual(mixCounts(slots), {
    total: 91,
    easy: { count: 32, percent: 35.2 },
    hard: { count: 59, percent: 64.8 },
  });
});

test("mixCounts refuses an empty order", () => {
  assert.throws(() => mixCounts([]), /zero|least one/);
});

test("countsSentence gives the plan wording", () => {
  const counts = mixCounts(applyMixedOrder(orderFile(1).order, easyQuestions, hardQuestions));
  assert.equal(countsSentence(counts), "32 easy with gauntlet_v3, 59 hard with gauntlet_v4");
});

test("selectSlots keeps only the ticked questions, in their order, so the counts follow the ticks", () => {
  const slots = applyMixedOrder(orderFile(1).order, easyQuestions, hardQuestions);
  const ticked = new Set(["h42", "m05", "m10"]);
  const kept = selectSlots(slots, ticked);
  assert.deepEqual(kept.map((slot) => slot.question.id), ["h42", "m05", "m10"]);
  assert.deepEqual(mixCounts(kept).easy.count, 2);
  assert.equal(mixCounts(kept).hard.count, 1);
});

test("orderRows gives the plain rows that a saved run keeps, with no question text", () => {
  const slots = applyMixedOrder(orderFile(1).order, easyQuestions, hardQuestions);
  assert.deepEqual(orderRows(slots)[0], {
    position: 1, id: "h42", question_set: "hard", pushback_set: "gauntlet_v4",
  });
  assert.equal(Object.hasOwn(orderRows(slots)[0], "question"), false);
});

test("applying the rows that orderRows made gives the same order again", () => {
  const slots = applyMixedOrder(orderFile(5).order, easyQuestions, hardQuestions);
  const again = applyMixedOrder(orderRows(slots), easyQuestions, hardQuestions);
  assert.deepEqual(again.map((slot) => slot.question.id), slots.map((slot) => slot.question.id));
});

test("pairLookup gives each question the ladder and probe spec of its own set", () => {
  const easySuite = { questions: easyQuestions, ladder: { name: "v3" }, probeSpec: { name: "p3" } };
  const hardSuite = { questions: hardQuestions, ladder: { name: "v4" }, probeSpec: { name: "p4" } };
  const pairFor = pairLookup(easySuite, hardSuite);
  assert.deepEqual(pairFor(easyQuestions[0]), { ladder: { name: "v3" }, probeSpec: { name: "p3" } });
  assert.deepEqual(pairFor(hardQuestions[0]), { ladder: { name: "v4" }, probeSpec: { name: "p4" } });
  assert.throws(() => pairFor({ id: "zz99" }), /zz99/);
});

test("buildMixedSuite lists both sets' questions and names no single ladder", () => {
  const easySuite = { questions: easyQuestions, ladder: { name: "v3" }, probeSpec: {} };
  const hardSuite = { questions: hardQuestions, ladder: { name: "v4" }, probeSpec: {} };
  const suite = buildMixedSuite(easySuite, hardSuite);
  assert.equal(suite.name, "mixed");
  assert.equal(suite.mixed, true);
  assert.equal(suite.questions.length, 91);
  assert.equal(suite.ladder, null);
  assert.equal(suite.pairFor(hardQuestions[0]).ladder.name, "v4");
  assert.equal(suite.questionSetOf(easyQuestions[0].id), "easy");
  assert.equal(suite.questionSetOf(hardQuestions[0].id), "hard");
});
