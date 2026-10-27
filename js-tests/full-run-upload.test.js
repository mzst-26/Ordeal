// Tests for loading a full run from its replies file. The file is read from a Blob and the runs are saved to the
// in-memory store, so nothing touches a browser or the network. Each test checks one part of the way a file of replies
// becomes saved batch runs that Resume can open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReplyLine, readRepliesByCondition, runShape, buildRunInput, importFullRuns, fullRunLabel } from "../site/js/full-run-upload.js";
import { importRunDocument, listRuns } from "../site/js/store/run-store.js";
import { createMemoryAdapter } from "../site/js/store/memory-adapter.js";
import { unitKeyFor } from "../site/js/saved-runs.js";

const SETTINGS = { pushbackSet: "v3", questionSet: "easy", callCap: 400, temperature: 0.7, maxTokens: 2048 };

/** Return one line of the replies file, as the engine writes it. */
function replyLine({ condition = "control", model = "M1", question = "q1", repeat = 1, step = "level_0", reply = "Answer: A" } = {}) {
  return JSON.stringify({
    experiment: "abc",
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

test("parseReplyLine takes the last user message as the step's text", () => {
  const reply = parseReplyLine(replyLine({ step: "level_2", reply: "Answer: B" }));
  assert.deepEqual(reply, {
    condition: "control",
    model: "M1",
    question_id: "q1",
    repeat: 1,
    step: "level_2",
    reply: "Answer: B",
    user_text: "Prompt for level_2",
  });
});

test("readRepliesByCondition groups the lines by condition, in the order they were saved, and skips blank lines", async () => {
  const text = [
    replyLine({ condition: "control", step: "level_0" }),
    replyLine({ condition: "none", step: "level_0" }),
    "",
    replyLine({ condition: "control", step: "level_1" }),
  ].join("\n");
  const byCondition = await readRepliesByCondition(new Blob([text]));
  assert.deepEqual([...byCondition.keys()], ["control", "none"]);
  assert.deepEqual(byCondition.get("control").map((reply) => reply.step), ["level_0", "level_1"]);
  assert.equal(byCondition.get("none").length, 1);
});

test("runShape lists the models and questions in order and takes the largest repeat", () => {
  const shape = runShape([
    parseReplyLine(replyLine({ model: "M2", question: "q2", repeat: 1 })),
    parseReplyLine(replyLine({ model: "M1", question: "q1", repeat: 2 })),
    parseReplyLine(replyLine({ model: "M2", question: "q1", repeat: 1 })),
  ]);
  assert.deepEqual(shape, { models: ["M2", "M1"], questions: ["q2", "q1"], repeats: 2 });
});

test("buildRunInput plans only the units that have replies, and saves each unit's steps", () => {
  const replies = [
    parseReplyLine(replyLine({ step: "level_0" })),
    parseReplyLine(replyLine({ step: "level_1" })),
  ];
  const run = buildRunInput("control", replies, SETTINGS);
  const key = unitKeyFor("M1", "q1", 1);
  assert.equal(run.label, "Full run: Control");
  assert.equal(run.status, "stopped");
  assert.deepEqual(run.plannedUnits, [key]);
  assert.deepEqual(Object.keys(run.results), [key]);
  assert.equal(run.results[key].steps.length, 2);
  assert.equal(run.config.kind, "batch");
  assert.equal(run.config.condition, "control");
  assert.equal(run.config.experiment, null);
  assert.deepEqual(run.config.models, ["M1"]);
  assert.deepEqual(run.config.questions, ["q1"]);
  assert.equal(run.config.repeats, 1);
});

test("importFullRuns saves one run per condition, and a second load does not make duplicates", async () => {
  const adapter = createMemoryAdapter();
  const text = `${replyLine({ condition: "control" })}\n${replyLine({ condition: "none" })}\n`;
  const byCondition = await readRepliesByCondition(new Blob([text]));
  const first = await importFullRuns(adapter, byCondition, SETTINGS);
  assert.deepEqual(first.saved, ["Full run: Control", "Full run: None"]);
  assert.equal((await listRuns(adapter)).length, 2);

  const second = await importFullRuns(adapter, byCondition, SETTINGS);
  assert.deepEqual(second.saved, []);
  assert.equal(second.skipped.length, 4);
  assert.equal((await listRuns(adapter)).length, 2);
});

test("importFullRuns reports a condition with no replies as missing", async () => {
  const adapter = createMemoryAdapter();
  const byCondition = await readRepliesByCondition(new Blob([replyLine({ condition: "control" })]));
  const result = await importFullRuns(adapter, byCondition, SETTINGS);
  assert.ok(result.skipped.includes("Full run: Mitigation (no replies in the file)"));
});

test("fullRunLabel names a condition by its label", () => {
  assert.equal(fullRunLabel("third_person"), "Full run: Third person");
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
