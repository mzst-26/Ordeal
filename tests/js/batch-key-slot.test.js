// Tests that the batch page's checks read the key for their own provider only. The page passes a key slot (one provider's
// key) to these checks, so a key saved for one provider is never sent to another provider's address. The network is a
// stub here, so no real request is made, and the test can see which address each request would have gone to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyReadyFor, platformIdsForCheck, checkTypedName } from "../../frontend/js/models/typed-model-check.js";
import { createProviderKeys, keySlotFor } from "../../frontend/js/engine/provider-keys.js";
import { platformList, findPlatform } from "../../frontend/js/models/platforms.js";
import { readJson } from "./helpers.js";

const PLATFORMS = platformList(readJson("ordeal/data/providers.json"));
const GROQ = findPlatform(PLATFORMS, "groq");
const TOGETHER = findPlatform(PLATFORMS, "together");

// A fake key of the right shape. It is not a real key.
const GROQ_KEY = "groq-fake-key-" + "7".repeat(30);

/** Replace the global fetch with a stub that answers with one model id and records each address it was asked for. */
function stubFetch() {
  const requested = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(JSON.stringify({ data: [{ id: "model-one" }] }), { status: 200 });
  };
  return {
    requested,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test("keyReadyFor is true, without a prompt, when the slot holds this provider's key", async () => {
  const keys = createProviderKeys();
  keys.set("groq", GROQ_KEY);
  assert.equal(await keyReadyFor(GROQ, keySlotFor(keys, "groq")), true);
});

test("the model check reads the platform list only with the key for that provider", async () => {
  const fetchStub = stubFetch();
  try {
    const keys = createProviderKeys();
    keys.set("groq", GROQ_KEY);
    const ids = await platformIdsForCheck(GROQ, keySlotFor(keys, "groq"));
    assert.deepEqual(ids, ["model-one"]);
    assert.equal(fetchStub.requested.length, 1);
    assert.ok(fetchStub.requested[0].startsWith("https://api.groq.com/"));
  } finally {
    fetchStub.restore();
  }
});

test("a key saved for groq is never sent to together's address", async () => {
  const fetchStub = stubFetch();
  try {
    const keys = createProviderKeys();
    keys.set("groq", GROQ_KEY);
    const ids = await platformIdsForCheck(TOGETHER, keySlotFor(keys, "together"));
    assert.equal(ids, null);
    assert.deepEqual(fetchStub.requested, []);
  } finally {
    fetchStub.restore();
  }
});

test("a provider with no key is checked as not confirmed, and no request is made", async () => {
  const fetchStub = stubFetch();
  try {
    const keys = createProviderKeys();
    const result = await checkTypedName(TOGETHER, "org/model", keySlotFor(keys, "together"));
    assert.equal(result.ok, true);
    assert.equal(result.checked, false);
    assert.deepEqual(fetchStub.requested, []);
  } finally {
    fetchStub.restore();
  }
});

test("a typed name is confirmed against the list of the provider that has the key", async () => {
  const fetchStub = stubFetch();
  try {
    const keys = createProviderKeys();
    keys.set("groq", GROQ_KEY);
    const result = await checkTypedName(GROQ, "model-one", keySlotFor(keys, "groq"));
    assert.equal(result.ok, true);
    assert.equal(result.checked, true);
  } finally {
    fetchStub.restore();
  }
});
