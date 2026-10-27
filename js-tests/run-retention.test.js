// Tests for the retention and size rules of the web run store (site/js/run-retention.js). The rules are pure
// functions on small plain objects, so these tests need no network, no browser and no Netlify.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RETENTION_DAYS,
  DAY_MS,
  VISITOR_MAX_BYTES,
  MAX_STORE_BYTES,
  isExpired,
  expiredRunIds,
  totalBytes,
  planVisitorSave,
} from "../site/js/run-retention.js";

const NOW = 100 * DAY_MS;
const MINE = "0123456789abcdef0123456789abcdef";
const THEIRS = "fedcba9876543210fedcba9876543210";

/** Return a run entry in the shape the rules read: id, owner, createdAt (ms) and bytes. */
function entry(id, owner, createdAt, bytes) {
  return { id, owner, createdAt, bytes };
}

// Retention: a run older than 7 days is expired. A run exactly 7 days old is still kept.
test("a run older than 7 days is expired, and a run of exactly 7 days is kept", () => {
  assert.equal(RETENTION_DAYS, 7);
  assert.equal(isExpired(NOW - 8 * DAY_MS, NOW), true);
  assert.equal(isExpired(NOW - 7 * DAY_MS, NOW), false);
  assert.equal(isExpired(NOW - 1 * DAY_MS, NOW), false);
});

// expiredRunIds picks out only the old runs, from any visitor, and keeps the order they were given in.
test("expiredRunIds returns the ids of the old runs of every visitor", () => {
  const runs = [
    entry("old", MINE, NOW - 10 * DAY_MS, 1),
    entry("new", THEIRS, NOW - 1 * DAY_MS, 1),
    entry("edge", MINE, NOW - 7 * DAY_MS, 1),
    entry("old-theirs", THEIRS, NOW - 9 * DAY_MS, 1),
  ];
  assert.deepEqual(expiredRunIds(runs, NOW), ["old", "old-theirs"]);
});

// The caps: 200 MB for each visitor and 1.5 GB for the whole store. The owner set these numbers.
test("the per-visitor cap is 200 MB and the store cap is 1.5 GB", () => {
  assert.equal(VISITOR_MAX_BYTES, 200 * 1024 * 1024);
  assert.equal(MAX_STORE_BYTES, 1.5 * 1024 * 1024 * 1024);
});

// The caps are small in these tests so the numbers are easy to check. Mine: a (oldest, 40), b (30) and c (20),
// which is 90 bytes.
const VISITOR_CAP = 100;
const STORE_CAP = 1000;
const MY_RUNS = [
  entry("c", MINE, 3, 20),
  entry("a", MINE, 1, 40),
  entry("b", MINE, 2, 30),
];

// The helper sums bytes, so the tests below read the same way a reader would count them.
test("totalBytes adds the bytes of the runs, and an empty list holds 0", () => {
  assert.equal(totalBytes(MY_RUNS), 90);
  assert.equal(totalBytes([]), 0);
});

// Over the visitor cap: 90 + 50 = 140 is over 100, so the visitor's oldest run (a, 40) goes. 50 + 50 = 100 fits.
test("a save that breaks the visitor cap removes that visitor's oldest run first", () => {
  const plan = planVisitorSave({
    visitorRuns: MY_RUNS,
    storeRuns: MY_RUNS,
    incomingBytes: 50,
    visitorMax: VISITOR_CAP,
    storeMax: STORE_CAP,
  });
  assert.deepEqual(plan, { removeIds: ["a"], fits: true, reason: "ok" });
});

// A save that fits under both caps removes nothing.
test("a save that fits under both caps removes nothing", () => {
  const plan = planVisitorSave({
    visitorRuns: MY_RUNS,
    storeRuns: MY_RUNS,
    incomingBytes: 10,
    visitorMax: VISITOR_CAP,
    storeMax: STORE_CAP,
  });
  assert.deepEqual(plan, { removeIds: [], fits: true, reason: "ok" });
});

// Over the store cap: another visitor holds 120 bytes, so the store total is 210 and a 30 byte save makes 240,
// which is over 200. Removing my oldest run (a, 40) leaves 170 + 30 = 200, which fits.
test("a save that breaks the store cap removes only the visitor's own oldest runs", () => {
  const theirs = [entry("x", THEIRS, 0, 120)];
  const plan = planVisitorSave({
    visitorRuns: MY_RUNS,
    storeRuns: [...MY_RUNS, ...theirs],
    incomingBytes: 30,
    visitorMax: 1000,
    storeMax: 200,
  });
  assert.deepEqual(plan, { removeIds: ["a"], fits: true, reason: "ok" });
});

// When other visitors fill the store, removing every one of my runs still leaves too little room. The save is
// refused and nothing is removed, so a refused save never costs the visitor a run.
test("a save that cannot fit even after the visitor's own runs are removed is refused and removes nothing", () => {
  const theirs = [entry("x", THEIRS, 0, 180)];
  const plan = planVisitorSave({
    visitorRuns: MY_RUNS,
    storeRuns: [...MY_RUNS, ...theirs],
    incomingBytes: 30,
    visitorMax: 1000,
    storeMax: 200,
  });
  assert.deepEqual(plan, { removeIds: [], fits: false, reason: "store" });
});

// A single run bigger than the visitor cap can never fit, so it is refused before anything is removed.
test("a run bigger than the visitor cap is refused with reason visitor, and removes nothing", () => {
  const plan = planVisitorSave({
    visitorRuns: MY_RUNS,
    storeRuns: MY_RUNS,
    incomingBytes: 150,
    visitorMax: VISITOR_CAP,
    storeMax: STORE_CAP,
  });
  assert.deepEqual(plan, { removeIds: [], fits: false, reason: "visitor" });
});

// The caller's list is not reordered, so it stays as it was.
test("planVisitorSave does not change the lists it is given", () => {
  const before = MY_RUNS.map((run) => run.id);
  planVisitorSave({ visitorRuns: MY_RUNS, storeRuns: MY_RUNS, incomingBytes: 50, visitorMax: VISITOR_CAP, storeMax: STORE_CAP });
  assert.deepEqual(MY_RUNS.map((run) => run.id), before);
});
