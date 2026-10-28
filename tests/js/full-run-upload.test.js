// Tests for loading saved replies from a replies file. The file is read from a Blob and the runs are saved to the
// in-memory store, so nothing touches a browser or the network. A file can hold several experiments and suites, and
// each one becomes its own runs, or is reported when the site does not offer its suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReplyLine, readReplyGroups, runShape, groupLabel, buildRunInput, importReplyGroups } from "../../frontend/js/full-run-upload.js";
import { importRunDocument, listRuns } from "../../frontend/js/store/run-store.js";
import { createMemoryAdapter } from "../../frontend/js/store/memory-adapter.js";
import { unitKeyFor } from "../../frontend/js/saved-runs.js";
import { FULL_RUN_EXPERIMENT, FULL_RUN_SUITE } from "../../frontend/js/full-run-summary.js";
import { setsOfChoice } from "../../frontend/js/suites.js";

const COMMON = { callCap: 400, temperature: 0.7, maxTokens: 2048 };
const OTHER_EXPERIMENT = "96efc1daaa50";

/** Return one line of a replies file, as the engine writes it. */
function replyLine({
  experiment = FULL_RUN_EXPERIMENT,
  suite = FULL_RUN_SUITE,
  condition = "control",
  model = "M1",
  question = "q1",
  repeat = 1,
  step = "level_0",
  reply = "Answer: A",
} = {}) {
  return JSON.stringify({
    experiment,
    suite,
    condition,
    model,
    question_id: question,
    repeat,
    step,
    reply,
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: `Prompt for ${step}` },
    ],
  });
}

/** Return the groups of a Blob made from the given lines. */
function groupsOf(lines) {
  return readReplyGroups(new Blob([lines.join("\n") + "\n"]));
}

test("parseReplyLine keeps the experiment and suite, and takes the last user message as the step's text", () => {
  const reply = parseReplyLine(replyLine({ step: "level_2", reply: "Answer: B" }));
  assert.deepEqual(reply, {
    experiment: FULL_RUN_EXPERIMENT,
    suite: FULL_RUN_SUITE,
    condition: "control",
    model: "M1",
    question_id: "q1",
    repeat: 1,
    step: "level_2",
    reply: "Answer: B",
    user_text: "Prompt for level_2",
  });
});

test("readReplyGroups groups by experiment, suite and condition, in the order they first appear", async () => {
  const groups = await groupsOf([
    replyLine({ condition: "control", step: "level_0" }),
    replyLine({ experiment: OTHER_EXPERIMENT, suite: "gauntlet_v4+hard", condition: "none" }),
    replyLine({ condition: "control", step: "level_1" }),
  ]);
  assert.deepEqual(groups.map((group) => [group.experiment, group.suite, group.condition]), [
    [FULL_RUN_EXPERIMENT, FULL_RUN_SUITE, "control"],
    [OTHER_EXPERIMENT, "gauntlet_v4+hard", "none"],
  ]);
  assert.equal(groups[0].replies.length, 2);
});

test("runShape lists the models and questions in order and takes the largest repeat", () => {
  const shape = runShape([
    parseReplyLine(replyLine({ model: "M2", question: "q2", repeat: 1 })),
    parseReplyLine(replyLine({ model: "M1", question: "q1", repeat: 2 })),
    parseReplyLine(replyLine({ model: "M2", question: "q1", repeat: 1 })),
  ]);
  assert.deepEqual(shape, { models: ["M2", "M1"], questions: ["q2", "q1"], repeats: 2 });
});

test("groupLabel keeps the full run's name, names any other experiment, and ends with the unit count", async () => {
  const [full] = await groupsOf([replyLine({ condition: "third_person" }), replyLine({ condition: "third_person", repeat: 2 })]);
  assert.equal(groupLabel(full), "Full run: Third person · 2 units");
  const [other] = await groupsOf([replyLine({ experiment: OTHER_EXPERIMENT, suite: "gauntlet_v4+hard", condition: "none" })]);
  assert.equal(groupLabel(other), "gauntlet_v4+hard None (96efc1) · 1 unit");
});

test("a file with more units for the same experiment and condition gets a different label", async () => {
  const [small] = await groupsOf([replyLine({ experiment: OTHER_EXPERIMENT, suite: "gauntlet_v4+hard", condition: "none" })]);
  const [large] = await groupsOf([
    replyLine({ experiment: OTHER_EXPERIMENT, suite: "gauntlet_v4+hard", condition: "none" }),
    replyLine({ experiment: OTHER_EXPERIMENT, suite: "gauntlet_v4+hard", condition: "none", model: "M2" }),
  ]);
  assert.notEqual(groupLabel(small), groupLabel(large));
});

test("buildRunInput plans only the units that have replies, and saves each unit's steps", async () => {
  const [group] = await groupsOf([replyLine({ step: "level_0" }), replyLine({ step: "level_1" })]);
  const run = buildRunInput(group, { ...COMMON, pushbackSet: "v3", questionSet: "easy" });
  const key = unitKeyFor("M1", "q1", 1);
  assert.equal(run.label, "Full run: Control · 1 unit");
  assert.equal(run.status, "stopped");
  assert.deepEqual(run.plannedUnits, [key]);
  assert.equal(run.results[key].steps.length, 2);
  assert.equal(run.config.kind, "batch");
  assert.equal(run.config.condition, "control");
  assert.equal(run.config.experiment, null);
  assert.equal(run.config.pushbackSet, "v3");
  assert.equal(run.config.questionSet, "easy");
});

test("importReplyGroups saves each group, a second load makes no duplicates, and an unoffered suite is reported", async () => {
  const adapter = createMemoryAdapter();
  const groups = await groupsOf([
    replyLine({ condition: "control" }),
    replyLine({ condition: "none" }),
    replyLine({ experiment: "bad", suite: "gauntlet_v9+nope", condition: "none" }),
  ]);
  const first = await importReplyGroups(adapter, groups, COMMON);
  assert.deepEqual(first.saved, ["Full run: Control · 1 unit", "Full run: None · 1 unit"]);
  assert.ok(first.skipped.some((text) => text.includes("gauntlet_v9+nope is not one this site offers")));
  assert.equal((await listRuns(adapter)).length, 2);

  const second = await importReplyGroups(adapter, groups, COMMON);
  assert.deepEqual(second.saved, []);
  assert.equal((await listRuns(adapter)).length, 2);
});

test("a second experiment on a suite the site offers is saved as its own runs, with the suite's sets", async () => {
  const adapter = createMemoryAdapter();
  const groups = await groupsOf([replyLine({ experiment: OTHER_EXPERIMENT, suite: "gauntlet_v4+hard", condition: "none" })]);
  const result = await importReplyGroups(adapter, groups, COMMON);
  assert.deepEqual(result.saved, ["gauntlet_v4+hard None (96efc1) · 1 unit"]);
  const [saved] = await listRuns(adapter);
  const sets = setsOfChoice("gauntlet_v4+hard");
  assert.equal(saved.config.pushbackSet, sets.pushbackSet);
  assert.equal(saved.config.questionSet, sets.questionSet);
});

test("importRunDocument refuses a saved unit that is not one of the planned units", async () => {
  const adapter = createMemoryAdapter();
  await assert.rejects(
    importRunDocument(adapter, {
      label: "Bad",
      config: { kind: "batch" },
      status: "stopped",
      plannedUnits: ["a"],
      results: { b: { steps: [] } },
    }),
    /not part of this run/,
  );
});
