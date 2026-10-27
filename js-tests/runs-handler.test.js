// Tests for the request handling of the web run store (netlify/lib/runs-handler.js). The handlers get a fake store
// that keeps items in a Map, so nothing calls Netlify or the network. Each request is a plain Request object.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunsHandler, createAdminHandler, pruneExpired } from "../netlify/lib/runs-handler.js";
import { DAY_MS } from "../site/js/run-retention.js";

const ALICE = "0123456789abcdef0123456789abcdef";
const BOB = "fedcba9876543210fedcba9876543210";
const ADMIN = "example-admin-password";
const URL_BASE = "https://example.test/api/runs";
const ADMIN_URL = "https://example.test/api/runs-admin";
const RUN_1 = "11111111-1111-4111-8111-111111111111";
const RUN_2 = "22222222-2222-4222-8222-222222222222";
const RUN_3 = "33333333-3333-4333-8333-333333333333";

/** Return a fake store with the same methods the real Netlify store has, kept in a Map. */
function fakeStore() {
  const items = new Map();
  return {
    items,
    async *list({ prefix }) {
      const keys = [...items.keys()].filter((key) => key.startsWith(prefix));
      yield { blobs: keys.map((key) => ({ key })), directories: [] };
    },
    async getMetadata(key) {
      const item = items.get(key);
      return item === undefined ? null : { metadata: item.metadata };
    },
    async setJSON(key, data, { metadata }) {
      items.set(key, { data: structuredClone(data), metadata });
    },
    async getWithMetadata(key) {
      const item = items.get(key);
      return item === undefined ? null : { data: structuredClone(item.data), metadata: item.metadata };
    },
    async delete(key) {
      items.delete(key);
    },
  };
}

/** Return a request to the runs address with the visitor header, a method and an optional JSON body. */
function visitorRequest(method, { visitor = ALICE, query = "", body } = {}) {
  const headers = visitor === null ? {} : { "x-visitor-id": visitor };
  const init = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { ...headers, "content-type": "application/json" };
  }
  return new Request(`${URL_BASE}${query}`, init);
}

/** Return a handler that hands out the given run ids in order, so a test knows each id before it is needed. */
function handlerWith(store, { ids = [RUN_1, RUN_2, RUN_3], now = () => 1_000_000, limits } = {}) {
  const queue = [...ids];
  return createRunsHandler({
    openStore: () => store,
    now,
    newId: () => queue.shift(),
    limits,
  });
}

/** Read the JSON body of a response. */
async function bodyOf(response) {
  return response.json();
}

// The store must not be opened for a request that fails the visitor check, so a bad request never reaches Netlify.
test("a save with no visitor id is refused with 400 and the store is not opened", async () => {
  const handler = createRunsHandler({
    openStore: () => {
      throw new Error("the store was opened");
    },
  });
  const response = await handler(visitorRequest("POST", { visitor: null, body: { kind: "batch", run: {} } }));
  assert.equal(response.status, 400);
  assert.match((await bodyOf(response)).error, /missing/);
});

// A short visitor id is refused with a message that says how long it must be.
test("a short visitor id is refused with 400 and a clear message", async () => {
  const handler = handlerWith(fakeStore());
  const response = await handler(visitorRequest("GET", { visitor: "short" }));
  assert.equal(response.status, 400);
  assert.match((await bodyOf(response)).error, /at least 32/);
});

// Each visitor saves a run, then lists it and reads it back under their own id.
test("a visitor saves a run, then lists and reads it back", async () => {
  const store = fakeStore();
  const handler = handlerWith(store);
  const saved = await handler(visitorRequest("POST", { body: { kind: "batch", run: { label: "one" } } }));
  assert.equal(saved.status, 201);
  assert.equal((await bodyOf(saved)).id, RUN_1);

  const list = await bodyOf(await handler(visitorRequest("GET")));
  assert.equal(list.runs.length, 1);
  assert.equal(list.runs[0].id, RUN_1);

  const one = await bodyOf(await handler(visitorRequest("GET", { query: `?id=${RUN_1}` })));
  assert.deepEqual(one.run, { label: "one" });
  assert.ok(store.items.has(`owner/${ALICE}/${RUN_1}`));
});

