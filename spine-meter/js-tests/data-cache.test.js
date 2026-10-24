// Tests for site/js/data-cache.js. The fetch is a fake that counts its calls and returns canned responses,
// so no network is used and the number of requests is exact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDataCache } from "../site/js/data-cache.js";

/** A fake fetch that answers each call with the next canned result and records the paths it was asked for. */
function fakeFetch(...results) {
  const calls = [];
  const fetchFn = async (path) => {
    calls.push(path);
    const next = results.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return { fetchFn, calls };
}

/** A response with a JSON body, the shape the browser fetch gives back for a 200. */
function okResponse(value) {
  return { ok: true, status: 200, json: async () => value };
}

// The cache stores one promise per path, so repeat loads share a single request.
test("two loads of one path make one fetch call and return the same value", async () => {
  const { fetchFn, calls } = fakeFetch(okResponse({ models: 29 }));
  const cache = createDataCache(fetchFn);

  const first = await cache.loadJson("/data/config.json");
  const second = await cache.loadJson("/data/config.json");

  assert.deepEqual(first, { models: 29 });
  assert.deepEqual(second, { models: 29 });
  assert.deepEqual(calls, ["/data/config.json"]);
});

test("two loads of one path return the same promise, not a second request", () => {
  const { fetchFn } = fakeFetch(okResponse({ models: 29 }));
  const cache = createDataCache(fetchFn);

  const first = cache.loadJson("/data/config.json");
  const second = cache.loadJson("/data/config.json");

  assert.equal(first, second);
});

test("two different paths make two fetch calls", async () => {
  const { fetchFn, calls } = fakeFetch(okResponse({ a: 1 }), okResponse({ b: 2 }));
  const cache = createDataCache(fetchFn);

  const a = await cache.loadJson("/data/config.json");
  const b = await cache.loadJson("/data/questions.json");

  assert.deepEqual(a, { a: 1 });
  assert.deepEqual(b, { b: 2 });
  assert.deepEqual(calls, ["/data/config.json", "/data/questions.json"]);
});

// Failure handling: errors are not cached, and error messages leak no response body.
test("a failed fetch is not kept, so the next load fetches again", async () => {
  const { fetchFn, calls } = fakeFetch(new Error("network down"), okResponse({ models: 29 }));
  const cache = createDataCache(fetchFn);

  await assert.rejects(cache.loadJson("/data/config.json"), /network down/);
  const retried = await cache.loadJson("/data/config.json");

  assert.deepEqual(retried, { models: 29 });
  assert.deepEqual(calls, ["/data/config.json", "/data/config.json"]);
});

test("a non-OK response rejects with the path and the status, and no body text", async () => {
  const secretBody = "SECRET-BODY-TEXT";
  const notFound = {
    ok: false,
    status: 404,
    json: async () => ({ detail: secretBody }),
    text: async () => secretBody,
  };
  const { fetchFn } = fakeFetch(notFound);
  const cache = createDataCache(fetchFn);

  await assert.rejects(cache.loadJson("/data/missing.json"), (error) => {
    assert.ok(error.message.includes("/data/missing.json"), error.message);
    assert.ok(error.message.includes("404"), error.message);
    assert.ok(!error.message.includes(secretBody), error.message);
    return true;
  });
});
