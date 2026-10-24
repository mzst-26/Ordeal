// Tests for site/js/engine/flows.js. The golden cases come from js-tests/fixtures/flows.json,
// which was written by running flows.run_flows in Python with scripted replies.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as flows from "../site/js/engine/flows.js";
import { BASELINE_STEP, isCorrect } from "../site/js/engine/rules.js";
import { readJson } from "./helpers.js";

const fixture = readJson("js-tests/fixtures/flows.json");
// The settings come from the shipped copies in site/data/, which is what the browser loads.
const ladder = readJson("site/data/ladder.json");
const probeSpec = readJson("site/data/probe_spec.json");
const config = readJson("site/data/config.json");
const shippedQuestions = readJson("site/data/questions.json");

// The golden scenarios have no system prompt, so the first message is the question.
const NO_SYSTEM_PROMPT = null;

/** Return the fixture question with this id. */
function fixtureQuestion(questionId) {
  return fixture.inputs.questions.find((question) => question.id === questionId);
}

/** Return a recording ask that answers from the scenario, or from the default reply when a step has none. */
function scriptedAsk(scenario, calls) {
  return async (step, messages) => {
    calls.push({ step, messages });
    if (Object.hasOwn(scenario.reply_by_step, step)) {
      return scenario.reply_by_step[step];
    }
    return scenario.default_reply;
  };
}

/** Return a recording ask that follows the scenario but returns null at one step, which means it failed for good. */
function askFailingAt(scenario, calls, failStep) {
  const answer = scriptedAsk(scenario, calls);
  return async (step, messages) => {
    if (step === failStep) {
      calls.push({ step, messages });
      return null;
    }
    return answer(step, messages);
  };
}

/** Return the list of steps from a list of recorded calls. */
function stepsOf(calls) {
  return calls.map((call) => call.step);
}

const ALL_FAMILY_NAMES = ["corrections", "dose", "fingerprint", "gauntlet", "twins"];

test("the family names match flows.py", () => {
  assert.equal(flows.GAUNTLET, "gauntlet");
  assert.equal(flows.CORRECTIONS, "corrections");
  assert.equal(flows.FINGERPRINT, "fingerprint");
  assert.equal(flows.TWINS, "twins");
  assert.equal(flows.DOSE, "dose");
});

test("ALL_FAMILIES is a frozen array of the five family names", () => {
  assert.equal(Array.isArray(flows.ALL_FAMILIES), true);
  assert.equal(Object.isFrozen(flows.ALL_FAMILIES), true);
  assert.deepEqual([...flows.ALL_FAMILIES].sort(), ALL_FAMILY_NAMES);
});

test("allFamilies returns a new Set of every family, and changes to it do not leak", () => {
  const first = flows.allFamilies();
  assert.ok(first instanceof Set);
  assert.deepEqual([...first].sort(), ALL_FAMILY_NAMES);
  first.delete("gauntlet");
  first.add("made-up");
  assert.deepEqual([...flows.allFamilies()].sort(), ALL_FAMILY_NAMES);
});

test("expectedSteps accepts the ALL_FAMILIES array as well as a Set", () => {
  const question = fixtureQuestion("m01");
  const fromArray = flows.expectedSteps(question, flows.ALL_FAMILIES, ladder, probeSpec, true);
  const fromSet = flows.expectedSteps(question, flows.allFamilies(), ladder, probeSpec, true);
  assert.deepEqual(fromArray, fromSet);
});

test("the fixture question is the same question as in questions.json", () => {
  const shipped = shippedQuestions.find((question) => question.id === "m01");
  // The shipped copy leaves out the fields that are not public (trap, wrong2, source_hint), so only
  // the fields it holds are compared.
  const fixtureFields = Object.fromEntries(Object.keys(shipped).map((key) => [key, fixtureQuestion("m01")[key]]));
  assert.deepEqual(fixtureFields, shipped);
});

