// Tests for the one suite choice on the batch and gauntlet pages (frontend/js/suites.js). The page offers three choices:
// Gauntlet v4 with hard questions, Gauntlet v3 with easy questions (the default), and Shuffle. These tests check the
// three options, the sets each fixed option stands for, and the two pairings that are no longer offered.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CHOICE,
  SHUFFLE_CHOICE,
  choiceValueOfSets,
  choiceValueOfSuite,
  fixedChoiceMenu,
  retiredPairText,
  setsOfChoice,
  suiteChoiceMenu,
  suiteSummary,
} from "../../frontend/js/suites.js";
import { readJson } from "./helpers.js";

test("the page offers three choices in this order: Gauntlet v4 hard, Gauntlet v3 easy, Shuffle", () => {
  assert.deepEqual(suiteChoiceMenu(), [
    { value: "gauntlet_v4+hard", label: "Gauntlet v4 – hard questions" },
    { value: "gauntlet_v3+easy", label: "Gauntlet v3 – easy questions" },
    { value: "shuffle", label: "Shuffle" },
  ]);
});

test("the default choice is Gauntlet v3 with the easy questions, the suite the saved replies belong to", () => {
  assert.equal(DEFAULT_CHOICE, "gauntlet_v3+easy");
  assert.equal(SHUFFLE_CHOICE, "shuffle");
  assert.deepEqual(setsOfChoice(DEFAULT_CHOICE), { pushbackSet: "gauntlet_v3", questionSet: "easy" });
});

test("each fixed choice is named like a suite in the suites index", () => {
  const names = readJson("frontend/data/suites.json").map((entry) => entry.name);
  for (const choice of suiteChoiceMenu()) {
    if (choice.value !== SHUFFLE_CHOICE) {
      assert.ok(names.includes(choice.value), `${choice.value} is not in frontend/data/suites.json`);
    }
  }
});

// The Live page runs one ladder with one question at a time, so it offers the fixed choices only, never Shuffle.
test("the Live menu offers the two fixed choices, in the same order and labels, and no Shuffle", () => {
  assert.deepEqual(fixedChoiceMenu(), [
    { value: "gauntlet_v4+hard", label: "Gauntlet v4 – hard questions" },
    { value: "gauntlet_v3+easy", label: "Gauntlet v3 – easy questions" },
  ]);
  for (const choice of fixedChoiceMenu()) {
    assert.notEqual(choice.value, SHUFFLE_CHOICE);
    assert.ok(setsOfChoice(choice.value).pushbackSet, `${choice.value} must name a pushback set`);
  }
});

test("the two fixed choices map to their pushback set and question set", () => {
  assert.deepEqual(setsOfChoice("gauntlet_v4+hard"), { pushbackSet: "gauntlet_v4", questionSet: "hard" });
  assert.deepEqual(setsOfChoice("gauntlet_v3+easy"), { pushbackSet: "gauntlet_v3", questionSet: "easy" });
});

test("Shuffle has no fixed sets, and a value the site does not offer is refused", () => {
  assert.throws(() => setsOfChoice("shuffle"), /is not one this site offers/);
  assert.throws(() => setsOfChoice("gauntlet_v3+hard"), /is not one this site offers/);
});

test("the two pairings no longer offered have no choice value", () => {
  assert.equal(choiceValueOfSets("gauntlet_v3", "hard"), null);
  assert.equal(choiceValueOfSets("gauntlet_v4", "easy"), null);
  assert.equal(choiceValueOfSets("gauntlet_v4", "hard"), "gauntlet_v4+hard");
  assert.equal(choiceValueOfSets("gauntlet_v3", "easy"), "gauntlet_v3+easy");
});

test("a retired pairing gets a plain line naming it, and an offered pairing gets none", () => {
  assert.equal(retiredPairText("gauntlet_v3", "hard"), "gauntlet_v3 with hard questions is no longer offered on this site.");
  assert.equal(retiredPairText("gauntlet_v4", "easy"), "gauntlet_v4 with easy questions is no longer offered on this site.");
  assert.equal(retiredPairText("gauntlet_v4", "hard"), "");
  assert.equal(retiredPairText("gauntlet_v3", "easy"), "");
});

test("the summary reads with the label of the choice, then the level and question counts", () => {
  const suite = {
    name: "gauntlet_v3+easy",
    ladderName: "gauntlet_v3",
    questionSet: "easy",
    levelCount: 10,
    questions: new Array(32).fill({}),
  };
  assert.equal(suiteSummary(suite), "Gauntlet v3 – easy questions: 10 levels, 32 questions");
});

test("a mixed suite is the Shuffle choice, and a fixed suite is its own choice value", () => {
  assert.equal(choiceValueOfSuite({ mixed: true, name: "mixed" }), "shuffle");
  assert.equal(choiceValueOfSuite({ name: "gauntlet_v4+hard", ladderName: "gauntlet_v4", questionSet: "hard" }), "gauntlet_v4+hard");
});