// The isolation rule: another visitor sees no runs, cannot read one by id, and deleting by id changes nothing.
test("one visitor cannot list, read or delete another visitor's run", async () => {
  const store = fakeStore();
  const handler = handlerWith(store);
  await handler(visitorRequest("POST", { body: { kind: "gauntlet", run: { label: "alice" } } }));

  const bobList = await bodyOf(await handler(visitorRequest("GET", { visitor: BOB })));
  assert.deepEqual(bobList.runs, []);

  const bobRead = await handler(visitorRequest("GET", { visitor: BOB, query: `?id=${RUN_1}` }));
  assert.equal(bobRead.status, 404);

  const bobDelete = await handler(visitorRequest("DELETE", { visitor: BOB, query: `?id=${RUN_1}` }));
  assert.equal(bobDelete.status, 200);
  const aliceRead = await handler(visitorRequest("GET", { query: `?id=${RUN_1}` }));
  assert.equal(aliceRead.status, 200);
});

// A visitor can delete their own run.
test("a visitor deletes their own run", async () => {
  const store = fakeStore();
  const handler = handlerWith(store);
  await handler(visitorRequest("POST", { body: { kind: "batch", run: { label: "x" } } }));
  const response = await handler(visitorRequest("DELETE", { query: `?id=${RUN_1}` }));
  assert.equal(response.status, 200);
  assert.equal(store.items.size, 0);
});

// A save with an unknown kind is refused, and nothing is written.
test("a save with an unknown kind is refused and nothing is stored", async () => {
  const store = fakeStore();
  const response = await handlerWith(store)(visitorRequest("POST", { body: { kind: "other", run: {} } }));
  assert.equal(response.status, 400);
  assert.equal(store.items.size, 0);
});

// The list is newest first, so the newest run is at the top of the runs page.
test("the list shows the newest run first", async () => {
  const store = fakeStore();
  let clock = 1000;
  const handler = handlerWith(store, { now: () => clock });
  await handler(visitorRequest("POST", { body: { kind: "batch", run: {} } }));
  clock = 5000;
  await handler(visitorRequest("POST", { body: { kind: "batch", run: {} } }));
  const list = await bodyOf(await handler(visitorRequest("GET")));
  assert.deepEqual(list.runs.map((run) => run.id), [RUN_2, RUN_1]);
});

// Visitor cap: each run is about 920 bytes and the visitor cap is 2000 here, so two of Alice's runs fit and a third
// does not. The third save removes Alice's oldest run (RUN_1). Bob's run is never touched.
test("a save over the visitor cap removes that visitor's oldest run and no one else's", async () => {
  const store = fakeStore();
  const limits = { visitorMax: 2000, storeMax: 1_000_000 };
  const big = "x".repeat(800);
  const handler = handlerWith(store, { ids: [RUN_1, RUN_2, RUN_3, "44444444-4444-4444-8444-444444444444"], limits });
  await handler(visitorRequest("POST", { body: { kind: "batch", run: { pad: big } } }));
  await handler(visitorRequest("POST", { body: { kind: "batch", run: { pad: big } } }));
  await handler(visitorRequest("POST", { visitor: BOB, body: { kind: "batch", run: { pad: big } } }));
  const third = await handler(visitorRequest("POST", { body: { kind: "batch", run: { pad: big } } }));
  assert.equal(third.status, 201);
  assert.equal(store.items.has(`owner/${ALICE}/${RUN_1}`), false);
  assert.equal(store.items.has(`owner/${ALICE}/${RUN_2}`), true);
  assert.equal(store.items.has(`owner/${BOB}/${RUN_3}`), true);
});

