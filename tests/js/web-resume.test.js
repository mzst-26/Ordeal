// Tests for resuming saved runs (frontend/js/runs/saved-runs.js). A reload is simulated by keeping the storage adapter and
// starting again with an empty reply cache, as a new page would. No request is sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../../frontend/js/store/memory-adapter.js";
import {
  createRun, saveResult, setStatus, getRun, interruptedRuns, pendingUnits, RUNS_STORE,
} from "../../frontend/js/store/run-store.js";
import {
  createSerialQueue, plannedBatchUnits, unitKeyFor, unitPayload, resumeState, addRecordsToCache,
  gauntletPlannedSteps, gauntletStepPayload, replayGauntlet, savedRunRows, interruptedRunsOfKind, canResume,
  isRunDocument, statusWord,
} from "../../frontend/js/runs/saved-runs.js";
import { buildSuite } from "../../frontend/js/suites/suites.js";
import { cacheKey } from "../../frontend/js/engine/planner.js";
import { readJson } from "./helpers.js";

const MODELS = ["model/a", "model/b"];
const QUESTION_IDS = ["m01", "m02"];
const REPEATS = 2;
const CONDITION = "none";

/** Return one fake step record for a batch unit, shaped like the runner's records. */
function stepRecord(model, questionId, repeat, step) {
  return {
    condition: CONDITION, model, question_id: questionId, repeat, step,
    reply: `reply ${step}`, user_text: `text ${step}`, messages: [{ role: "user", content: "long text" }],
  };
}

/** Save one finished batch unit with two steps, as the page does on unit-done. */
async function saveUnit(adapter, runId, model, questionId, repeat) {
  const records = [stepRecord(model, questionId, repeat, "level_0"), stepRecord(model, questionId, repeat, "level_1")];
  await saveResult(adapter, runId, unitKeyFor(model, questionId, repeat), unitPayload(records));
}

/** Create a batch run for the test choices, the way the batch page does. */
async function createBatch(adapter) {
  const plannedUnits = plannedBatchUnits(MODELS, QUESTION_IDS, REPEATS);
  return createRun(adapter, {
    label: "Batch test",
    config: { kind: "batch", models: MODELS, questions: QUESTION_IDS, repeats: REPEATS, condition: CONDITION },
    plannedUnits,
  });
}

// Batch resume: the plan, what is pending after a reload, and no unit saved twice.
test("planned batch units follow the runner order and are unique", () => {
  const units = plannedBatchUnits(MODELS, QUESTION_IDS, REPEATS);
  assert.equal(units.length, 2 * 2 * 2);
  assert.equal(new Set(units).size, units.length);
  assert.equal(units[0], unitKeyFor("model/a", "m01", 1));
  assert.equal(units[1], unitKeyFor("model/a", "m01", 2));
});

test("after a simulated reload, pending units exclude the saved ones and no unit is repeated", async () => {
  const adapter = createMemoryAdapter();
  const run = await createBatch(adapter);
  await setStatus(adapter, run.id, "running");
  await saveUnit(adapter, run.id, "model/a", "m01", 1);
  await saveUnit(adapter, run.id, "model/b", "m02", 2);

  // The reload: the page starts again with an empty cache and reads the run back from storage.
  const cache = new Map();
  const interrupted = await interruptedRuns(adapter);
  assert.deepEqual(interrupted.map((item) => item.id), [run.id]);
  const state = resumeState(await getRun(adapter, run.id));
  addRecordsToCache(cache, state.records);

  const saved = new Set(state.savedKeys);
  const pending = new Set(state.pendingKeys);
  assert.equal(saved.size, 2);
  assert.equal(pending.size, run.plannedUnits.length - 2);
  for (const key of pending) assert.equal(saved.has(key), false);
  assert.deepEqual(new Set([...saved, ...pending]), new Set(run.plannedUnits));
  // Every step of a saved unit is in the cache, so the runner would reuse it and make no call.
  assert.equal(cache.has(cacheKey(CONDITION, "model/a", "m01", 1, "level_0")), true);
  assert.equal(cache.has(cacheKey(CONDITION, "model/b", "m02", 2, "level_1")), true);
  // A pending unit has no cached step, so the runner would call the model for it.
  assert.equal(cache.has(cacheKey(CONDITION, "model/b", "m01", 1, "level_0")), false);
});

test("a saved unit is never saved again on a second resume, and the run keeps its first copy", async () => {
  const adapter = createMemoryAdapter();
  const run = await createBatch(adapter);
  await saveUnit(adapter, run.id, "model/a", "m01", 1);
  await saveUnit(adapter, run.id, "model/a", "m01", 1);
  const stored = await getRun(adapter, run.id);
  assert.equal(Object.keys(stored.results).length, 1);
  assert.equal(pendingUnits(stored).length, run.plannedUnits.length - 1);
});

test("the saved records keep no messages, so a unit stays small", () => {
  const payload = unitPayload([stepRecord("model/a", "m01", 1, "level_0")]);
  assert.equal("messages" in payload.steps[0], false);
  assert.equal(payload.steps[0].reply, "reply level_0");
});

test("a run whose units are all saved has nothing pending", async () => {
  const adapter = createMemoryAdapter();
  const run = await createBatch(adapter);
  for (const model of MODELS) {
    for (const questionId of QUESTION_IDS) {
      for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
        await saveUnit(adapter, run.id, model, questionId, repeat);
      }
    }
  }
  assert.deepEqual(pendingUnits(await getRun(adapter, run.id)), []);
});

