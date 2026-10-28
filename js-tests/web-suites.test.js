// Tests for the suite choices (frontend/js/suites.js): the level counts and the setup turn come from the data files.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSuite,
  createSuiteLoader,
  isSavedSuite,
  suiteSummary,
  DEFAULT_PUSHBACK_SET,
  DEFAULT_QUESTION_SET,
  PUSHBACK_SETS,
  QUESTION_SETS,
} from "../frontend/js/suites.js";
import { setupLevel } from "../frontend/js/engine/rules.js";
import { readJson } from "./helpers.js";

const FILES = {
  "/data/ladder.json": "frontend/data/ladder.json",
  "/data/probe_spec.json": "frontend/data/probe_spec.json",
  "/data/ladder_v4.json": "frontend/data/ladder_v4.json",
  "/data/probe_spec_v4.json": "frontend/data/probe_spec_v4.json",
  "/data/questions.json": "frontend/data/questions.json",
  "/data/questions_hard.json": "frontend/data/questions_hard.json",
};

/** Return a fake loader that reads the site data files, and counts how often each one is read. */
function fakeLoader() {
  const reads = new Map();
  const loadJson = async (path) => {
    reads.set(path, (reads.get(path) ?? 0) + 1);
    return readJson(FILES[path]);
  };
  return { loadJson, reads };
}

// Suite shapes: level count, held-firm score and setup turn follow the data files for each ladder.
test("the defaults are gauntlet_v3 with the easy questions, the saved suite", () => {
  assert.equal(DEFAULT_PUSHBACK_SET, "gauntlet_v3");
  assert.equal(DEFAULT_QUESTION_SET, "easy");
  assert.deepEqual(Object.keys(PUSHBACK_SETS).sort(), ["gauntlet_v3", "gauntlet_v4"]);
  assert.deepEqual(Object.keys(QUESTION_SETS).sort(), ["easy", "hard"]);
});

test("gauntlet_v4 gives 12 levels with the setup turn at level 5", async () => {
  const { loadJson } = fakeLoader();
  const suite = await createSuiteLoader(loadJson).load("gauntlet_v4", "hard");
  assert.equal(suite.name, "gauntlet_v4+hard");
  assert.equal(suite.levelCount, 12);
  assert.equal(suite.heldFirmScore, 13);
  assert.equal(setupLevel(suite.ladder), 5);
  assert.equal(suite.pushbackSteps.length, 12);
  assert.equal(suite.pushbackSteps[11], "level_12");
  assert.equal(suite.questions.length, 59);
});

test("gauntlet_v3 gives 10 levels with the setup turn at level 4", async () => {
  const { loadJson } = fakeLoader();
  const suite = await createSuiteLoader(loadJson).load("gauntlet_v3", "easy");
  assert.equal(suite.name, "gauntlet_v3+easy");
  assert.equal(suite.levelCount, 10);
  assert.equal(suite.heldFirmScore, 11);
  assert.equal(setupLevel(suite.ladder), 4);
  assert.equal(suite.questions.length, 32);
  assert.equal(isSavedSuite(suite), true);
});

test("only the gauntlet_v3 easy suite counts as the saved suite", async () => {
  const { loadJson } = fakeLoader();
  const loader = createSuiteLoader(loadJson);
  assert.equal(isSavedSuite(await loader.load("gauntlet_v3", "hard")), false);
  assert.equal(isSavedSuite(await loader.load("gauntlet_v4", "easy")), false);
});

test("the summary names the suite with its level and question counts", async () => {
  const { loadJson } = fakeLoader();
  const suite = await createSuiteLoader(loadJson).load("gauntlet_v4", "easy");
  assert.equal(suiteSummary(suite), "gauntlet_v4+easy: 12 levels, 32 questions");
});

// Loader behaviour: suites are cached, unknown sets are refused, and a failed load is retried.
test("a suite is read once, then kept", async () => {
  const { loadJson, reads } = fakeLoader();
  const loader = createSuiteLoader(loadJson);
  await loader.load("gauntlet_v4", "hard");
  await loader.load("gauntlet_v4", "hard");
  assert.equal(reads.get("/data/ladder_v4.json"), 1);
  assert.equal(reads.get("/data/questions_hard.json"), 1);
});

test("an unknown pushback or question set is refused", async () => {
  const { loadJson } = fakeLoader();
  const loader = createSuiteLoader(loadJson);
  await assert.rejects(loader.load("gauntlet_v9", "easy"), /is not one this site has/);
  await assert.rejects(loader.load("gauntlet_v3", "medium"), /is not one this site has/);
});

test("a load that fails is not kept, so the next try reads again", async () => {
  let fail = true;
  const loadJson = async (path) => {
    if (fail) throw new Error("Could not load " + path);
    return readJson(FILES[path]);
  };
  const loader = createSuiteLoader(loadJson);
  await assert.rejects(loader.load("gauntlet_v3", "easy"));
  fail = false;
  const suite = await loader.load("gauntlet_v3", "easy");
  assert.equal(suite.levelCount, 10);
});

// buildSuite applies the same data rules as core.py.
test("buildSuite rejects data that breaks the rules of core.py", () => {
  const ladder = readJson("frontend/data/ladder_v4.json");
  const probeSpec = readJson("frontend/data/probe_spec_v4.json");
  const questions = readJson("frontend/data/questions.json");
  assert.throws(
    () => buildSuite({ pushbackSet: "gauntlet_v4", questionSet: "easy", ladder: { levels: [] }, probeSpec, questions }),
    /needs at least one level/,
  );
  assert.equal(buildSuite({ pushbackSet: "gauntlet_v4", questionSet: "easy", ladder, probeSpec, questions }).levelCount, 12);
});
