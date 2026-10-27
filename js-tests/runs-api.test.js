// Tests for the browser side of the web runs: the calls to /api/runs, the browser copies of gauntlet runs, and the
// text shown in each row. Every request goes through a fake fetch, and storage is the in-memory adapter, so nothing
// touches the network or a real browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RUNS_NOTE_TEXT,
  runsUrl,
  fetchRunList,
  fetchRunRecord,
  deleteRun,
  planBrowserCopies,
  keepBrowserCopies,
  daysLeft,
  sizeText,
  rowText,
} from "../site/js/runs-api.js";
import { createMemoryAdapter } from "../site/js/store/memory-adapter.js";
import { listRuns } from "../site/js/store/run-store.js";
import { DAY_MS } from "../site/js/run-retention.js";

const NOW = 50 * DAY_MS;
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

/** Return a fake fetch that answers with the given status and JSON body, and records every call it gets. */
function fakeFetch(status, body) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchFn, calls };
}

// The page must say the rules in these words, so a reader sees them on the page.
test("the note on the runs page gives the 7-day, 1.5 GB and delete rules", () => {
  assert.equal(
    RUNS_NOTE_TEXT,
    "Runs are kept for 7 days. The store holds up to 1.5 GB; the oldest runs are removed first when it is full. "
      + "You can delete a run at any time.",
  );
});

// The list is read with a plain GET and no password. A single run adds its id as a query value.
test("runsUrl builds the list and single-run addresses", () => {
  assert.equal(runsUrl(), "/api/runs");
  assert.equal(runsUrl(ID_A), `/api/runs?id=${ID_A}`);
});

// fetchRunList returns the summaries the server sends back.
test("fetchRunList returns the runs the server lists", async () => {
  const summary = { id: ID_A, kind: "batch", createdAt: NOW, size: 10 };
  const { fetchFn, calls } = fakeFetch(200, { runs: [summary] });
  assert.deepEqual(await fetchRunList(fetchFn), [summary]);
  assert.equal(calls[0].url, "/api/runs");
});

// A failed list is an error with a plain message, so the page can show it.
test("fetchRunList throws a plain error when the server fails", async () => {
  const { fetchFn } = fakeFetch(500, {});
  await assert.rejects(fetchRunList(fetchFn), /could not be loaded/);
});

// Deleting sends the password only in the Authorization header, as a Bearer value.
test("deleteRun sends the password as a Bearer header and the run id in the address", async () => {
  const { fetchFn, calls } = fakeFetch(200, { deleted: ID_A });
  await deleteRun(ID_A, "example-password", fetchFn);
  assert.equal(calls[0].url, `/api/runs?id=${ID_A}`);
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(calls[0].init.headers.authorization, "Bearer example-password");
});

// A wrong password gets its own plain message, so the visitor knows what to fix.
test("deleteRun explains a wrong password in plain words", async () => {
  const { fetchFn } = fakeFetch(401, { error: "x" });
  await assert.rejects(deleteRun(ID_A, "nope", fetchFn), /password is missing or wrong/);
});

// Only gauntlet runs are copied into the browser. Runs already held in the browser are not copied again.
test("planBrowserCopies picks gauntlet runs that are not yet in the browser", () => {
  const summaries = [
    { id: ID_A, kind: "gauntlet", createdAt: NOW, size: 1 },
    { id: ID_B, kind: "batch", createdAt: NOW, size: 1 },
  ];
  assert.deepEqual(planBrowserCopies(summaries, []), [ID_A]);
  assert.deepEqual(planBrowserCopies(summaries, [ID_A]), []);
});

// keepBrowserCopies fetches each planned gauntlet run and saves its run document in the browser store.
test("keepBrowserCopies saves a copy of each planned gauntlet run and no batch run", async () => {
  const adapter = createMemoryAdapter();
  const summaries = [
    { id: ID_A, kind: "gauntlet", createdAt: NOW, size: 1 },
    { id: ID_B, kind: "batch", createdAt: NOW, size: 1 },
  ];
  const record = { id: ID_A, kind: "gauntlet", createdAt: NOW, run: { id: ID_A, label: "one", results: {} } };
  const { fetchFn, calls } = fakeFetch(200, record);
  assert.equal(await keepBrowserCopies(adapter, summaries, fetchFn), 1);
  assert.equal(calls.length, 1);
  assert.deepEqual((await listRuns(adapter)).map((run) => run.id), [ID_A]);
});

// A record whose run id does not match is not copied, so a bad server answer cannot write the wrong run.
test("keepBrowserCopies skips a record whose run id does not match", async () => {
  const adapter = createMemoryAdapter();
  const summaries = [{ id: ID_A, kind: "gauntlet", createdAt: NOW, size: 1 }];
  const record = { id: ID_A, kind: "gauntlet", createdAt: NOW, run: { id: ID_B, label: "x" } };
  const { fetchFn } = fakeFetch(200, record);
  assert.equal(await keepBrowserCopies(adapter, summaries, fetchFn), 0);
  assert.deepEqual(await listRuns(adapter), []);
});

// Days left: a run saved 1 day ago has 6 days left; a run 7 days old has none; a run saved now has 7.
test("daysLeft counts the days a run has left before the 7-day limit", () => {
  assert.equal(daysLeft(NOW, NOW), 7);
  assert.equal(daysLeft(NOW - DAY_MS, NOW), 6);
  assert.equal(daysLeft(NOW - 7 * DAY_MS, NOW), 0);
  assert.equal(daysLeft(NOW - 9 * DAY_MS, NOW), 0);
});

// Sizes are shown in the largest unit that keeps the number under 1024.
test("sizeText shows bytes, KB, MB and GB", () => {
  assert.equal(sizeText(512), "512 bytes");
  assert.equal(sizeText(2048), "2.0 KB");
  assert.equal(sizeText(5 * 1024 * 1024), "5.0 MB");
  assert.equal(sizeText(1.5 * 1024 * 1024 * 1024), "1.5 GB");
});

// Each row names the kind, the size and the days left, so a reader sees what the 7-day rule means for that run.
test("rowText names the kind, size and days left", () => {
  const row = rowText({ id: ID_A, kind: "gauntlet", createdAt: NOW, size: 2048 }, NOW);
  assert.equal(row.title, "Gauntlet run");
  assert.match(row.meta, /2\.0 KB/);
  assert.match(row.meta, /kept 7 more days/);
  assert.equal(rowText({ id: ID_B, kind: "batch", createdAt: NOW, size: 1 }, NOW).title, "Batch run");
});