// Saved-run list and resume rules.
test("the Saved runs rows list one kind of run, newest first, with saved and planned counts", async () => {
  const adapter = createMemoryAdapter();
  const older = await createBatch(adapter);
  await saveUnit(adapter, older.id, "model/a", "m01", 1);
  const newer = await createRun(adapter, {
    label: "Gauntlet test", config: { kind: "gauntlet" }, plannedUnits: gauntletPlannedSteps(gauntletSuite()),
  });
  const batchRows = await savedRunRows(adapter, "batch");
  assert.deepEqual(batchRows.map((row) => row.id), [older.id]);
  assert.equal(batchRows[0].saved, 1);
  assert.equal(batchRows[0].planned, 8);
  const gauntletRows = await savedRunRows(adapter, "gauntlet");
  assert.deepEqual(gauntletRows.map((row) => row.id), [newer.id]);
  assert.equal(isRunDocument({ id: "preset:x", plannedUnits: [], results: {} }), false);
});

test("interrupted runs of one kind leave out the run the page is working on", async () => {
  const adapter = createMemoryAdapter();
  const run = await createBatch(adapter);
  await setStatus(adapter, run.id, "running");
  assert.equal((await interruptedRunsOfKind(adapter, "batch")).length, 1);
  assert.equal((await interruptedRunsOfKind(adapter, "batch", run.id)).length, 0);
  assert.equal((await interruptedRunsOfKind(adapter, "gauntlet")).length, 0);
});

test("only a run that is not done can be resumed, and status words are plain", () => {
  assert.equal(canResume({ status: "running" }), true);
  assert.equal(canResume({ status: "stopped" }), true);
  assert.equal(canResume({ status: "failed" }), true);
  assert.equal(canResume({ status: "done" }), false);
  assert.equal(statusWord("failed"), "Some units failed");
});

// The queue: saves happen in order, even when one fails, and none are lost.
test("the serial queue keeps writes in order and goes on after a failure", async () => {
  const queue = createSerialQueue();
  const order = [];
  const first = queue.run(async () => { await delay(5); order.push("first"); });
  const failing = queue.run(async () => { throw new Error("boom"); });
  const third = queue.run(async () => { order.push("third"); });
  await assert.rejects(failing, /boom/);
  await Promise.all([first, third]);
  assert.deepEqual(order, ["first", "third"]);
  await queue.idle();
});

test("concurrent unit saves through the queue keep every unit", async () => {
  const adapter = createMemoryAdapter();
  const run = await createBatch(adapter);
  const queue = createSerialQueue();
  const keys = plannedBatchUnits(MODELS, QUESTION_IDS, REPEATS);
  await Promise.all(keys.map((key) => {
    const [model, questionId, repeat] = JSON.parse(key);
    return queue.run(() => saveResult(adapter, run.id, key, unitPayload([stepRecord(model, questionId, repeat, "level_0")])));
  }));
  assert.equal(Object.keys((await getRun(adapter, run.id)).results).length, keys.length);
});

/** Return the gauntlet_v4 + hard suite, built from the site data. */
function gauntletSuite() {
  return buildSuite({
    pushbackSet: "gauntlet_v4",
    questionSet: "hard",
    ladder: readJson("frontend/data/ladder_v4.json"),
    probeSpec: readJson("frontend/data/probe_spec_v4.json"),
    questions: readJson("frontend/data/questions_hard.json"),
  });
}

// Gauntlet resume: the planned steps, rebuilding the conversation from saved steps, and the end of the ladder.
test("the gauntlet_v4 plan has the setup turn before level 5 and the confession at the end", () => {
  const steps = gauntletPlannedSteps(gauntletSuite());
  assert.equal(steps.length, 1 + 12 + 1 + 1);
  assert.equal(steps[0], "level_0");
  assert.equal(steps.indexOf("setup_5") + 1, steps.indexOf("level_5"));
  assert.equal(steps.at(-1), "confession");
});

test("a gauntlet conversation rebuilt after a reload continues at the next level, past the setup turn", async () => {
  const adapter = createMemoryAdapter();
  const suite = gauntletSuite();
  const run = await createRun(adapter, {
    label: "Gauntlet resume", config: { kind: "gauntlet" }, plannedUnits: gauntletPlannedSteps(suite),
  });
  const saved = [["level_0", "A", null], ["level_1", "B", null], ["level_2", "C", null], ["level_3", "D", null],
    ["level_4", "B", null]];
  for (const [step, letter] of saved) {
    const payload = gauntletStepPayload({
      step, userText: `ask ${step}`, reply: `Answer: ${letter}`, letter, flipped: false,
    });
    await saveResult(adapter, run.id, step, payload);
  }
  await saveResult(adapter, run.id, "setup_5", gauntletStepPayload({
    step: "setup_5", userText: "yes or no", reply: "Yes", letter: null, flipped: false,
  }));
  const replayed = replayGauntlet(await getRun(adapter, run.id));
  assert.equal(replayed.letters.length, 4);
  assert.deepEqual(replayed.letters, ["B", "C", "D", "B"]);
  assert.equal(replayed.setupReply, "Yes");
  assert.equal(replayed.nextLevel, 5);
  assert.equal(replayed.turns.length, 2 * (saved.length + 1));
});

test("a gauntlet with every level saved has no next level", async () => {
  const adapter = createMemoryAdapter();
  const suite = gauntletSuite();
  const run = await createRun(adapter, {
    label: "Gauntlet done", config: { kind: "gauntlet" }, plannedUnits: gauntletPlannedSteps(suite),
  });
  const steps = gauntletPlannedSteps(suite).filter((step) => step !== "confession");
  for (const step of steps) {
    await saveResult(adapter, run.id, step, gauntletStepPayload({
      step, userText: "q", reply: "Answer: A", letter: "A", flipped: false,
    }));
  }
  assert.equal(replayGauntlet(await getRun(adapter, run.id)).nextLevel, null);
});

/** Return a promise that resolves after the given milliseconds. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
