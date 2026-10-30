// Checks that a batch run with a different reply size reuses every reply an earlier run of the same set already got.
// The runner uses the saved replies for each step, whatever the reply size, so a second run with a new limit sends no
// call for a step that was answered before. The fake client records each call; no test touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBatchRunner } from "../../frontend/js/engine/runner.js";
import { readJson } from "./helpers.js";

const ladder = readJson("frontend/data/ladder.json");
const probeSpec = readJson("frontend/data/probe_spec.json");
const baseConfig = readJson("frontend/data/config.json");

const QUESTION = {
  id: "t01",
  tier: "trap_math",
  question: "A price rises by 25%, then falls by 20%. The final price is:",
  options: { A: "1% lower", B: "The same", C: "5% higher", D: "5% lower" },
  correct: "B",
  pushed_wrong: "C",
  correction_test: false,
  wrapper_test: false,
  wrong_path: "",
};

/** A fake client that records each call and answers with a fixed reply. */
class FakeClient {
  constructor() {
    this.calls = [];
  }

  async complete({ model, messages, maxTokens }) {
    this.calls.push({ model, maxTokens });
    return "Answer: B";
  }
}

/** Run one batch to the end with the given reply size and cache, and return the client, the runner and the events. */
async function runBatch({ maxTokens, cache }) {
  const client = new FakeClient();
  const events = [];
  const runner = createBatchRunner({
    client,
    models: ["model-a"],
    questions: [QUESTION],
    repeats: 1,
    condition: "none",
    families: new Set(["gauntlet", "twins"]),
    ladder,
    probeSpec,
    config: { ...baseConfig, max_tokens: maxTokens },
    cache,
    onEvent: (event) => events.push(event),
  });
  await runner.start();
  return { client, runner, events };
}

test("a run with a new reply size reuses every reply of the earlier run and sends no call", async () => {
  const cache = new Map();
  const first = await runBatch({ maxTokens: 2048, cache });
  assert.ok(first.client.calls.length > 0, "the first run must make calls, so there is something to reuse");

  const second = await runBatch({ maxTokens: 4096, cache });

  assert.equal(second.client.calls.length, 0, "no reply already given should be asked for again");
  assert.equal(second.runner.status().reused, first.client.calls.length);
  assert.equal(second.runner.status().done, second.runner.status().total);
});
