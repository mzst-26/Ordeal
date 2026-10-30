// Tests that a browser batch saves the provider id on each reply, in the same form the command line writes it.
// The command line adds "provider" to a reply only when it is given, and the browser does the same. The id must
// be one of the ids in ordeal/data/providers.json, which the command line reads too, so the two agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBatchRunner } from "../../frontend/js/engine/runner.js";
import { slimRecord } from "../../frontend/js/runs/saved-runs.js";
import { parseReplyLine } from "../../frontend/js/full-run/full-run-upload.js";
import { readJson } from "./helpers.js";

const ladder = readJson("frontend/data/ladder.json");
const probeSpec = readJson("frontend/data/probe_spec.json");
const config = readJson("frontend/data/config.json");
// The ids the command line and the browser both read from the shared platform list.
const CLI_PROVIDER_IDS = readJson("ordeal/data/providers.json").platforms.map((platform) => platform.id);

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

/** A fake chat client that always answers, so each unit saves its replies without any network call. */
const answeringClient = {
  async complete() {
    return "Answer: B";
  },
};

/** Run one gauntlet unit for the given provider and return the saved step records. */
async function savedRecordsFor(provider) {
  const cache = new Map();
  const options = {
    client: answeringClient,
    models: ["model-a"],
    questions: [QUESTION],
    repeats: 1,
    condition: "none",
    families: new Set(["gauntlet"]),
    ladder,
    probeSpec,
    config,
    cache,
    onEvent: () => {},
  };
  if (provider !== undefined) options.provider = provider;
  await createBatchRunner(options).start();
  return [...cache.values()];
}

test("a reply saved for groq carries the provider id groq", async () => {
  const records = await savedRecordsFor("groq");
  assert.ok(records.length > 0);
  for (const record of records) {
    assert.equal(record.provider, "groq");
  }
});

test("a reply saved without a provider has no provider field, as the command line does", async () => {
  const records = await savedRecordsFor(undefined);
  assert.ok(records.length > 0);
  for (const record of records) {
    assert.equal("provider" in record, false);
  }
});

test("the saved provider id is one of the ids the command line uses", async () => {
  const records = await savedRecordsFor("nebius");
  assert.ok(CLI_PROVIDER_IDS.includes(records[0].provider));
});

test("a saved run keeps the provider id when a record is slimmed for resume or export", () => {
  const slim = slimRecord({
    condition: "none",
    model: "model-a",
    question_id: "t01",
    repeat: 1,
    step: "baseline",
    reply: "Answer: B",
    user_text: "hi",
    provider: "groq",
  });
  assert.equal(slim.provider, "groq");
});

test("a slimmed record from an older save, with no provider, gets no provider field", () => {
  const slim = slimRecord({
    condition: "none",
    model: "model-a",
    question_id: "t01",
    repeat: 1,
    step: "baseline",
    reply: "Answer: B",
    user_text: "hi",
  });
  assert.equal("provider" in slim, false);
});

test("a replies file line from the command line keeps its provider when it is loaded back", () => {
  const line = JSON.stringify({
    condition: "none",
    model: "model-a",
    question_id: "t01",
    repeat: 1,
    step: "baseline",
    reply: "Answer: B",
    provider: "together",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(parseReplyLine(line).provider, "together");
});
