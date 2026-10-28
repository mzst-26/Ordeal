// Tests for the gauntlet_v4 + hard suite (12 levels, a setup turn at level 5). The golden cases come from
// js-tests/fixtures/adaptive_v4_hard.json, flows_v4_hard.json and planner_v4_hard.json, which were written by
// the Python reference (scripts/make_golden.py). The setup and confession checks use the flow scenarios.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as adaptive from "../frontend/js/engine/adaptive.js";
import * as flows from "../frontend/js/engine/flows.js";
import { setupLevel, pushbackSteps, BASELINE_STEP, CONFESSION_STEP } from "../frontend/js/engine/rules.js";
import { readJson } from "./helpers.js";

const adaptiveFixture = readJson("js-tests/fixtures/adaptive_v4_hard.json");
const flowsFixture = readJson("js-tests/fixtures/flows_v4_hard.json");
const plannerFixture = readJson("js-tests/fixtures/planner_v4_hard.json");
const { ladder, probe_spec: probeSpec, config } = adaptiveFixture.inputs;
const NO_SYSTEM_PROMPT = null;

/** Return the question with this id from a fixture's inputs. */
function questionIn(inputs, questionId) {
  return inputs.questions.find((question) => question.id === questionId);
}

/** Return the ladder entry with this level number. */
function levelEntry(level) {
  return ladder.levels.find((entry) => entry.level === level);
}

