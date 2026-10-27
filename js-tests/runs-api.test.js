// Tests for the browser side of the web runs (site/js/runs-api.js): the calls to /api/runs, each one carrying the
// visitor id, and the text shown in each row. Every request goes through a fake fetch, so nothing touches the
// network or a real browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RUNS_NOTE_TEXT,
  VISITOR_HEADER,
  runsUrl,
  fetchRunList,
  fetchRunRecord,
  saveRun,
  deleteRun,
  daysLeft,
  sizeText,
  rowText,
} from "../site/js/runs-api.js";
import { DAY_MS } from "../site/js/run-retention.js";

const NOW = 50 * DAY_MS;
const VISITOR = "0123456789abcdef0123456789abcdef";
const ID_A = "11111111-1111-4111-8111-111111111111";

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
test("the note on the runs page gives the 7-day, 200 MB, 1.5 GB and delete rules", () => {
  assert.equal(
    RUNS_NOTE_TEXT,
    "Your runs are kept for 7 days. You can hold up to 200 MB. The shared store holds up to 1.5 GB in total; "
      + "when it is full, the oldest runs are removed first. You can delete a run at any time.",
  );
});

// The visitor id travels in one header, under the name the server reads.
test("the visitor id is sent in the x-visitor-id header", () => {
  assert.equal(VISITOR_HEADER, "x-visitor-id");
});

// The list address is /api/runs, and one run adds its id as a query value.
test("runsUrl builds the list and single-run addresses", () => {
  assert.equal(runsUrl(), "/api/runs");
  assert.equal(runsUrl(ID_A), `/api/runs?id=${ID_A}`);
});

// The list is read with a GET that carries this browser's visitor id, and no password.
test("fetchRunList sends the visitor id and returns the runs the server lists", async () => {
  const summary = { id: ID_A, kind: "batch", createdAt: NOW, size: 10 };
  const { fetchFn, calls } = fakeFetch(200, { runs: [summary] });
  assert.deepEqual(await fetchRunList(VISITOR, fetchFn), [summary]);
  assert.equal(calls[0].url, "/api/runs");
  assert.equal(calls[0].init.headers["x-visitor-id"], VISITOR);
});

// A failed list is an error with a plain message, so the page can show it.
test("fetchRunList throws a plain error when the server fails", async () => {
  const { fetchFn } = fakeFetch(500, {});
  await assert.rejects(fetchRunList(VISITOR, fetchFn), /could not be loaded/);
});

// Reading one run sends the visitor id and the run id.
test("fetchRunRecord sends the visitor id and the run id", async () => {
  const record = { id: ID_A, kind: "gauntlet", createdAt: NOW, run: { label: "one" } };
  const { fetchFn, calls } = fakeFetch(200, record);
  assert.deepEqual(await fetchRunRecord(VISITOR, ID_A, fetchFn), record);
  assert.equal(calls[0].url, `/api/runs?id=${ID_A}`);
  assert.equal(calls[0].init.headers["x-visitor-id"], VISITOR);
});

// Saving posts the kind and the run as JSON, with the visitor id, and returns the summary the server sends back.
test("saveRun posts the kind and run with the visitor id and returns the summary", async () => {
  const summary = { id: ID_A, kind: "batch", createdAt: NOW, size: 120 };
  const { fetchFn, calls } = fakeFetch(201, summary);
  assert.deepEqual(await saveRun(VISITOR, "batch", { label: "x" }, fetchFn), summary);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-visitor-id"], VISITOR);
  assert.deepEqual(JSON.parse(calls[0].init.body), { kind: "batch", run: { label: "x" } });
});

// A refused save shows the server's own sentence, which says why (for example the 1.5 GB store is full).
test("saveRun shows the server's message when a save is refused", async () => {
  const { fetchFn } = fakeFetch(413, { error: "The shared store is full." });
  await assert.rejects(saveRun(VISITOR, "batch", {}, fetchFn), /The shared store is full\./);
});

// A failure with no message from the server gets the plain fallback sentence.
test("saveRun falls back to a plain sentence when the server gives none", async () => {
  const { fetchFn } = fakeFetch(500, {});
  await assert.rejects(saveRun(VISITOR, "gauntlet", {}, fetchFn), /could not be saved/);
});

// Deleting sends a DELETE with the visitor id. No password is sent, because the id is enough.
test("deleteRun sends the visitor id and no password", async () => {
  const { fetchFn, calls } = fakeFetch(200, { deleted: ID_A });
  assert.equal(await deleteRun(VISITOR, ID_A, fetchFn), true);
  assert.equal(calls[0].url, `/api/runs?id=${ID_A}`);
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(calls[0].init.headers["x-visitor-id"], VISITOR);
  assert.equal(calls[0].init.headers.authorization, undefined);
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
  assert.equal(rowText({ id: ID_A, kind: "batch", createdAt: NOW, size: 1 }, NOW).title, "Batch run");
});
