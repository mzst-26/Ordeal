// Tests for the one key store that every page uses (engine/provider-keys.js). A key saved for a provider works on every
// page, keys for different providers never mix, a key saved by the old single vault still works, Remember keeps a key
// only when it is ticked, a key never reaches the console, and a missing key blocks only the provider that lacks it.
// The network is a stub here, so no real request is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProviderKeys, keySlotFor, slotFor, slotForPlatform, PROVIDER_KEYS_STORAGE_NAME,
} from "../../frontend/js/engine/provider-keys.js";
import { REMEMBER_STORAGE_NAME, REMEMBER_PLATFORM_NAME } from "../../frontend/js/engine/token.js";
import { createChatClient, createBudget } from "../../frontend/js/engine/api.js";
import { platformList, findPlatform } from "../../frontend/js/models/platforms.js";
import { readJson } from "./helpers.js";

const PLATFORMS = platformList(readJson("ordeal/data/providers.json"));
const GROQ = findPlatform(PLATFORMS, "groq");
const TOGETHER = findPlatform(PLATFORMS, "together");

// Fake keys of the right shape. They are not real keys.
const GROQ_KEY = "groq-fake-key-" + "7".repeat(30);
const TOGETHER_KEY = "together-fake-key-" + "8".repeat(27);
const NEBIUS_KEY = "nebius-fake-key-" + "9".repeat(29);
const OTHER_PROVIDER_MESSAGE = "That key belongs to another provider, so it was not saved for this one.";
const NO_KEY_MESSAGE = "No API key is set. Add your key first.";

/** A storage object that keeps its values in a Map, like localStorage does for one page. */
function fakeStorage() {
  const items = new Map();
  return {
    items,
    getItem: (name) => (items.has(name) ? items.get(name) : null),
    setItem: (name, value) => items.set(name, String(value)),
    removeItem: (name) => items.delete(name),
  };
}

/** Run fn while every console method is replaced, and return each line that was written. */
function captureConsole(fn) {
  const seen = [];
  const names = ["log", "info", "warn", "error", "debug"];
  const original = Object.fromEntries(names.map((name) => [name, console[name]]));
  for (const name of names) console[name] = (...parts) => seen.push(parts.map(String).join(" "));
  try {
    fn();
  } finally {
    Object.assign(console, original);
  }
  return seen;
}

/** A fetch stub that answers with one reply and records each address it was asked for. */
function stubFetch(requested) {
  return async (url) => {
    requested.push(url);
    return { status: 200, json: async () => ({ choices: [{ message: { content: "Answer: C" } }] }) };
  };
}

test("one store: the slot for a provider and the slot for its platform read the same saved key", () => {
  slotFor("nebius").set(NEBIUS_KEY, { platform: "nebius" });
  try {
    assert.equal(slotForPlatform({ id: "nebius" }).get(), NEBIUS_KEY);
    assert.equal(slotFor("nebius").masked(), slotForPlatform({ id: "nebius" }).masked());
  } finally {
    slotFor("nebius").clear();
  }
});

test("per-provider keys are not mixed: each provider sees only its own key", () => {
  const keys = createProviderKeys();
  keySlotFor(keys, "groq").set(GROQ_KEY, { platform: "groq" });
  keySlotFor(keys, "together").set(TOGETHER_KEY, { platform: "together" });
  assert.equal(keySlotFor(keys, "groq").get(), GROQ_KEY);
  assert.equal(keySlotFor(keys, "together").get(), TOGETHER_KEY);
  assert.equal(keySlotFor(keys, "nebius").has(), false);
  assert.equal(keySlotFor(keys, "nebius").platformId(), null);
});

test("a key typed for one provider is refused by another provider's slot and nothing is saved", () => {
  const keys = createProviderKeys();
  assert.throws(
    () => keySlotFor(keys, "together").set(GROQ_KEY, { platform: "groq" }),
    { message: OTHER_PROVIDER_MESSAGE },
  );
  assert.equal(keys.has("together"), false);
  assert.equal(keys.has("groq"), false);
});

