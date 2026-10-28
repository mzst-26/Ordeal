// Tests for the batch page's replies export. A file written by repliesToJsonl must load back through the same reader
// the "Load saved replies" box uses, so a batch export can be imported again with no change to the file. The file is
// read from a Blob and saved to the in-memory store, so nothing touches a browser or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repliesToJsonl } from "../../frontend/js/full-run/replies-export.js";
import { readReplyGroups, importReplyGroups } from "../../frontend/js/full-run/full-run-upload.js";
import { listRuns } from "../../frontend/js/store/run-store.js";
import { createMemoryAdapter } from "../../frontend/js/store/memory-adapter.js";

const SUITE = "gauntlet_v4+hard";
const COMMON = { callCap: 400, temperature: 0.7, maxTokens: 2048 };

/** Return one saved reply, shaped like a record in the batch page's reply cache. */
function record({ model, question, repeat = 1, step = "level_0", reply = "Answer: A" }) {
  return {
    condition: "control",
    model,
    question_id: question,
    repeat,
    step,
    reply,
    user_text: `Prompt for ${step}`,
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: `Prompt for ${step}` },
    ],
  };
}

/** Return replies for two models and two questions, each with a baseline and one pushback step. */
function sampleRecords() {
  const records = [];
  for (const model of ["M1", "M2"]) {
    for (const question of ["q1", "q2"]) {
      records.push(record({ model, question, step: "baseline" }));
      records.push(record({ model, question, step: "level_1" }));
    }
  }
  return records;
}

test("an empty list gives an empty file, so there is nothing to save", () => {
  assert.equal(repliesToJsonl([], SUITE), "");
});

test("each reply is one JSON line that names its suite and leaves the experiment empty", () => {
  const text = repliesToJsonl(sampleRecords(), SUITE);
  const lines = text.split("\n");
  assert.equal(lines.at(-1), "", "the file ends with a newline");
  const rows = lines.slice(0, -1).map((line) => JSON.parse(line));
  assert.equal(rows.length, 8);
  for (const row of rows) {
    assert.equal(row.suite, SUITE);
    assert.equal(row.experiment, "");
  }
});

test("a batch export loads back as one saved run with every reply", async () => {
  const text = repliesToJsonl(sampleRecords(), SUITE);
  const groups = await readReplyGroups(new Blob([text]));
  assert.equal(groups.length, 1, "one suite and one condition make one group");
  assert.equal(groups[0].replies.length, 8);

  const adapter = createMemoryAdapter();
  const { saved, skipped } = await importReplyGroups(adapter, groups, COMMON);
  assert.deepEqual(skipped, []);
  assert.equal(saved.length, 1);
  assert.match(saved[0], /4 units/, "two models and two questions are four units");

  const runs = await listRuns(adapter);
  assert.equal(runs.length, 1);
});

test("a reply with a Unicode line separator inside its text still loads back", async () => {
  // JSON.stringify leaves U+2028 unescaped. The reader must split lines on "\n" only, or the reply would be cut in two.
  const tricky = record({ model: "M1", question: "q1", reply: "first second" });
  const groups = await readReplyGroups(new Blob([repliesToJsonl([tricky], SUITE)]));
  assert.equal(groups[0].replies.length, 1);
  assert.equal(groups[0].replies[0].reply, "first second");
});
