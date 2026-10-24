// The pure helpers behind the "Shuffled" choice on the Batch and Gauntlet pages: the seed text, the option
// label, and the data file for each seed. The browser never shuffles. Python writes the orders into
// site/data/shuffles, so the browser results match the Python run exactly.
// This file does no DOM work.

export const SEED_MIN = 1;
export const SEED_MAX = 10;

// Digits only, so "3.5", "-2" and "1e1" are refused before the text is read as a number.
const WHOLE_NUMBER_PATTERN = /^\d+$/;
// The shuffled ladder file name for each pushback set that has one. The file names follow site/data/shuffles.
const SHUFFLED_LADDER_PREFIX = Object.freeze({ gauntlet_v3: "ladder_v3", gauntlet_v4: "ladder_v4" });

/** Return true when the value is a whole number from SEED_MIN to SEED_MAX. */
export function isSeed(value) {
  return Number.isInteger(value) && value >= SEED_MIN && value <= SEED_MAX;
}

/**
 * Return true for a seed the site offers, or for no seed (undefined or null), which is the fixed order. A saved run
 * from before the seeds existed has no seed field, so it reads as fixed.
 */
export function isSeedOrFixed(value) {
  return value === undefined || value === null || isSeed(value);
}

/** Throw unless the value is a seed the site offers. The site never reads any other seed. */
export function assertSeed(value) {
  if (!isSeed(value)) {
    throw new Error(`The seed ${value} is not one this site has. Seeds run from ${SEED_MIN} to ${SEED_MAX}.`);
  }
}

/**
 * Read the seed typed into the seed box. Surrounding spaces are allowed. Returns { ok: true, seed } for a whole
 * number from 1 to 10, or { ok: false, message } with a sentence the page can show next to the box.
 */
export function parseSeed(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (WHOLE_NUMBER_PATTERN.test(trimmed)) {
    const seed = Number(trimmed);
    if (isSeed(seed)) {
      return { ok: true, seed };
    }
  }
  return { ok: false, message: `Enter a whole number from ${SEED_MIN} to ${SEED_MAX}.` };
}

/** Return the text of the "Shuffled" option for a seed, such as "Shuffled, seed 3". */
export function shuffleOptionLabel(seed) {
  assertSeed(seed);
  return `Shuffled, seed ${seed}`;
}

/**
 * Return the path of the shuffled ladder for a pushback set and seed, such as
 * "/data/shuffles/ladder_v4_pushback7.json". Throws for a pushback set with no shuffled ladder.
 */
export function shuffledLadderPath(pushbackSet, seed) {
  assertSeed(seed);
  if (!Object.hasOwn(SHUFFLED_LADDER_PREFIX, pushbackSet)) {
    throw new Error(`There is no shuffled ladder for ${pushbackSet}.`);
  }
  return `/data/shuffles/${SHUFFLED_LADDER_PREFIX[pushbackSet]}_pushback${seed}.json`;
}

/** Return the path of the question order file for a seed, such as "/data/shuffles/question_order_3.json". */
export function questionOrderPath(seed) {
  assertSeed(seed);
  return `/data/shuffles/question_order_${seed}.json`;
}

// The value and label of the Shuffled entry at the end of both dropdowns. No set name can equal the value.
export const SHUFFLED_CHOICE = "shuffled";
const SHUFFLED_LABEL = "Shuffled";

/** Return the dropdown entries for a list of set names, then the Shuffled entry last. */
export function dropdownChoices(names) {
  const sets = names.map((name) => ({ value: name, label: name }));
  return [...sets, { value: SHUFFLED_CHOICE, label: SHUFFLED_LABEL }];
}

/**
 * Return the value that shows a suite choice in its dropdown: the set name when the order is fixed, or Shuffled
 * when a seed is in use. The set name is then kept by the page, not shown, because the dropdown has one value.
 */
export function dropdownValueFor(set, seed) {
  return seed === null ? set : SHUFFLED_CHOICE;
}

/**
 * Read one dropdown and its seed box. A set name is a fixed choice, so the seed box is ignored. Shuffled uses the set
 * the desk has loaded, with the seed in the box. Returns { ok: true, set, seed } with seed null for a fixed choice,
 * or { ok: false, message } with the parseSeed sentence when the seed box is not a seed.
 */
export function readSetChoice({ value, loadedSet, seedText }) {
  if (value !== SHUFFLED_CHOICE) {
    return { ok: true, set: value, seed: null };
  }
  const parsed = parseSeed(seedText);
  if (!parsed.ok) {
    return parsed;
  }
  return { ok: true, set: loadedSet, seed: parsed.seed };
}

/**
 * Read both dropdowns into one suite choice: { ok: true, pushbackSet, pushbackSeed, questionSet, questionSeed }.
 * `loaded` names the sets on the desk, since a Shuffled entry shuffles the set already loaded for it. The first bad
 * seed is returned as { ok: false, message }, and the other dropdown is not read after it.
 */
export function readSuiteChoice({ pushback, question, loaded }) {
  const pushbackChoice = readSetChoice({
    value: pushback.value, loadedSet: loaded.pushbackSet, seedText: pushback.seedText,
  });
  if (!pushbackChoice.ok) {
    return pushbackChoice;
  }
  const questionChoice = readSetChoice({
    value: question.value, loadedSet: loaded.questionSet, seedText: question.seedText,
  });
  if (!questionChoice.ok) {
    return questionChoice;
  }
  return {
    ok: true,
    pushbackSet: pushbackChoice.set,
    pushbackSeed: pushbackChoice.seed,
    questionSet: questionChoice.set,
    questionSeed: questionChoice.seed,
  };
}

/**
 * Return a new list of the same question objects, in the order given by a list of question ids.
 * The order must name every question exactly once: the lengths must match, and no id may be missing or repeated.
 * Throws otherwise, because a partial order would silently drop or repeat a question in a run.
 */
export function applyQuestionOrder(questions, order) {
  if (order.length !== questions.length) {
    throw new Error(`The question order has ${order.length} ids but there are ${questions.length} questions.`);
  }
  const byId = new Map(questions.map((question) => [question.id, question]));
  const seen = new Set();
  return order.map((id) => {
    if (!byId.has(id)) {
      throw new Error(`The question order names ${id}, which is not in the question set.`);
    }
    if (seen.has(id)) {
      throw new Error(`The question order lists ${id} twice.`);
    }
    seen.add(id);
    return byId.get(id);
  });
}
