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
  saveRunOnServer,
  deleteRun,
  keepBrowserCopies,
  hoursLeft,
  sizeText,
  rowText,
} from "../site/js/runs-api.js";
import { createMemoryAdapter } from "../site/js/store/memory-adapter.js";
import { listRuns } from "../site/js/store/run-store.js";
import { HOUR_MS, DAY_MS } from "../site/js/run-retention.js";

const NOW = 50 * DAY_MS;
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const BROWSER = "33333333-3333-4333-8333-333333333333";

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
test("the note on the runs page gives the 24-hour, 100 MB and delete rules", () => {
  assert.equal(
    RUNS_NOTE_TEXT,
    "Runs are kept for 24 hours. Each browser can keep up to 100 MB, and you can delete only the runs saved from "
      + "this browser. The store holds up to 1.5 GB; the oldest runs are removed first when it is full.",
  );
});

// The list is read with a plain GET and no browser id. A single run adds its id as a query value.
test("runsUrl builds the list and single-run addresses", () => {
  assert.equal(runsUrl(), "/api/runs");
  assert.equal(runsUrl(ID_A), `/api/runs?id=${ID_A}`);
});

// fetchRunList returns the summaries the server sends back.
test("fetchRunList returns the runs the server lists", async () => {
  const summary = { id: ID_A, kind: "batch", createdAt: NOW, size: 10, mine: true };
  const { fetchFn, calls } = fakeFetch(200, { runs: [summary] });
  assert.deepEqual(await fetchRunList(fetchFn), [summary]);
  assert.equal(calls[0].url, "/api/runs");
});

// A failed list is an error with a plain message, so the page can show it.
test("fetchRunList throws a plain error when the server fails", async () => {
  const { fetchFn } = fakeFetch(500, {});
  await assert.rejects(fetchRunList(fetchFn), /could not be loaded/);
});

// A save sends the kind and the run as JSON, and names the browser in its own header.
test("saveRunOnServer posts the run with its own id and the browser id in a header", async () => {
  const { fetchFn, calls } = fakeFetch(201, { id: ID_A });
  const run = { id: ID_A, label: "one" };
  assert.deepEqual(await saveRunOnServer(run, "batch", BROWSER, fetchFn), { id: ID_A });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-browser-id"], BROWSER);
  assert.deepEqual(JSON.parse(calls[0].init.body), { id: ID_A, kind: "batch", run });
});

// Saving a run that is already on the server replaces it, so a 200 is also a success.
test("saveRunOnServer accepts 200 as well as 201, because a saved run is replaced, not added again", async () => {
  const { fetchFn } = fakeFetch(200, { id: ID_A });
  assert.deepEqual(await saveRunOnServer({ id: ID_A }, "gauntlet", BROWSER, fetchFn), { id: ID_A });
});

// A refused save shows the server's own plain message, such as the browser being over its 100 MB.
test("saveRunOnServer shows the server's message when a save is refused", async () => {
  const { fetchFn } = fakeFetch(413, { error: "This browser has used its 100 MB." });
  await assert.rejects(saveRunOnServer({ id: ID_A }, "batch", BROWSER, fetchFn), /used its 100 MB/);
});

// Deleting names the browser in the header, and the run id in the address.
test("deleteRun sends the browser id in a header and the run id in the address", async () => {
  const { fetchFn, calls } = fakeFetch(200, { deleted: ID_A });
  await deleteRun(ID_A, BROWSER, fetchFn);
  assert.equal(calls[0].url, `/api/runs?id=${ID_A}`);
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(calls[0].init.headers["x-browser-id"], BROWSER);
});

// A run saved from another browser gets its own plain message.
test("deleteRun explains a run from another browser in plain words", async () => {
  const { fetchFn } = fakeFetch(403, { error: "x" });
  await assert.rejects(deleteRun(ID_A, BROWSER, fetchFn), /only delete runs saved from this browser/);
});

// Only this browser's own runs are copied back. A run another browser saved is left alone, even if it is a batch run.
// The copy is written only when the run id in the record matches the id asked for.
test("keepBrowserCopies copies this browser's gauntlet run, and leaves another browser's run alone", async () => {
  const adapter = createMemoryAdapter();
  const summaries = [
    { id: ID_A, kind: "gauntlet", createdAt: NOW, size: 1, mine: true },
    { id: ID_B, kind: "batch", createdAt: NOW, size: 1, mine: false },
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
  const summaries = [{ id: ID_A, kind: "gauntlet", createdAt: NOW, size: 1, mine: true }];
  const record = { id: ID_A, kind: "gauntlet", createdAt: NOW, run: { id: ID_B, label: "x" } };
  const { fetchFn } = fakeFetch(200, record);
  assert.equal(await keepBrowserCopies(adapter, summaries, fetchFn), 0);
  assert.deepEqual(await listRuns(adapter), []);
});

// Hours left: a run saved 1 hour ago has 23 hours left; a run 24 hours old has none; a run saved now has 24.
test("hoursLeft counts the hours a run has left before the 24-hour limit", () => {
  assert.equal(hoursLeft(NOW, NOW), 24);
  assert.equal(hoursLeft(NOW - HOUR_MS, NOW), 23);
  assert.equal(hoursLeft(NOW - 24 * HOUR_MS, NOW), 0);
  assert.equal(hoursLeft(NOW - 30 * HOUR_MS, NOW), 0);
});

// Sizes are shown in the largest unit that keeps the number under 1024.
test("sizeText shows bytes, KB, MB and GB", () => {
  assert.equal(sizeText(512), "512 bytes");
  assert.equal(sizeText(2048), "2.0 KB");
  assert.equal(sizeText(5 * 1024 * 1024), "5.0 MB");
  assert.equal(sizeText(1.5 * 1024 * 1024 * 1024), "1.5 GB");
});

// Each row names the kind, the size and the hours left, so a reader sees what the 24-hour rule means for that run.
test("rowText names the kind, size and hours left", () => {
  const row = rowText({ id: ID_A, kind: "gauntlet", createdAt: NOW, size: 2048 }, NOW);
  assert.equal(row.title, "Gauntlet run");
  assert.match(row.meta, /2\.0 KB/);
  assert.match(row.meta, /kept 24 more hours/);
  assert.equal(rowText({ id: ID_B, kind: "batch", createdAt: NOW, size: 1 }, NOW).title, "Batch run");
});