test("migration: a key saved by the old single vault works under the provider it was saved for", () => {
  const storage = fakeStorage();
  storage.setItem(REMEMBER_STORAGE_NAME, NEBIUS_KEY);
  storage.setItem(REMEMBER_PLATFORM_NAME, "nebius");
  const slot = keySlotFor(createProviderKeys({ storage }), "nebius");
  assert.equal(slot.get(), NEBIUS_KEY);
  assert.equal(slot.platformId(), "nebius");
  assert.equal(slot.remembered(), true);
  assert.equal(storage.getItem(REMEMBER_STORAGE_NAME), null);
});

test("Remember on: the key is written to storage and is still there after a reload", () => {
  const storage = fakeStorage();
  keySlotFor(createProviderKeys({ storage }), "groq").set(GROQ_KEY, { remember: true, platform: "groq" });
  assert.equal(JSON.parse(storage.getItem(PROVIDER_KEYS_STORAGE_NAME)).groq, GROQ_KEY);
  const reloaded = keySlotFor(createProviderKeys({ storage }), "groq");
  assert.equal(reloaded.get(), GROQ_KEY);
  assert.equal(reloaded.remembered(), true);
});

test("Remember off: the key is kept in memory only, nothing is written, and a saved copy is removed", () => {
  const storage = fakeStorage();
  const keys = createProviderKeys({ storage });
  keySlotFor(keys, "groq").set(GROQ_KEY, { remember: true, platform: "groq" });
  keySlotFor(keys, "groq").set(GROQ_KEY, { remember: false, platform: "groq" });
  assert.equal(storage.getItem(PROVIDER_KEYS_STORAGE_NAME), null);
  assert.equal(keySlotFor(keys, "groq").get(), GROQ_KEY);
  assert.equal(keySlotFor(createProviderKeys({ storage }), "groq").has(), false);
});

test("a key never reaches the console while it is saved, read, masked, sent and forgotten", async () => {
  const storage = fakeStorage();
  const keys = createProviderKeys({ storage });
  const slot = keySlotFor(keys, "groq");
  const requested = [];
  const client = createChatClient({
    platform: GROQ,
    vault: slot,
    budget: createBudget(null),
    fetchImpl: stubFetch(requested),
    sleep: async () => {},
  });
  const lines = await captureAsync(async () => {
    slot.set(GROQ_KEY, { remember: true, platform: "groq" });
    slot.masked();
    await client.complete({ model: "m", messages: [], temperature: 0.7, maxTokens: 16 });
    slot.clear();
  });
  assert.deepEqual(lines, []);
  assert.equal(requested.length, 1);
});

/** Like captureConsole, for an async function. Returns the console lines written while it ran. */
async function captureAsync(fn) {
  const seen = [];
  const names = ["log", "info", "warn", "error", "debug"];
  const original = Object.fromEntries(names.map((name) => [name, console[name]]));
  for (const name of names) console[name] = (...parts) => seen.push(parts.map(String).join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, original);
  }
  return seen;
}

test("the masked text and the store's errors never show the whole key", () => {
  const keys = createProviderKeys();
  const slot = keySlotFor(keys, "groq");
  slot.set(GROQ_KEY, { platform: "groq" });
  assert.equal(slot.masked().includes(GROQ_KEY), false);
  assert.equal(slot.masked().includes(GROQ_KEY.slice(3, -4)), false);
  const lines = captureConsole(() => keySlotFor(keys, "together").masked());
  assert.deepEqual(lines, []);
});

test("a missing key blocks only the provider that lacks it, and no request goes to that provider", async () => {
  const keys = createProviderKeys();
  keySlotFor(keys, "groq").set(GROQ_KEY, { platform: "groq" });
  const requested = [];
  const fetchImpl = stubFetch(requested);
  const groqClient = createChatClient({
    platform: GROQ, vault: keySlotFor(keys, "groq"), budget: createBudget(null), fetchImpl, sleep: async () => {},
  });
  const togetherClient = createChatClient({
    platform: TOGETHER, vault: keySlotFor(keys, "together"), budget: createBudget(null), fetchImpl, sleep: async () => {},
  });
  await assert.rejects(
    togetherClient.complete({ model: "m", messages: [], temperature: 0.7, maxTokens: 16 }),
    { message: NO_KEY_MESSAGE },
  );
  assert.deepEqual(requested, []);
  const reply = await groqClient.complete({ model: "m", messages: [], temperature: 0.7, maxTokens: 16 });
  assert.equal(reply, "Answer: C");
  assert.equal(requested.length, 1);
  assert.ok(requested[0].startsWith(GROQ.base_url));
});

