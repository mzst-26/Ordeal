// Tests for the pure logic of the web run functions: the rules for a saved run and the browser that saved it.
// They use plain objects and strings only. Nothing calls Netlify, Netlify Blobs or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KINDS,
  checkNewRun,
  runIdIsValid,
  browserIdIsValid,
  buildRecord,
  summaryOf,
  toRetentionRuns,
} from "../netlify/lib/run-rules.js";

const VALID_ID = "3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f";
const BROWSER = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

// Only the two kinds of run the pages make may be saved.
test("the saved kinds are batch and gauntlet", () => {
  assert.deepEqual([...KINDS], ["batch", "gauntlet"]);
});

// A save needs a known kind and a run object. Anything else is refused with a plain message.
test("checkNewRun accepts a known kind with a run object, and refuses the rest", () => {
  assert.deepEqual(checkNewRun({ kind: "gauntlet", run: { id: "x" } }), { ok: true });
  assert.equal(checkNewRun({ kind: "other", run: {} }).ok, false);
  assert.equal(checkNewRun({ kind: "batch" }).ok, false);
  assert.equal(checkNewRun({ kind: "batch", run: [] }).ok, false);
  assert.equal(checkNewRun(null).ok, false);
  assert.equal(checkNewRun("text").ok, false);
});

// Run ids are made by the server as UUIDs. Anything else is refused, so a request cannot pick a strange storage key.
test("runIdIsValid only accepts a lower-case UUID", () => {
  assert.equal(runIdIsValid(VALID_ID), true);
  assert.equal(runIdIsValid("../etc"), false);
  assert.equal(runIdIsValid("3F2A9C1E-7B4D-4E8A-9C2F-1A2B3C4D5E6F"), false);
  assert.equal(runIdIsValid(undefined), false);
});

// A browser id has the same shape. A missing or made-up id is refused before anything is counted against it.
test("browserIdIsValid only accepts a lower-case UUID", () => {
  assert.equal(browserIdIsValid(BROWSER), true);
  assert.equal(browserIdIsValid("me"), false);
  assert.equal(browserIdIsValid(null), false);
});

// The stored record keeps the id, kind, creation time, owner and run.
test("buildRecord keeps the owner browser with the run", () => {
  const record = buildRecord(VALID_ID, { kind: "batch", run: { label: "one" } }, 1000, BROWSER);
  assert.deepEqual(record, { id: VALID_ID, kind: "batch", createdAt: 1000, owner: BROWSER, run: { label: "one" } });
});

// The summary read from the metadata carries the size, and the owner for the server to check against.
test("summaryOf and toRetentionRuns carry the size and the owner", () => {
  const metadata = { kind: "batch", createdAt: 1000, bytes: 52, owner: BROWSER };
  const summary = summaryOf(VALID_ID, metadata);
  assert.deepEqual(summary, { id: VALID_ID, kind: "batch", createdAt: 1000, size: 52, owner: BROWSER });
  assert.deepEqual(toRetentionRuns([summary]), [{ id: VALID_ID, createdAt: 1000, bytes: 52, owner: BROWSER }]);
});

// A save or delete with no browser id is refused with 400, before any storage is opened.
test("the runs handler answers 400 to a save or delete that names no browser", async () => {
  const { default: handler } = await import("../netlify/functions/runs.js");
  const url = `https://example.test/api/runs?id=${VALID_ID}`;
  const deleted = await handler(new Request(url, { method: "DELETE" }));
  const saved = await handler(new Request("https://example.test/api/runs", { method: "POST", body: "{}" }));
  assert.equal(deleted.status, 400);
  assert.equal(saved.status, 400);
});
