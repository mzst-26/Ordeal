// The mixed order: easy and hard questions asked in one seeded order, each with its own pushback set.
// This is the browser side of ordeal/mix.py. Python shuffles with its own random generator, which JavaScript cannot
// repeat, so Python writes one file per seed (frontend/data/mixed/mixed_<seed>.json) and this file reads those files.
// Nothing here reads or writes a file, sends a request or touches the page. It only checks and counts the orders.

// The seeds the site offers. A run picks one of them at random when it starts.
export const MIXED_SEED_MIN = 1;
export const MIXED_SEED_MAX = 10;
// The name of a mixed run. It is the name the Python side uses, so the two records can be told apart by name.
export const MIXED_NAME = "mixed";
// The pushback set that goes with each question set. It is fixed, so a question never changes its pushbacks in a run.
export const PUSHBACK_FOR_SET = Object.freeze({ easy: "gauntlet_v3", hard: "gauntlet_v4" });

/**
 * Pick a seed from 1 to 10. The random number comes from the caller, so a test can pass a fixed one.
 * Math.floor turns a number from 0 up to (not including) 1 into a whole number from 0 to 9, then 1 is added.
 */
export function pickMixedSeed(random = Math.random) {
  return Math.floor(random() * MIXED_SEED_MAX) + MIXED_SEED_MIN;
}

/** Return the path of the order file for a seed. Throws when the seed is not a whole number from 1 to 10. */
export function mixedOrderPath(seed) {
  if (!Number.isInteger(seed) || seed < MIXED_SEED_MIN || seed > MIXED_SEED_MAX) {
    throw new Error(`The mixed seed must be a whole number from ${MIXED_SEED_MIN} to ${MIXED_SEED_MAX}. Got ${seed}.`);
  }
  return `/data/mixed/mixed_${seed}.json`;
}

/**
 * Return one slot per question, in the order the rows give. Each slot holds the question, its set, its pushback set
 * and its position. The rows come from an order file or from a saved run.
 * Throws unless the rows name every question of both lists exactly once, with the right set and pushback set.
 * Checking this first means a stale or damaged file is refused, instead of running a different question list.
 */
export function applyMixedOrder(rows, easyQuestions, hardQuestions) {
  const byId = new Map();
  for (const question of easyQuestions) {
    byId.set(question.id, { question, questionSet: "easy" });
  }
  for (const question of hardQuestions) {
    byId.set(question.id, { question, questionSet: "hard" });
  }
  const seen = new Set();
  const slots = rows.map((row) => {
    const found = byId.get(row.id);
    if (found === undefined) {
      throw new Error(`The mixed order names ${row.id}, which is not one of the questions. The order does not match.`);
    }
    if (seen.has(row.id)) {
      throw new Error(`The mixed order names ${row.id} more than once. The order does not match.`);
    }
    seen.add(row.id);
    checkRowSets(row, found.questionSet);
    return {
      question: found.question,
      questionSet: found.questionSet,
      pushbackSet: PUSHBACK_FOR_SET[found.questionSet],
      position: row.position,
    };
  });
  if (slots.length !== byId.size) {
    throw new Error(`The mixed order has ${slots.length} questions, but there are ${byId.size}. The order does not match.`);
  }
  return slots;
}

/** Throw when a row says a question is in the wrong set or uses the wrong pushback set. */
function checkRowSets(row, questionSet) {
  if (row.question_set !== questionSet) {
    throw new Error(`The mixed order puts ${row.id} in the ${row.question_set} set, but it is a ${questionSet} question.`);
  }
  if (row.pushback_set !== PUSHBACK_FOR_SET[questionSet]) {
    throw new Error(`The mixed order gives ${row.id} the pushback set ${row.pushback_set}, but it must use ${PUSHBACK_FOR_SET[questionSet]}.`);
  }
}

/** Return the slots whose question id is in the set of ids, in their order. The counts then follow the ticks. */
export function selectSlots(slots, ids) {
  return slots.filter((slot) => ids.has(slot.question.id));
}

/**
 * Return the counts of a list of slots: how many easy and hard questions it has, and each set's share as a percent
 * to one decimal. The hard percent is 100 minus the easy one, so the two always add up to exactly 100.
 * Throws for an empty list, because a share of nothing has no meaning and would divide by zero.
 */
export function mixCounts(slots) {
  const total = slots.length;
  if (total === 0) {
    throw new Error("A mixed run needs at least one question, but none is ticked.");
  }
  const easyCount = slots.filter((slot) => slot.questionSet === "easy").length;
  const hardCount = total - easyCount;
  const easyPercent = roundToTenth((100 * easyCount) / total);
  return {
    total,
    easy: { count: easyCount, percent: easyPercent },
    hard: { count: hardCount, percent: roundToTenth(100 - easyPercent) },
  };
}

/** Round to one decimal place, as the Python side does for the same percents. */
function roundToTenth(value) {
  return Math.round(value * 10) / 10;
}

/** Return the plan wording for counts, such as "32 easy with gauntlet_v3, 59 hard with gauntlet_v4". */
export function countsSentence(counts) {
  return `${counts.easy.count} easy with ${PUSHBACK_FOR_SET.easy}, ${counts.hard.count} hard with ${PUSHBACK_FOR_SET.hard}`;
}

/**
 * Return the plain rows of slots: position, id, question set and pushback set, with no question text.
 * A saved run keeps these rows, so a resume can rebuild the same order from them.
 */
export function orderRows(slots) {
  return slots.map((slot) => ({
    position: slot.position,
    id: slot.question.id,
    question_set: slot.questionSet,
    pushback_set: slot.pushbackSet,
  }));
}

/**
 * Return the two-set question pool of a mixed run, as one suite: every question of both sets, the pushback pair
 * of each, and no single ladder. The batch page uses it like a suite, and pairFor gives the engine each question's pair.
 */
export function buildMixedSuite(easySuite, hardSuite) {
  return {
    name: MIXED_NAME,
    ladderName: MIXED_NAME,
    questionSet: MIXED_NAME,
    mixed: true,
    // The two lists are kept apart, because applyMixedOrder checks the order against each list on its own.
    easyQuestions: easySuite.questions,
    hardQuestions: hardSuite.questions,
    questions: [...easySuite.questions, ...hardSuite.questions],
    // Only the mixed suite has no single ladder, so the page must ask pairFor for each question's ladder.
    ladder: null,
    probeSpec: null,
    levelCount: null,
    pairFor: pairLookup(easySuite, hardSuite),
    questionSetOf: setLookup(easySuite, hardSuite),
  };
}

/** Return a function that gives a question id its set name, "easy" or "hard". Ids are unique across both sets. */
export function setLookup(easySuite, hardSuite) {
  const easyIds = new Set(easySuite.questions.map((question) => question.id));
  return (questionId) => (easyIds.has(questionId) ? "easy" : "hard");
}

/**
 * Return a function that gives a question its { ladder, probeSpec }: the pair of the set the question belongs to.
 * A question id that is in neither set throws, because the run would not know which ladder to use for it.
 */
export function pairLookup(easySuite, hardSuite) {
  const suiteById = new Map();
  for (const question of easySuite.questions) {
    suiteById.set(question.id, easySuite);
  }
  for (const question of hardSuite.questions) {
    suiteById.set(question.id, hardSuite);
  }
  return (question) => {
    const suite = suiteById.get(question.id);
    if (suite === undefined) {
      throw new Error(`The question ${question.id} is in neither set, so its pushback set is not known.`);
    }
    return { ladder: suite.ladder, probeSpec: suite.probeSpec };
  };
}
