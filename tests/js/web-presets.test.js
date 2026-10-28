// Tests for the preset store (frontend/js/runs/presets.js) on the memory adapter. Nothing touches a browser or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../../frontend/js/store/memory-adapter.js";
import { createPresetStore, isPresetId, normaliseSettings, PRESET_PREFIX } from "../../frontend/js/runs/presets.js";
import { RUNS_STORE, createRun } from "../../frontend/js/store/run-store.js";

const SECRET_MESSAGE = "The data holds a key or a token, so it was refused and not saved.";
const FAKE_V1 = "v1." + "a".repeat(40);

/** Return the settings of a batch preset with the given overrides. */
function batchSettings(overrides = {}) {
  return {
    pushbackSet: "gauntlet_v4",
    questionSet: "hard",
    models: ["Qwen/Qwen3-30B-A3B-Instruct-2507"],
    families: ["gauntlet", "fingerprint"],
    repeats: 2,
    concurrency: 3,
    callCap: 50,
    condition: "none",
    temperature: 0.7,
    maxTokens: 1024,
    ...overrides,
  };
}

// Preset basics: save, list per page, load, rename and delete, with names unique per page.
test("save then list shows the preset on its page only", async () => {
  const store = createPresetStore(createMemoryAdapter());
  const saved = await store.save("batch", "  Quick hard run  ", batchSettings());
  assert.equal(saved.name, "Quick hard run");
  assert.ok(isPresetId(saved.id));
  assert.ok(saved.id.startsWith(PRESET_PREFIX));
  assert.deepEqual(await store.list("batch").then((rows) => rows.map((row) => row.name)), ["Quick hard run"]);
  assert.deepEqual(await store.list("gauntlet"), []);
});

test("load returns the saved settings", async () => {
  const store = createPresetStore(createMemoryAdapter());
  const saved = await store.save("batch", "Run A", batchSettings());
  const loaded = await store.load(saved.id);
  assert.deepEqual(loaded.settings, batchSettings());
  assert.deepEqual(loaded.dropped, []);
});

test("rename changes the name and keeps the settings", async () => {
  const store = createPresetStore(createMemoryAdapter());
  const saved = await store.save("batch", "Run A", batchSettings());
  const renamed = await store.rename(saved.id, "Run B");
  assert.equal(renamed.name, "Run B");
  assert.deepEqual((await store.load(saved.id)).settings, batchSettings());
});

test("rename refuses a name another preset on the page already has", async () => {
  const store = createPresetStore(createMemoryAdapter());
  await store.save("batch", "Run A", batchSettings());
  const second = await store.save("batch", "Run B", batchSettings());
  await assert.rejects(store.rename(second.id, "run a"), /already exists/);
});

test("the same name is allowed on the other page", async () => {
  const store = createPresetStore(createMemoryAdapter());
  await store.save("batch", "Shared", batchSettings());
  const gauntlet = await store.save("gauntlet", "Shared", { model: "google/gemma-3-27b-it" });
  assert.equal(gauntlet.name, "Shared");
});

test("delete removes the preset", async () => {
  const store = createPresetStore(createMemoryAdapter());
  const saved = await store.save("batch", "Run A", batchSettings());
  await store.remove(saved.id);
  assert.deepEqual(await store.list("batch"), []);
  await assert.rejects(store.load(saved.id), /No saved preset has that id/);
});

// Secrets: key-looking fields or names are refused, never saved and never silently dropped.
test("a key-looking field is refused, not dropped", async () => {
  const store = createPresetStore(createMemoryAdapter());
  await assert.rejects(store.save("batch", "Bad", batchSettings({ apiKey: "anything" })), { message: SECRET_MESSAGE });
  await assert.rejects(store.save("batch", "Bad", batchSettings({ api_key: "anything" })), { message: SECRET_MESSAGE });
  await assert.rejects(store.save("batch", "Bad", batchSettings({ token: "anything" })), { message: SECRET_MESSAGE });
  await assert.rejects(store.save("batch", "Bad", batchSettings({ note: FAKE_V1 })), { message: SECRET_MESSAGE });
  assert.deepEqual(await store.list("batch"), []);
});

