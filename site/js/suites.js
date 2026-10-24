// Suite choices for the two pages. A suite is one pushback set (a ladder and its probe spec) with one question set.
// The data files come from site/data, and rules.makeSuite checks them with the same rules core.py uses.
// This file does no DOM work.

import { makeSuite } from "./engine/rules.js";
import { applyQuestionOrder, assertSeed, questionOrderPath, shuffledLadderPath } from "./shuffle-choice.js";

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
 * Return the one-line description of a suite for the page. The name already carries a pushback seed. A question
 * seed is not in the name (the prompts are the same), so the line says the order is seeded, and the level count is
 * left out then, as it does not change with the question order.
 */
export function suiteSummary(suite) {
  const questionCount = `${suite.questions.length} questions`;
  const questionSeed = suite.questionSeed ?? null;
  if (questionSeed === null) {
    return `${suite.name}: ${suite.levelCount} levels, ${questionCount}`;
  }
  const levels = (suite.pushbackSeed ?? null) === null ? "" : `${suite.levelCount} levels, `;
  return `${suite.name}, questions in seed ${questionSeed} order: ${levels}${questionCount}`;
}

/** Return a choice of two fixed sets, with no seeds. The shape the pages pass to selectSuite. */
export function fixedChoice(pushbackSet, questionSet) {
  return { pushbackSet, pushbackSeed: null, questionSet, questionSeed: null };
}

/**
 * Return the choice that a suite on the desk was made from: its two sets and its two seeds (null when fixed).
 * With no suite yet, the default fixed choice.
 */
export function choiceOfSuite(suite) {
  if (suite === null) {
    return fixedChoice(DEFAULT_PUSHBACK_SET, DEFAULT_QUESTION_SET);
  }
  return {
    pushbackSet: suite.ladderName,
    pushbackSeed: suite.pushbackSeed ?? null,
    questionSet: suite.questionSet,
    questionSeed: suite.questionSeed ?? null,
  };
}

/**
 * Return the choice that a saved preset or run holds. A value saved before the seeds existed has none, which means
 * the fixed order.
 */
export function choiceFromSettings(settings) {
  return {
    pushbackSet: settings.pushbackSet,
    pushbackSeed: settings.pushbackSeed ?? null,
    questionSet: settings.questionSet,
    questionSeed: settings.questionSeed ?? null,
  };
}

/**
 * Build a suite from data that is already loaded. Throws the same messages as rules.makeSuite when the
 * data breaks a rule.
 */
export function buildSuite({ pushbackSet, questionSet, ladder, probeSpec, questions }) {
  return makeSuite({ ladderName: pushbackSet, questionSet, ladder, probeSpec, questions });
}

/**
 * Return a loader for suites. load(pushbackSet, questionSet, options) fetches the data files through loadJson,
 * builds the suite and keeps it, so choosing the same suite again does not fetch anything. A failed load is not kept.
 *
 * options.pushbackSeed and options.questionSeed are seeds from 1 to 10, or null (or missing) for the fixed order.
 * index is the parsed site/data/suites.json list, or null. With an index, the suite's experiment code is the code
 * of its entry, and the loaded data must match that entry. Without one, nothing is checked and experiment is null.
 */
export function createSuiteLoader(loadJson, index = null) {
  const built = new Map();
  return {
    /** Return the suite for these set names and seeds. Rejects with a plain message for a name or seed it lacks. */
    async load(pushbackSet, questionSet, options) {
      const pushbackSeed = options?.pushbackSeed ?? null;
      const questionSeed = options?.questionSeed ?? null;
      if (!isPushbackSet(pushbackSet) || !isQuestionSet(questionSet)) {
        throw new Error(`The suite ${pushbackSet} with ${questionSet} is not one this site has.`);
      }
      for (const seed of [pushbackSeed, questionSeed]) {
        if (seed !== null) {
          assertSeed(seed);
        }
      }
      // Both seeds are in the key, so each combination of settings is its own suite.
      const key = JSON.stringify([pushbackSet, questionSet, pushbackSeed, questionSeed]);
      if (!built.has(key)) {
        const pending = fetchSuite(loadJson, index, { pushbackSet, questionSet, pushbackSeed, questionSeed });
        built.set(key, pending);
        // A failed load is removed, so the next try reads the files again.
        pending.catch(() => built.delete(key));
      }
      return built.get(key);
    },
  };
}

/** Fetch the data files of one suite, put the questions in the seed's order if there is one, and build it. */
async function fetchSuite(loadJson, index, { pushbackSet, questionSet, pushbackSeed, questionSeed }) {
  const pushback = PUSHBACK_SETS[pushbackSet];
  const questions = QUESTION_SETS[questionSet];
  // Only the ladder is shuffled. The probe spec and the questions are the same files as the default suite.
  const ladderPath = pushbackSeed === null ? pushback.ladder : shuffledLadderPath(pushbackSet, pushbackSeed);
  const reads = [loadJson(ladderPath), loadJson(pushback.probeSpec), loadJson(questions.questions)];
  if (questionSeed !== null) {
    reads.push(loadJson(questionOrderPath(questionSeed)));
  }
  const [ladder, probeSpec, questionList, orderFile] = await Promise.all(reads);
  let orderedQuestions = questionList;
  if (questionSeed !== null) {
    const order = orderFile[questionSet];
    if (!Array.isArray(order)) {
      throw new Error(`The question order file has no list for ${questionSet}.`);
    }
    orderedQuestions = applyQuestionOrder(questionList, order);
  }
  const base = buildSuite({ pushbackSet, questionSet, ladder, probeSpec, questions: orderedQuestions });
  // A shuffled ladder gets its own name, as it does in Python, so its results never replace the default's.
  // A question order keeps the default name, because it does not change the experiment.
  const name = pushbackSeed === null ? base.name : `${pushbackSet}+${questionSet}+pushback${pushbackSeed}`;
  const suite = { ...base, name, pushbackSeed, questionSeed };
  const entry = index === null ? null : indexEntryFor(index, name);
  if (entry !== null) {
    checkAgainstEntry(suite, entry, {
      ladderPath,
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
    ["pushback seed", entry.pushback_seed ?? null, suite.pushbackSeed],
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
