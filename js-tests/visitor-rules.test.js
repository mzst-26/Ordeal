// Tests for the visitor rules of the web run store (site/js/visitor-rules.js). Each browser has its own visitor id,
// and every stored run lives under a key that names that id. These tests use plain strings and objects only, so
// they need no network, no browser and no Netlify.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VISITOR_ID_MIN_LENGTH,
  checkVisitorId,
  ownerPrefix,
  runKeyFor,
  parseOwnerKey,
  ownedBy,
} from "../site/js/visitor-rules.js";

const VISITOR = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const RUN = "3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f";

// A visitor id must be at least 32 characters, which is 128 random bits written in hex.
test("a visitor id of at least 32 letters, digits, - or _ is accepted", () => {
  assert.equal(VISITOR_ID_MIN_LENGTH, 32);
  assert.deepEqual(checkVisitorId(VISITOR), { ok: true });
  assert.deepEqual(checkVisitorId("a".repeat(32)), { ok: true });
  assert.deepEqual(checkVisitorId("AZaz09-_".repeat(4)), { ok: true });
});

// A request with no visitor id is refused, and the message says what is missing.
test("a missing visitor id is refused with a clear message", () => {
  for (const value of [undefined, null, "", 42]) {
    const result = checkVisitorId(value);
    assert.equal(result.ok, false);
    assert.match(result.error, /missing/);
  }
});

// A short id is refused, and the message gives the length it must reach.
test("a short visitor id is refused and the message says the minimum length", () => {
  const result = checkVisitorId("a".repeat(31));
  assert.equal(result.ok, false);
  assert.match(result.error, /at least 32/);
});

// Only letters, digits, - and _ are allowed, so an id cannot add a slash and change the storage key.
test("a visitor id with other characters, such as a slash, is refused", () => {
  const result = checkVisitorId(`${VISITOR}/x`);
  assert.equal(result.ok, false);
  assert.match(result.error, /letters, digits/);
});

// A very long id is refused too, so a request cannot make the storage keys huge.
test("a visitor id longer than 128 characters is refused", () => {
  const result = checkVisitorId("a".repeat(129));
  assert.equal(result.ok, false);
  assert.match(result.error, /at most 128/);
});

// The key for a run is owner/<visitor id>/<run id>, and the prefix for a visitor is owner/<visitor id>/.
test("the storage key is owner, the visitor id and the run id", () => {
  assert.equal(ownerPrefix(VISITOR), `owner/${VISITOR}/`);
  assert.equal(runKeyFor(VISITOR, RUN), `owner/${VISITOR}/${RUN}`);
});

// Building a key from a bad id throws, so a bug cannot quietly write a run under no owner.
test("building a key from a bad visitor id or run id throws", () => {
  assert.throws(() => runKeyFor("short", RUN), /at least 32/);
  assert.throws(() => ownerPrefix(undefined), /missing/);
  assert.throws(() => runKeyFor(VISITOR, "../other"), /run id/);
  assert.throws(() => runKeyFor(VISITOR, ""), /run id/);
});

// A key can be read back into its visitor and run. A key with extra parts or another start is not a run key.
test("parseOwnerKey reads the visitor and the run back, and rejects other keys", () => {
  assert.deepEqual(parseOwnerKey(runKeyFor(VISITOR, RUN)), { visitorId: VISITOR, runId: RUN });
  assert.equal(parseOwnerKey(`run-${RUN}`), null);
  assert.equal(parseOwnerKey(`owner/${VISITOR}/a/b`), null);
  assert.equal(parseOwnerKey(`owner/${VISITOR}/`), null);
});

// ownedBy keeps only the entries that belong to one visitor, in the order they were given.
test("ownedBy keeps only one visitor's entries, in their order", () => {
  const entries = [
    { id: "x", owner: VISITOR, createdAt: 1, bytes: 1 },
    { id: "y", owner: OTHER, createdAt: 2, bytes: 1 },
    { id: "z", owner: VISITOR, createdAt: 3, bytes: 1 },
  ];
  assert.deepEqual(ownedBy(entries, VISITOR).map((entry) => entry.id), ["x", "z"]);
  assert.deepEqual(ownedBy(entries, "nobody-has-this-id-0000000000000000"), []);
});