// A run bigger than the visitor cap is refused with 413, and none of the visitor's runs are removed.
test("a run bigger than the visitor cap is refused with 413 and removes nothing", async () => {
  const store = fakeStore();
  const handler = handlerWith(store, { limits: { visitorMax: 500, storeMax: 1_000_000 } });
  await handler(visitorRequest("POST", { body: { kind: "batch", run: { label: "small" } } }));
  const response = await handler(visitorRequest("POST", { body: { kind: "batch", run: { pad: "x".repeat(900) } } }));
  assert.equal(response.status, 413);
  assert.match((await bodyOf(response)).error, /200 MB/);
  assert.equal(store.items.size, 1);
});

// A request with a method this store does not use gets 405.
test("a method other than GET, POST or DELETE gets 405", async () => {
  const response = await handlerWith(fakeStore())(visitorRequest("PUT"));
  assert.equal(response.status, 405);
});

// The daily prune removes runs older than 7 days for every visitor, and keeps the newer ones.
test("pruneExpired removes runs older than 7 days for every visitor", async () => {
  const store = fakeStore();
  const now = 100 * DAY_MS;
  const handler = handlerWith(store, { now: () => now - 8 * DAY_MS });
  await handler(visitorRequest("POST", { body: { kind: "batch", run: {} } }));
  const fresh = handlerWith(store, { ids: [RUN_2], now: () => now - 1 * DAY_MS });
  await fresh(visitorRequest("POST", { visitor: BOB, body: { kind: "batch", run: {} } }));
  const removed = await pruneExpired(store, now);
  assert.equal(removed, 1);
  assert.deepEqual([...store.items.keys()], [`owner/${BOB}/${RUN_2}`]);
});

/** Return an admin handler whose admin password is the given value (or none). */
function adminHandler(store, password) {
  return createAdminHandler({ openStore: () => store, now: () => 100 * DAY_MS, getPassword: () => password });
}

/** Return an admin request with the admin password in the header and an action in the body. */
function adminRequest(action, password = ADMIN) {
  return new Request(ADMIN_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${password}`, "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

// The admin password is the only thing that lets the admin actions run. A wrong one gets 401.
test("an admin action with a wrong or missing password is refused with 401", async () => {
  const store = fakeStore();
  const handler = adminHandler(store, ADMIN);
  assert.equal((await handler(adminRequest("clear", "wrong"))).status, 401);
  const none = new Request(ADMIN_URL, { method: "POST", body: JSON.stringify({ action: "clear" }) });
  assert.equal((await handler(none)).status, 401);
});

// With no admin password set, every admin action is refused.
test("an unset admin password refuses every admin action", async () => {
  const handler = adminHandler(fakeStore(), undefined);
  assert.equal((await handler(adminRequest("clear", ""))).status, 401);
  assert.equal((await handler(adminRequest("clear", "anything"))).status, 401);
});

// Admin clear removes every run of every visitor.
test("admin clear removes every run of every visitor", async () => {
  const store = fakeStore();
  const handler = handlerWith(store);
  await handler(visitorRequest("POST", { body: { kind: "batch", run: {} } }));
  await handler(visitorRequest("POST", { visitor: BOB, body: { kind: "batch", run: {} } }));
  const response = await adminHandler(store, ADMIN)(adminRequest("clear"));
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { removed: 2 });
  assert.equal(store.items.size, 0);
});

// Admin prune is the same expiry rule as the daily job, run on demand.
test("admin prune removes only the expired runs", async () => {
  const store = fakeStore();
  await handlerWith(store, { now: () => 0 })(visitorRequest("POST", { body: { kind: "batch", run: {} } }));
  const response = await adminHandler(store, ADMIN)(adminRequest("prune"));
  assert.deepEqual(await bodyOf(response), { removed: 1 });
  assert.equal(store.items.size, 0);
});
