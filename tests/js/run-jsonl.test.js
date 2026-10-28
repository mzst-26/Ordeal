// Tests for saved-run files in JSON Lines. A run written by runToJsonl must read back with parseRunJsonl and save again
// with importRunDocument, so the Runs download can be loaded into the batch page. Nothing here touches a browser or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runToJsonl, parseRunJsonl, isRunHeaderLine } from "../../frontend/js/store/run-jsonl.js";
import { importRunDocument, listRuns } from "../../frontend/js/store/run-store.js";
import { createMemoryAdapter } from "../../frontend/js/store/memory-adapter.js";

const UNIT_A = '["M1","q1",1]';
const UNIT_B = '["M1","q2",1]';

/** Return a stored run shaped the way getRun gives it, with two saved units. */
function sampleRun() {
  return {
    id: "run-1",
    label: "Batch gauntlet_v4+hard: 1 models, 2 questions, control",
    status: "stopped",
    createdAt: "2026-10-28T10:00:00.000Z",
    updatedAt: "2026-10-28T10:05:00.000Z",
    config: { kind: "batch", models: ["M1"], questions: ["q1", "q2"], repeats: 1, condition: "control" },
    plannedUnits: [UNIT_A, UNIT_B],
    results: {
      [UNIT_A]: { steps: [{ step: "baseline", reply: "Answer: A" }] },
      [UNIT_B]: { steps: [{ step: "baseline", reply: "Answer: B" }] },
    },
  };
}

test("the first line is the run header and each later line is one saved unit", () => {
  const lines = runToJsonl(sampleRun()).split("\n");
  assert.equal(lines.at(-1), "", "the file ends with a newline");
  const rows = lines.slice(0, -1).map((line) => JSON.parse(line));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, "run");
  assert.equal(rows[0].results, undefined, "the header holds no units");
  assert.deepEqual(rows.slice(1).map((row) => row.unit), [UNIT_A, UNIT_B]);
  assert.equal(rows[1].kind, "unit");
});

test("a run written as JSON Lines reads back with the same settings and units", () => {
  const run = sampleRun();
  const back = parseRunJsonl(runToJsonl(run));
  assert.equal(back.label, run.label);
  assert.equal(back.status, run.status);
  assert.deepEqual(back.config, run.config);
  assert.deepEqual(back.plannedUnits, run.plannedUnits);
  assert.deepEqual(back.results, run.results);
});

test("a run read back from JSON Lines saves again as a new run with every unit", async () => {
  const adapter = createMemoryAdapter();
  const saved = await importRunDocument(adapter, parseRunJsonl(runToJsonl(sampleRun())));
  assert.notEqual(saved.id, "run-1", "the copy gets its own id");
  assert.equal(Object.keys(saved.results).length, 2);
  assert.equal((await listRuns(adapter)).length, 1);
});

test("a unit key named __proto__ is kept as an ordinary unit", () => {
  const run = sampleRun();
  run.plannedUnits = ["__proto__"];
  run.results = {};
  Object.defineProperty(run.results, "__proto__", { value: { steps: [] }, enumerable: true, writable: true, configurable: true });
  const back = parseRunJsonl(runToJsonl(run));
  assert.deepEqual(Object.keys(back.results), ["__proto__"]);
});

test("a file whose first line is not a run header is refused", () => {
  const replies = '{"condition":"control","model":"M1","question_id":"q1","repeat":1,"step":"baseline","reply":"A"}\n';
  assert.throws(() => parseRunJsonl(replies), /not a saved run/);
});

test("a line after the header that is not a saved unit is refused", () => {
  const text = `${JSON.stringify({ kind: "run", label: "x", status: "stopped", config: {}, plannedUnits: [] })}\n{"kind":"other"}\n`;
  assert.throws(() => parseRunJsonl(text), /not a saved unit/);
});

test("a line that is not JSON is refused with a plain reason", () => {
  assert.throws(() => parseRunJsonl("not json\n"), /not JSON Lines/);
});

test("only a header line is recognised as the start of a saved-run file", () => {
  assert.equal(isRunHeaderLine('{"kind":"run","label":"x"}'), true);
  assert.equal(isRunHeaderLine('{"kind":"unit"}'), false);
  assert.equal(isRunHeaderLine("not json"), false);
});
