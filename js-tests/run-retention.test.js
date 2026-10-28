// Tests for the retention and size rules of the web run store (frontend/js/run-retention.js). The rules are pure
// functions on small plain objects, so these tests need no network, no browser and no Netlify.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RETENTION_HOURS,
  HOUR_MS,
  DAY_MS,
  BROWSER_CAP_BYTES,
  isExpired,
  expiredRunIds,
  totalBytes,
  browserBytes,
  fitsBrowserCap,
  planSizeCleanup,
} from "../frontend/js/run-retention.js";

const NOW = 100 * DAY_MS;

// Retention: a run older than 24 hours is expired. A run exactly 24 hours old is still kept.
test("a run older than 24 hours is expired, and a run of exactly 24 hours is kept", () => {
  assert.equal(RETENTION_HOURS, 24);
  assert.equal(isExpired(NOW - 25 * HOUR_MS, NOW), true);
  assert.equal(isExpired(NOW - 24 * HOUR_MS, NOW), false);
  assert.equal(isExpired(NOW - 1 * HOUR_MS, NOW), false);
});

// expiredRunIds picks out only the old runs, and keeps the order they were given in.
test("expiredRunIds returns the ids of the old runs only", () => {
  const runs = [
    { id: "old", createdAt: NOW - 2 * DAY_MS, bytes: 1 },
    { id: "new", createdAt: NOW - 1 * HOUR_MS, bytes: 1 },
    { id: "edge", createdAt: NOW - 24 * HOUR_MS, bytes: 1 },
  ];
  assert.deepEqual(expiredRunIds(runs, NOW), ["old"]);
});

// The browser cap is 100 MB, counted in bytes.
test("the browser cap is 100 MB", () => {
  assert.equal(BROWSER_CAP_BYTES, 100 * 1024 * 1024);
});

// browserBytes adds up only the runs that browser saved.
test("browserBytes counts only the runs owned by that browser", () => {
  const runs = [
    { id: "a", createdAt: 1, bytes: 40, owner: "me" },
    { id: "b", createdAt: 2, bytes: 30, owner: "other" },
    { id: "c", createdAt: 3, bytes: 20, owner: "me" },
  ];
  assert.equal(browserBytes(runs, "me"), 60);
  assert.equal(browserBytes(runs, "nobody"), 0);
});

// A save that would take one browser over its cap is refused, even when the whole store has room.
test("a save over the browser's cap does not fit, and another browser's runs do not count", () => {
  const runs = [{ id: "a", createdAt: 1, bytes: 90, owner: "me" }, { id: "b", createdAt: 2, bytes: 500, owner: "other" }];
  assert.equal(fitsBrowserCap(runs, "me", 10, 100), true);
  assert.equal(fitsBrowserCap(runs, "me", 11, 100), false);
  assert.equal(fitsBrowserCap(runs, "fresh", 100, 100), true);
});

// Size cap: the cap is checked against the total of the kept runs plus the new save.
// Here the cap is 100 bytes. Runs a (oldest, 40), b (30) and c (20) hold 90, and a new 50 byte save would make 140.
const CAP = 100;
const SIZED_RUNS = [
  { id: "c", createdAt: 3, bytes: 20 },
  { id: "a", createdAt: 1, bytes: 40 },
  { id: "b", createdAt: 2, bytes: 30 },
];

// Removing the oldest run first (a, 40 bytes) brings the total to 50, and 50 + 50 = 100 fits, so only a goes.
test("a save that goes over the cap removes the oldest run first, and only as many as needed", () => {
  assert.equal(totalBytes(SIZED_RUNS), 90);
  assert.deepEqual(planSizeCleanup(SIZED_RUNS, 50, CAP), { removeIds: ["a"], fits: true });
});

// The cap is not exceeded when the save fits as it is, so nothing is removed.
test("a save that fits under the cap removes nothing", () => {
  assert.deepEqual(planSizeCleanup(SIZED_RUNS, 10, CAP), { removeIds: [], fits: true });
});

// A save bigger than the whole cap can never fit. Every run is removed and the plan says it does not fit.
test("a save bigger than the whole cap removes every run and says it does not fit", () => {
  assert.deepEqual(planSizeCleanup(SIZED_RUNS, 150, CAP), { removeIds: ["a", "b", "c"], fits: false });
});

// The input array is not reordered, so the caller's list stays as it was.
test("planSizeCleanup does not change the list it is given", () => {
  const before = SIZED_RUNS.map((run) => run.id);
  planSizeCleanup(SIZED_RUNS, 50, CAP);
  assert.deepEqual(SIZED_RUNS.map((run) => run.id), before);
});
