// Tests for frontend/js/engine/runner.js on the gauntlet_v4 + hard suite (12 levels, a setup turn at level 5).
// The fake client answers from a script by call number. Calls run one at a time, so the call number is the
// step order: call 1 is the baseline, and each later call is one step of the gauntlet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBatchRunner } from "../frontend/js/engine/runner.js";
import { readJson } from "./helpers.js";

const fixture = readJson("js-tests/fixtures/adaptive_v4_hard.json");
const { ladder, probe_spec: probeSpec, config, questions } = fixture.inputs;
const question = questions.find((item) => item.id === "h01");

/** Return a fake client whose reply for each call comes from answerFor(callNumber). It records the calls. */
function fakeClient(answerFor) {
  const calls = [];
  return {
    calls,
    async complete({ model, messages }) {
      calls.push({ model, messages });
      return answerFor(calls.length);
    },
  };
}

/** Run the batch with the gauntlet family only, and return the steps that finished, in order. */
async function gauntletSteps(answerFor) {
  const steps = [];
  const runner = createBatchRunner({
    client: fakeClient(answerFor),
    models: ["fake/model"],
    questions: [question],
    repeats: 1,
    condition: "none",
    families: ["gauntlet"],
    ladder,
    probeSpec,
    config,
    cache: new Map(),
    concurrency: 1,
    onEvent: (event) => {
      if (event.kind === "step-done") {
        steps.push(event.step);
      }
    },
  });
  await runner.start();
  return steps;
}

// Every step the gauntlet sends when the model never flips, in order. The setup turn sits just before level 5.
const EXPECTED_LEVELS = [
  "level_0", "level_1", "level_2", "level_3", "level_4", "setup_5", "level_5", "level_6", "level_7",
  "level_8", "level_9", "level_10", "level_11", "level_12",
];

test("the runner sends the v4 levels in order, with the setup turn before level 5, when the model holds", async () => {
  const correct = `Answer: ${question.correct}`;
  const steps = await gauntletSteps(() => correct);
  assert.deepEqual(steps, EXPECTED_LEVELS);
});

// A flip makes the runner send the confession step after the last level.
test("the runner sends the confession after level 12 when the model flipped at level 1", async () => {
  const correct = `Answer: ${question.correct}`;
  const wrong = `Answer: ${question.pushed_wrong}`;
  // Call 1 is the baseline (correct). Call 2 is level_1 (wrong). Every later call is a pushback or the confession.
  const steps = await gauntletSteps((callNumber) => (callNumber === 1 ? correct : wrong));
  assert.deepEqual(steps, [...EXPECTED_LEVELS, "confession"]);
});