/** Return the probe axis with this id. */
function axisNamed(axisId) {
  return probeSpec.axes.find((axis) => axis.id === axisId);
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

/** Run the flows of one fixture scenario and return the calls made, in order. */
async function runScenario(scenario) {
  const calls = [];
  const question = questionIn(flowsFixture.inputs, scenario.question_id);
  await flows.runFlows(question, NO_SYSTEM_PROMPT, scenario.baseline_reply, scriptedAsk(scenario, calls),
    new Set(scenario.families), ladder, probeSpec, config);
  return calls;
}

/** Return the scenario with this name from the flows fixture. */
function scenarioNamed(name) {
  return flowsFixture.scenarios.find((scenario) => scenario.name === name);
}

// Message builders: each one is checked against the golden output from the Python reference (adaptive.py).
test("the v4 ladder has 12 levels and its setup turn is at level 5", () => {
  assert.equal(ladder.levels.length, 12);
  assert.equal(setupLevel(ladder), 5);
});

test("v4 gauntlet messages match adaptive.py for every question, level and reply", () => {
  for (const item of adaptiveFixture.gauntlet_message) {
    const { question_id: questionId, level, previous_reply: previous, setup_reply: setup } = item.input;
    const question = questionIn(adaptiveFixture.inputs, questionId);
    const actual = adaptive.gauntletMessage(levelEntry(level), ladder, question, previous, setup);
    assert.equal(actual, item.output, item.name);
  }
});

test("v4 setup text matches adaptive.py", () => {
  for (const item of adaptiveFixture.setup_text) {
    const question = questionIn(adaptiveFixture.inputs, item.input.question_id);
    assert.equal(adaptive.setupText(levelEntry(item.input.level), question), item.output, item.name);
  }
});

test("the commitment check matches adaptive.py for every setup reply", () => {
  for (const item of adaptiveFixture.commitment_said_yes) {
    const { setup_reply: reply, must_start_with: mustStartWith } = item.input;
    assert.equal(adaptive.commitmentSaidYes(reply, mustStartWith), item.output, item.name);
  }
});

test("v4 probe messages match adaptive.py, including the format squeeze letter", () => {
  for (const item of adaptiveFixture.axis_message) {
    const { question_id: questionId, axis_id: axisId, slot, quote } = item.input;
    const question = questionIn(adaptiveFixture.inputs, questionId);
    const slotted = flows.axisForSlot(axisNamed(axisId), question, slot);
    assert.equal(adaptive.axisMessage(slotted, ladder, question, slot, quote), item.output, item.name);
  }
});

test("the tampered-history texts match adaptive.py, read from the v4 forge note", () => {
  const axis = flows.tamperedAxis(axisNamed("tampered_history"));
  for (const item of adaptiveFixture.forged_reply) {
    const question = questionIn(adaptiveFixture.inputs, item.input.question_id);
    assert.equal(adaptive.forgedReply(axis, question), item.output, item.name);
  }
  for (const item of adaptiveFixture.final_ask) {
    assert.equal(adaptive.finalAsk(axis), item.output, item.name);
  }
});

test("v4 dose messages match adaptive.py for every dial and index", () => {
  for (const item of adaptiveFixture.dose_message) {
    const { question_id: questionId, dial, index } = item.input;
    const question = questionIn(adaptiveFixture.inputs, questionId);
    assert.equal(adaptive.doseMessage(probeSpec.doses[dial], index, question), item.output, item.name);
  }
});

test("oracle and slot wording match adaptive.py", () => {
  for (const item of adaptiveFixture.oracle_text) {
    const question = questionIn(adaptiveFixture.inputs, item.input.question_id);
    assert.equal(adaptive.oracleText(ladder, question, item.input.slot), item.output, item.name);
  }
  for (const item of adaptiveFixture.slot_text) {
    const question = questionIn(adaptiveFixture.inputs, item.input.question_id);
    assert.equal(adaptive.slotText(question, item.input.slot), item.output, item.name);
  }
});

test("quotes, reply states and visible text match adaptive.py, including a brace token", () => {
  for (const item of adaptiveFixture.extract_quote) {
    assert.equal(adaptive.extractQuote(item.input.reply), item.output, item.name);
  }
  for (const item of adaptiveFixture.reply_state) {
    assert.equal(adaptive.replyState(item.input.reply), item.output, item.name);
  }
  for (const item of adaptiveFixture.visible) {
    assert.equal(adaptive.visible(item.input.reply), item.output, item.name);
  }
});

test("a hedge sentence with a brace token is skipped, and the next sentence is quoted", () => {
  assert.equal(adaptive.extractQuote("It might be {x}. I think it is B. Answer: B"), "I think it is B");
  assert.equal(adaptive.extractQuote("It might be {x}. Answer: A"), null);
});

// Flow scenarios: the sequence of messages sent must match the golden recording for each scenario.
for (const scenario of flowsFixture.scenarios) {
  test(`v4 flows send the golden messages in order: ${scenario.name}`, async () => {
    const calls = await runScenario(scenario);
    assert.deepEqual(calls, scenario.sent.map(({ step, messages }) => ({ step, messages })));
  });
}

// Step order checks for v4: levels, the setup turn, and when the confession is or is not sent.
test("the v4 gauntlet sends level 1 to level 12 in order, with the setup turn before level 5", async () => {
  const calls = await runScenario(scenarioNamed("always correct"));
  const steps = calls.map((call) => call.step);
  const gauntlet = steps.filter((step) => step.startsWith("level_") || step.startsWith("setup_"));
  assert.deepEqual(gauntlet, [...pushbackSteps(4), "setup_5", ...pushbackSteps(12).slice(4)]);
});

test("the setup turn of level 5 comes after level 4 and before level 5, and asks the commitment", async () => {
  const calls = await runScenario(scenarioNamed("always correct"));
  const steps = calls.map((call) => call.step);
  assert.equal(steps.indexOf("setup_5"), steps.indexOf("level_4") + 1);
  assert.equal(steps.indexOf("level_5"), steps.indexOf("setup_5") + 1);
  const setupCall = calls[steps.indexOf("setup_5")];
  const question = questionIn(flowsFixture.inputs, flowsFixture.scenarios[0].question_id);
  assert.equal(setupCall.messages.at(-1).content, adaptive.setupText(levelEntry(5), question));
});

test("the confession is not sent when no level gave a wrong letter", async () => {
  const calls = await runScenario(scenarioNamed("always correct"));
  assert.equal(calls.some((call) => call.step === CONFESSION_STEP), false);
});

test("the confession is sent after the last level when the model flipped at a v4 level", async () => {
  const calls = await runScenario(scenarioNamed("flips at level 3, so the confession is sent"));
  const steps = calls.map((call) => call.step);
  assert.equal(steps.includes(CONFESSION_STEP), true);
  assert.ok(steps.indexOf(CONFESSION_STEP) > steps.indexOf("level_12"));
});

test("a wrong baseline sends only the corrections, with no gauntlet and no confession", async () => {
  const calls = await runScenario(scenarioNamed("baseline wrong, so only corrections are sent"));
  assert.deepEqual(calls.map((call) => call.step), ["corr_A", "corr_B"]);
});

test("expectedSteps for v4 lists the pushback levels, the setup turn and the confession", () => {
  const question = questionIn(adaptiveFixture.inputs, "h01");
  const steps = flows.expectedSteps(question, new Set(flows.ALL_FAMILIES), ladder, probeSpec, true);
  assert.equal(steps[0], BASELINE_STEP);
  for (const step of [...pushbackSteps(12), "setup_5", CONFESSION_STEP]) {
    assert.ok(steps.includes(step), `${step} is missing`);
  }
  assert.equal(new Set(steps).size, steps.length);
});

// Planner golden cases: the list of expected steps must match flows.py for each case.
for (const item of plannerFixture.cases) {
  test(`v4 expectedSteps matches flows.py: ${item.name}`, () => {
    const { question_id: questionId, baseline_correct: baselineCorrect, families } = item.input;
    const question = questionIn(plannerFixture.inputs, questionId);
    const steps = flows.expectedSteps(question, new Set(families), ladder, probeSpec, baselineCorrect);
    assert.deepEqual(steps, item.output);
  });
}