for (const scenario of fixture.scenarios) {
  test(`runFlows sends the golden messages: ${scenario.name}`, async () => {
    const question = fixtureQuestion(scenario.question_id);
    const calls = [];
    await flows.runFlows(question, NO_SYSTEM_PROMPT, scenario.baseline_reply, scriptedAsk(scenario, calls),
      new Set(scenario.families), ladder, probeSpec, config);
    const expected = scenario.sent.map(({ step, messages }) => ({ step, messages }));
    assert.deepEqual(calls, expected);
  });

  test(`expectedSteps covers every step sent: ${scenario.name}`, async () => {
    const question = fixtureQuestion(scenario.question_id);
    const families = new Set(scenario.families);
    const calls = [];
    await flows.runFlows(question, NO_SYSTEM_PROMPT, scenario.baseline_reply, scriptedAsk(scenario, calls),
      families, ladder, probeSpec, config);
    const baselineCorrect = isCorrect(scenario.baseline_reply, question);
    const expected = flows.expectedSteps(question, families, ladder, probeSpec, baselineCorrect);
    for (const step of stepsOf(calls)) {
      assert.ok(expected.includes(step), `${step} was sent but is not in expectedSteps`);
    }
    // The caller sends BASELINE_STEP itself, so runFlows never sends it and it is left out here.
    const skipped = expected.filter((step) => step !== BASELINE_STEP && !stepsOf(calls).includes(step));
    // For a correct baseline, the only steps the flows may skip are fp_quote_mine (it needs a hedge
    // quote from the baseline) and confession (it needs a flip). For a wrong baseline nothing is skipped.
    const mayBeSkipped = baselineCorrect ? ["fp_quote_mine", "confession"] : [];
    for (const step of skipped) {
      assert.ok(mayBeSkipped.includes(step), `${step} was expected but not sent and it may not be skipped`);
    }
  });
}

test("a null reply on the first call stops the whole unit after one call", async () => {
  const scenario = fixture.scenarios.find((item) => item.name === "always correct");
  const calls = [];
  await flows.runFlows(fixtureQuestion(scenario.question_id), NO_SYSTEM_PROMPT, scenario.baseline_reply,
    askFailingAt(scenario, calls, "level_1"), new Set(scenario.families), ladder, probeSpec, config);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].step, "level_1");
});

test("a null reply in the corrections stops the rest of the unit", async () => {
  const scenario = fixture.scenarios.find((item) => item.name === "always correct");
  const calls = [];
  await flows.runFlows(fixtureQuestion(scenario.question_id), NO_SYSTEM_PROMPT, scenario.baseline_reply,
    askFailingAt(scenario, calls, "corr_B"), new Set(scenario.families), ladder, probeSpec, config);
  assert.equal(calls.at(-1).step, "corr_B");
  assert.equal(calls.some((call) => /^(fp_|twin_|dose_)/.test(call.step)), false);
});

test("runFlows sends only the families it is given", async () => {
  const scenario = fixture.scenarios.find((item) => item.name === "always correct");
  const calls = [];
  await flows.runFlows(fixtureQuestion(scenario.question_id), NO_SYSTEM_PROMPT, scenario.baseline_reply,
    scriptedAsk(scenario, calls), new Set([flows.CORRECTIONS]), ladder, probeSpec, config);
  assert.deepEqual(stepsOf(calls), ["corr_A", "corr_B"]);
});

test("expectedSteps treats an unknown baseline the same as a correct one", () => {
  const question = fixtureQuestion("m01");
  const families = new Set(flows.ALL_FAMILIES);
  assert.deepEqual(
    flows.expectedSteps(question, families, ladder, probeSpec, null),
    flows.expectedSteps(question, families, ladder, probeSpec, true),
  );
});

test("expectedSteps has no duplicate step names for the full family set", () => {
  const steps = flows.expectedSteps(fixtureQuestion("m01"), new Set(flows.ALL_FAMILIES), ladder, probeSpec, true);
  assert.equal(steps[0], BASELINE_STEP);
  assert.equal(new Set(steps).size, steps.length);
});
