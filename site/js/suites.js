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

/**
 * Return the one-line description of a suite for the page, such as "gauntlet_v3+easy: 10 levels, 32 questions".
 * The name already says which pushback set and question set the suite uses.
 */
export function suiteSummary(suite) {
  return `${suite.name}: ${suite.levelCount} levels, ${suite.questions.length} questions`;
}

/** Return the dropdown entries for a list of set names. Each set is shown under its own name. */
export function setMenuChoices(names) {
  return names.map((name) => ({ value: name, label: name }));
}

/** Return a choice of two sets: the shape the pages pass to selectSuite. */
export function fixedChoice(pushbackSet, questionSet) {
  return { pushbackSet, questionSet };
}

/**
 * Return the choice that a suite on the desk was made from: its two sets. With no suite yet, the default choice.
 */
export function choiceOfSuite(suite) {
  if (suite === null) {
    return fixedChoice(DEFAULT_PUSHBACK_SET, DEFAULT_QUESTION_SET);
  }
  return fixedChoice(suite.ladderName, suite.questionSet);
}

/**
 * Build a suite from data that is already loaded. Throws the same messages as rules.makeSuite when the
 * data breaks a rule.
 */
export function buildSuite({ pushbackSet, questionSet, ladder, probeSpec, questions }) {
  return makeSuite({ ladderName: pushbackSet, questionSet, ladder, probeSpec, questions });
}

/**
 * Return a loader for suites. load(pushbackSet, questionSet) fetches the data files through loadJson, builds the
 * suite and keeps it, so choosing the same suite again does not fetch anything. A failed load is not kept.
 *
 * index is the parsed site/data/suites.json list, or null. With an index, the suite's experiment code is the code
 * of its entry, and the loaded data must match that entry. Without one, nothing is checked and experiment is null.
 */
export function createSuiteLoader(loadJson, index = null) {
  const built = new Map();
  return {
    /** Return the suite for these two set names. Rejects with a plain message for a name it lacks. */
    async load(pushbackSet, questionSet) {
      if (!isPushbackSet(pushbackSet) || !isQuestionSet(questionSet)) {
        throw new Error(`The suite ${pushbackSet} with ${questionSet} is not one this site has.`);
      }
      const key = JSON.stringify([pushbackSet, questionSet]);
      if (!built.has(key)) {
        const pending = fetchSuite(loadJson, index, { pushbackSet, questionSet });
        built.set(key, pending);
        // A failed load is removed, so the next try reads the files again.
        pending.catch(() => built.delete(key));
      }
      return built.get(key);
    },
  };
}

/** Fetch the data files of one suite and build it. */
async function fetchSuite(loadJson, index, { pushbackSet, questionSet }) {
  const pushback = PUSHBACK_SETS[pushbackSet];
  const questions = QUESTION_SETS[questionSet];
  const [ladder, probeSpec, questionList] = await Promise.all([
    loadJson(pushback.ladder),
    loadJson(pushback.probeSpec),
    loadJson(questions.questions),
  ]);
  const suite = buildSuite({ pushbackSet, questionSet, ladder, probeSpec, questions: questionList });
  const entry = index === null ? null : indexEntryFor(index, suite.name);
  if (entry !== null) {
    checkAgainstEntry(suite, entry, {
      ladderPath: pushback.ladder,
      probeSpecPath: pushback.probeSpec,
      questionsPath: questions.questions,
    });
  }
  return Object.freeze({ ...suite, experiment: entry === null ? null : entry.experiment });
}

/** Return the suites index entry with this name. Throws when the index has no entry for it. */
function indexEntryFor(index, name) {
  const entry = index.find((item) => item.name === name);
  if (entry === undefined) {
    throw new Error(`The suites index has no entry named ${name}.`);
  }
  return entry;
}

/**
 * Throw when the loaded data differs from the index entry for the same suite, naming the first difference.
 * The browser cannot compute the experiment code (Python hashes its prompt settings), so the code is taken from
 * the entry, and this check makes sure the data loaded is the data that code was made from.
 */
function checkAgainstEntry(suite, entry, paths) {
  const comparisons = [
    ["ladder file", `/data/${entry.files.ladder}`, paths.ladderPath],
    ["probe spec file", `/data/${entry.files.probe_spec}`, paths.probeSpecPath],
    ["questions file", `/data/${entry.files.questions}`, paths.questionsPath],
    ["ladder", entry.ladder, suite.ladderName],
    ["question set", entry.question_set, suite.questionSet],
    ["level count", entry.level_count, suite.levelCount],
    ["held-firm score", entry.held_firm_score, suite.heldFirmScore],
  ];
  for (const [label, indexValue, loadedValue] of comparisons) {
    if (indexValue !== loadedValue) {
      throw new Error(
        `The suites index entry for ${suite.name} does not match the loaded data: `
          + `${label} is ${indexValue} in the index and ${loadedValue} loaded.`,
      );
    }
  }
}
