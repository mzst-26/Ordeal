// Tests for saving a finished Gauntlet run to the server (site/js/save-to-runs.js). The browser store is the in-memory
// adapter and the server is a fake fetch, so nothing touches IndexedDB, the network or a real browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { saveGauntletToRuns } from "../site/js/save-to-runs.js";
import { createMemoryAdapter } from "../site/js/store/memory-adapter.js";
import { createRun } from "../site/js/store/run-store.js";

const VISITOR = "0123456789abcdef0123456789abcdef";
const SAVED_ID = "11111111-1111-4111-8111-111111111111";

/** Return a fake fetch that answers 201 with a summary, and records every call it gets. */
function fakeFetch() {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    return { ok: true, status: 201, json: async () => ({ id: SAVED_ID, kind: "gauntlet", createdAt: 1, size: 9 }) };
  };
  return { fetchFn, calls };
}

// The whole saved run goes to the server, under the gauntlet kind and this visitor's id.
test("saveGauntletToRuns sends the whole saved run as a gauntlet, with the visitor id", async () => {
  const adapter = createMemoryAdapter();
  const run = await createRun(adapter, { label: "Gauntlet one", config: { kind: "gauntlet" }, plannedUnits: ["level_1"] });
  const { fetchFn, calls } = fakeFetch();
  const summary = await saveGauntletToRuns(adapter, run.id, VISITOR, fetchFn);
  assert.equal(summary.id, SAVED_ID);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-visitor-id"], VISITOR);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.kind, "gauntlet");
  assert.equal(body.run.id, run.id);
  assert.equal(body.run.label, "Gauntlet one");
});

// A run that is not in this browser cannot be saved, so nothing is sent and the visitor is told why.
test("saveGauntletToRuns refuses a run this browser does not hold, and sends nothing", async () => {
  const adapter = createMemoryAdapter();
  const { fetchFn, calls } = fakeFetch();
  await assert.rejects(saveGauntletToRuns(adapter, SAVED_ID, VISITOR, fetchFn), /not in this browser/);
  assert.equal(calls.length, 0);
});
