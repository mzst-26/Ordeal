// Tests for the pure logic of the web run functions: the admin password check and the rules for a saved run.
// They use plain objects and strings only. Nothing calls Netlify, Netlify Blobs or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { passwordMatches } from "../netlify/lib/write-password.js";
import { KINDS, checkNewRun, runIdIsValid, buildRecord, summaryOf } from "../netlify/lib/run-rules.js";

const EXPECTED = "example-write-password";
const VALID_ID = "3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f";

// The write password must come as "Authorization: Bearer <password>". The scheme word is not case sensitive.
test("passwordMatches accepts the right password in a Bearer header", () => {
  assert.equal(passwordMatches(`Bearer ${EXPECTED}`, EXPECTED), true);
  assert.equal(passwordMatches(`bearer ${EXPECTED}`, EXPECTED), true);
});

// A wrong password, a missing header, another scheme, or a header with no password all get false.
test("passwordMatches refuses a wrong, missing or differently shaped header", () => {
  assert.equal(passwordMatches(`Bearer ${EXPECTED}x`, EXPECTED), false);
  assert.equal(passwordMatches(`Bearer wrong`, EXPECTED), false);
  assert.equal(passwordMatches(undefined, EXPECTED), false);
  assert.equal(passwordMatches("", EXPECTED), false);
  assert.equal(passwordMatches(`Basic ${EXPECTED}`, EXPECTED), false);
  assert.equal(passwordMatches("Bearer", EXPECTED), false);
});

// When WRITE_PASSWORD is not set, nothing can be written, even by a request with an empty bearer value.
test("passwordMatches refuses every request when no password is configured", () => {
  assert.equal(passwordMatches("Bearer ", undefined), false);
  assert.equal(passwordMatches("Bearer ", ""), false);
  assert.equal(passwordMatches(`Bearer ${EXPECTED}`, undefined), false);
  assert.equal(passwordMatches(`Bearer ${EXPECTED}`, ""), false);
});

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

// Ids are made by the server as UUIDs. Anything else is refused, so a request cannot pick a strange storage key.
test("runIdIsValid only accepts a lower-case UUID", () => {
  assert.equal(runIdIsValid(VALID_ID), true);
  assert.equal(runIdIsValid("../etc"), false);
  assert.equal(runIdIsValid("3F2A9C1E-7B4D-4E8A-9C2F-1A2B3C4D5E6F"), false);
  assert.equal(runIdIsValid(undefined), false);
});

// The stored record keeps the id, kind, creation time and run. The summary shown in a list is read from the metadata.
test("buildRecord and summaryOf give the same kind, size and creation time", () => {
  const record = buildRecord(VALID_ID, { kind: "batch", run: { label: "one" } }, 1000);
  assert.deepEqual(record, { id: VALID_ID, kind: "batch", createdAt: 1000, run: { label: "one" } });
  const metadata = { kind: "batch", createdAt: 1000, bytes: 52 };
  assert.deepEqual(summaryOf(VALID_ID, metadata), { id: VALID_ID, kind: "batch", createdAt: 1000, size: 52 });
});