// Settings clean-up: unknown, out-of-range and wrong-page fields are dropped and reported by name.
test("unknown fields are dropped and named in the result", () => {
  const { settings, dropped } = normaliseSettings("batch", batchSettings({ colour: "blue", extra: 1 }));
  assert.equal("colour" in settings, false);
  assert.equal("extra" in settings, false);
  assert.deepEqual(dropped.sort(), ["colour", "extra"]);
});

// A preset saved before the shuffle was removed has seed fields. They are reported as dropped, and the sets it
// names still load, so the preset opens as the fixed choice instead of failing.
test("an old preset with seed fields loads as the fixed sets and reports the seeds", () => {
  const { settings, dropped } = normaliseSettings("batch", batchSettings({ pushbackSeed: 3, questionSeed: null }));
  assert.equal(settings.pushbackSet, "gauntlet_v4");
  assert.equal(settings.questionSet, "hard");
  assert.equal("pushbackSeed" in settings, false);
  assert.deepEqual(dropped.sort(), ["pushbackSeed", "questionSeed"]);
});

test("a known field with a value out of range is dropped", () => {
  const { settings, dropped } = normaliseSettings("batch", batchSettings({ repeats: 9, concurrency: 2 }));
  assert.equal("repeats" in settings, false);
  assert.equal(settings.concurrency, 2);
  assert.deepEqual(dropped, ["repeats"]);
});

test("a batch field is dropped on the gauntlet page", () => {
  const { settings, dropped } = normaliseSettings("gauntlet", batchSettings());
  assert.deepEqual(Object.keys(settings).sort(), ["condition", "pushbackSet", "questionSet", "temperature", "maxTokens"].sort());
  assert.ok(dropped.includes("models") && dropped.includes("callCap"));
});

test("a preset never holds the key: no stored field has a key name", async () => {
  const adapter = createMemoryAdapter();
  const store = createPresetStore(adapter);
  await store.save("gauntlet", "Gauntlet A", { pushbackSet: "gauntlet_v3", questionSet: "easy" });
  const docs = await adapter.list(RUNS_STORE);
  const names = JSON.stringify(docs.map((doc) => Object.keys(doc.settings ?? {})));
  assert.doesNotMatch(names, /key|token|secret/i);
});

// Input checks and isolation: page and name rules, and the preset store cannot delete saved runs.
test("an unknown page is refused", async () => {
  const store = createPresetStore(createMemoryAdapter());
  await assert.rejects(store.list("live"), /only be kept for the Gauntlet or the Batch page/);
});

test("a blank or over-long name is refused", async () => {
  const store = createPresetStore(createMemoryAdapter());
  await assert.rejects(store.save("batch", "   ", batchSettings()), /1 to 80 characters/);
  await assert.rejects(store.save("batch", "x".repeat(81), batchSettings()), /1 to 80 characters/);
  await assert.rejects(store.save("batch", "x".repeat(201), batchSettings()), /1 to 80 characters/);
});

test("a preset name that holds a key or a token is refused on save and on rename, and nothing is saved", async () => {
  const store = createPresetStore(createMemoryAdapter());
  const saved = await store.save("batch", "Quick run", batchSettings());
  await assert.rejects(store.save("batch", FAKE_V1, batchSettings()), { message: SECRET_MESSAGE });
  const bearer = "Bearer abcdefghijklmnop1234";
  await assert.rejects(store.save("batch", bearer, batchSettings()), { message: SECRET_MESSAGE });
  await assert.rejects(store.rename(saved.id, FAKE_V1), { message: SECRET_MESSAGE });
  assert.deepEqual((await store.list("batch")).map((preset) => preset.name), ["Quick run"]);
});

test("remove refuses a saved run id, so a run cannot be deleted from the presets", async () => {
  const adapter = createMemoryAdapter();
  const run = await createRun(adapter, { label: "A run", config: { kind: "batch" }, plannedUnits: ["u1"] });
  const store = createPresetStore(adapter);
  await assert.rejects(store.remove(run.id), /No saved preset has that id/);
  assert.ok(await adapter.get(RUNS_STORE, run.id));
});
