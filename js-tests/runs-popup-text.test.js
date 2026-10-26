// Tests for site/js/runs-popup-text.js. These are pure functions: they take counts and return words, so no DOM is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runsButtonText, unfinishedCountText, savedCountText } from "../site/js/runs-popup-text.js";

// The Runs button says nothing extra when there are no runs, and names only the counts that are not zero.
test("runsButtonText is just Runs when there are no runs", () => {
  assert.equal(runsButtonText(0, 0), "Runs");
});

test("runsButtonText names only the saved runs when none are unfinished", () => {
  assert.equal(runsButtonText(0, 3), "Runs (3 saved)");
});

test("runsButtonText names only the unfinished runs when none are saved", () => {
  assert.equal(runsButtonText(1, 0), "Runs (1 unfinished)");
});

test("runsButtonText names both counts when there are both kinds", () => {
  assert.equal(runsButtonText(1, 3), "Runs (1 unfinished, 3 saved)");
});

// The section lines use the same plain wording, with the singular for exactly one run.
test("unfinishedCountText says there are no unfinished runs at zero", () => {
  assert.equal(unfinishedCountText(0), "No unfinished runs");
});

test("unfinishedCountText uses the singular for one run", () => {
  assert.equal(unfinishedCountText(1), "1 unfinished run");
});

test("unfinishedCountText uses the plural for two or more runs", () => {
  assert.equal(unfinishedCountText(2), "2 unfinished runs");
});

test("savedCountText says there are no saved runs yet at zero", () => {
  assert.equal(savedCountText(0), "No saved runs yet");
});

test("savedCountText uses the singular for one run", () => {
  assert.equal(savedCountText(1), "1 saved run");
});

test("savedCountText uses the plural for several runs", () => {
  assert.equal(savedCountText(4), "4 saved runs");
});
