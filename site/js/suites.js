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

// The one suite choice that each page offers. A visitor picks exactly one of these three. A fixed choice names one
// pushback set and one question set. Shuffle names no fixed sets: it is the mixed order from mixed-order.js, which
// asks both question sets in one order, each with its own pushback set. The value of a fixed choice is its suite name.
export const SHUFFLE_CHOICE = "shuffle";
export const DEFAULT_CHOICE = "gauntlet_v3+easy";
const SUITE_CHOICES = Object.freeze([
  Object.freeze({
    value: "gauntlet_v4+hard", label: "Gauntlet v4 – hard questions", pushbackSet: "gauntlet_v4", questionSet: "hard",
  }),
  Object.freeze({
    value: DEFAULT_CHOICE, label: "Gauntlet v3 – easy questions", pushbackSet: "gauntlet_v3", questionSet: "easy",
  }),
  Object.freeze({ value: SHUFFLE_CHOICE, label: "Shuffle", pushbackSet: null, questionSet: null }),
]);

/** Return true when the name is a pushback set this site knows. */
export function isPushbackSet(name) {
  return Object.hasOwn(PUSHBACK_SETS, name);
}

/** Return true when the name is a question set this site knows. */
export function isQuestionSet(name) {
  return Object.hasOwn(QUESTION_SETS, name);
}

/** Return true for the suite whose saved replies exist in the site data. */
export function isSavedSuite(suite) {
  return suite.name === SAVED_SUITE_NAME;
}

/**
 * Return the one-line description of a suite for the page, such as "Gauntlet v3 – easy questions: 10 levels, 32 questions".
 * The label comes from the choice the suite belongs to. A suite with no choice (none is offered now) shows its name.
 */
export function suiteSummary(suite) {
  const choice = findChoice(choiceValueOfSets(suite.ladderName, suite.questionSet));
  const label = choice === null ? suite.name : choice.label;
  return `${label}: ${suite.levelCount} levels, ${suite.questions.length} questions`;
}

/** Return the menu entries of the suite choice, one per option, in the order the page lists them. */
export function suiteChoiceMenu() {
  return menuOf(SUITE_CHOICES);
}

/** Return the { value, label } entries of a list of choices. Both menus share this, so their labels always match. */
function menuOf(choices) {
  return choices.map((choice) => ({ value: choice.value, label: choice.label }));
}

/** Return the option with this value, or null when the site does not offer it. */
function findChoice(value) {
  return SUITE_CHOICES.find((choice) => choice.value === value) ?? null;
}

/**
 * Return the { pushbackSet, questionSet } that a fixed choice stands for. Throws for Shuffle, which has no fixed sets,
 * and for any value the site does not offer. The pages call this only with a value from the menu.
 */
export function setsOfChoice(value) {
  const choice = findChoice(value);
  if (choice === null || choice.pushbackSet === null) {
    throw new Error(`The suite ${value} is not one this site offers.`);
  }
  return fixedChoice(choice.pushbackSet, choice.questionSet);
}

/**
 * Return the choice value for a pair of sets, or null when the site no longer offers that pair. The pairings
 * gauntlet_v3 with hard and gauntlet_v4 with easy are not offered, so they give null.
 */
export function choiceValueOfSets(pushbackSet, questionSet) {
  const choice = SUITE_CHOICES.find((item) => item.pushbackSet === pushbackSet && item.questionSet === questionSet);
  return choice === undefined ? null : choice.value;
}

/**
 * Return the choice value that a suite on the page stands for: Shuffle for a mixed suite, otherwise the value of
 * its pair. A fixed pair that is not offered gives null.
 */
export function choiceValueOfSuite(suite) {
  if (suite.mixed === true) {
    return SHUFFLE_CHOICE;
  }
  return choiceValueOfSets(suite.ladderName, suite.questionSet);
}

/**
 * Return a plain line for a pair of sets the site no longer offers, such as "gauntlet_v3 with hard questions is no
 * longer offered on this site." Returns "" for an offered pair. Saved runs and presets that hold a retired pair are
 * refused with this line, rather than being guessed into another pair.
 */
export function retiredPairText(pushbackSet, questionSet) {
  if (choiceValueOfSets(pushbackSet, questionSet) !== null) {
    return "";
  }
  return `${pushbackSet} with ${questionSet} questions is no longer offered on this site.`;
}

/** Return a choice of two sets: the shape the pages pass to selectSuite. */
export function fixedChoice(pushbackSet, questionSet) {
  return { pushbackSet, questionSet };
}

/**
 * Return the fixed choice for a question set: the pushback set that the site offers with it, such as hard questions
 * with gauntlet_v4. The Live page uses this when a Shuffle pick is a question of this set, so the page moves to the
 * suite that the question belongs to. Throws for a set the site does not offer with any pushback set.
 */
export function choiceOfQuestionSet(questionSet) {
  const choice = SUITE_CHOICES.find((item) => item.pushbackSet !== null && item.questionSet === questionSet);
  if (choice === undefined) {
    throw new Error(`The question set ${questionSet} is not one this site offers.`);
  }
  return fixedChoice(choice.pushbackSet, choice.questionSet);
}

/**
 * Return the questions a Live run takes from one suite. With no pick, or a pick that the suite does not hold, the run
 * takes the first questions of the set. A pick starts the run at that question and takes the ones after it in the
 * same set, so the run never goes on into the other set. A run near the end of the set is shorter.
 */
export function questionsFromPick(questions, pickedId, count) {
  const start = questions.findIndex((question) => question.id === pickedId);
  const first = start < 0 ? 0 : start;
  return questions.slice(first, first + count);
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
