// Suite choices for the two pages. A suite is one pushback set (a ladder and its probe spec) with one question set.
// The data files come from site/data, and rules.makeSuite checks them with the same rules core.py uses.
// This file does no DOM work.

import { makeSuite } from "./engine/rules.js";

// The pushback sets: the ladder file and the probe spec file that go with each one.
export const PUSHBACK_SETS = Object.freeze({
  gauntlet_v3: Object.freeze({ ladder: "/data/ladder.json", probeSpec: "/data/probe_spec.json" }),
  gauntlet_v4: Object.freeze({ ladder: "/data/ladder_v4.json", probeSpec: "/data/probe_spec_v4.json" }),
});

// The question sets: the file of questions for each one.
export const QUESTION_SETS = Object.freeze({
  easy: Object.freeze({ questions: "/data/questions.json" }),
  hard: Object.freeze({ questions: "/data/questions_hard.json" }),
});

export const DEFAULT_PUSHBACK_SET = "gauntlet_v3";
export const DEFAULT_QUESTION_SET = "easy";
// The one suite whose saved replies are in sample_run.json. Those replies were recorded with no system prompt.
export const SAVED_SUITE_NAME = "gauntlet_v3+easy";

/** Return true when the name is a pushback set this site knows. */
export function isPushbackSet(name) {
  return Object.hasOwn(PUSHBACK_SETS, name);
}

/** Return true when the name is a question set this site knows. */
export function isQuestionSet(name) {
  return Object.hasOwn(QUESTION_SETS, name);
}

/** Return the names of the pushback sets, in the order they are listed. */
export function pushbackSetNames() {
  return Object.keys(PUSHBACK_SETS);
}

/** Return the names of the question sets, in the order they are listed. */
export function questionSetNames() {
  return Object.keys(QUESTION_SETS);
}

/** Return true for the suite whose saved replies exist in the site data. */
export function isSavedSuite(suite) {
  return suite.name === SAVED_SUITE_NAME;
}

/** Return the one-line description of a suite for the page, with its level and question counts. */
export function suiteSummary(suite) {
  return `${suite.name}: ${suite.levelCount} levels, ${suite.questions.length} questions`;
}

/**
 * Build a suite from data that is already loaded. Throws the same messages as rules.makeSuite when the
 * data breaks a rule.
 */
export function buildSuite({ pushbackSet, questionSet, ladder, probeSpec, questions }) {
  return makeSuite({ ladderName: pushbackSet, questionSet, ladder, probeSpec, questions });
}

/**
 * Return a loader for suites. load(pushbackSet, questionSet) fetches the three files through loadJson, builds
 * the suite and keeps it, so choosing the same suite again does not fetch anything. A failed load is not kept.
 */
export function createSuiteLoader(loadJson) {
  const built = new Map();
  return {
    /** Return the suite for these two set names. Rejects with a plain message for an unknown set name. */
    async load(pushbackSet, questionSet) {
      if (!isPushbackSet(pushbackSet) || !isQuestionSet(questionSet)) {
        throw new Error(`The suite ${pushbackSet} with ${questionSet} is not one this site has.`);
      }
      const key = `${pushbackSet}+${questionSet}`;
      if (!built.has(key)) {
        built.set(key, await fetchSuite(loadJson, pushbackSet, questionSet));
      }
      return built.get(key);
    },
  };
}

/** Fetch the three data files of one suite and build it. */
async function fetchSuite(loadJson, pushbackSet, questionSet) {
  const pushback = PUSHBACK_SETS[pushbackSet];
  const questions = QUESTION_SETS[questionSet];
  const [ladder, probeSpec, questionList] = await Promise.all([
    loadJson(pushback.ladder),
    loadJson(pushback.probeSpec),
    loadJson(questions.questions),
  ]);
  return buildSuite({ pushbackSet, questionSet, ladder, probeSpec, questions: questionList });
}
