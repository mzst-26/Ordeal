// Counts the calls a run would still need, for the browser batch page. This is the browser port of the
// dry-run planner in runner.py (plan_model_calls, confession_can_follow and make_units).
// Nothing here calls the network or changes the cache. families is a Set or the ALL_FAMILIES array of names.
import { expectedSteps } from "./flows.js";
import { BASELINE_STEP, CONFESSION_STEP, LEVEL_COUNT, parseAnswer, pushbackSteps } from "./rules.js";

/** Return the cache key of one saved reply. The five parts go in a JSON array, so no separator can clash. */
export function cacheKey(condition, model, questionId, repeat, step) {
  return JSON.stringify([condition, model, questionId, repeat, step]);
}

/** Return a Map from cache key to saved record. A later record with the same key replaces an earlier one. */
export function buildCacheIndex(records) {
  const index = new Map();
  for (const record of records) {
    const key = cacheKey(record.condition, record.model, record.question_id, record.repeat, record.step);
    index.set(key, record);
  }
  return index;
}

/** Return every model, question and repeat combination, in that order. Repeats are numbered from 1. */
export function makeUnits(models, questions, repeats) {
  const units = [];
  for (const model of models) {
    for (const question of questions) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        units.push({ model, question, repeat });
      }
    }
  }
  return units;
}

/** Return the cache key of one step of one unit. */
function stepKey(condition, unit, step) {
  return cacheKey(condition, unit.model, unit.question.id, unit.repeat, step);
}

/** Return true or false for whether the saved first answer is right, or null if it is not saved yet. */
function savedBaselineCorrect(cacheIndex, condition, unit) {
  const saved = cacheIndex.get(stepKey(condition, unit, BASELINE_STEP));
  if (saved === undefined) {
    return null;
  }
  return parseAnswer(saved.reply) === unit.question.correct;
}

/**
 * Return false when every pressure level is saved and none gave a wrong letter, so no confession is sent.
 * Otherwise return true. This matches confession_can_follow in runner.py, which does not look at the families.
 * levelCount is the number of pressure levels in the ladder (10 for gauntlet_v3).
 */
export function confessionCanFollow(unit, cacheIndex, condition, levelCount = LEVEL_COUNT) {
  let anyWrongLetter = false;
  for (const step of pushbackSteps(levelCount)) {
    const saved = cacheIndex.get(stepKey(condition, unit, step));
    if (saved === undefined) {
      return true;
    }
    const letter = parseAnswer(saved.reply);
    if (letter !== null && letter !== unit.question.correct) {
      anyWrongLetter = true;
    }
  }
  return anyWrongLetter;
}

/**
 * Count the calls a run would still need for one model. Nothing is called and nothing is saved.
 * settings holds { cacheIndex, condition, families, ladder, probeSpec }.
 * Returns { saved, atMostNew }. Until a unit's first answer is saved, the new count is an upper bound.
 */
export function planModelCalls(model, questions, repeats, settings) {
  const { cacheIndex, condition, families, ladder, probeSpec } = settings;
  const plan = { saved: 0, atMostNew: 0 };
  for (const unit of makeUnits([model], questions, repeats)) {
    const baselineCorrect = savedBaselineCorrect(cacheIndex, condition, unit);
    let steps = expectedSteps(unit.question, families, ladder, probeSpec, baselineCorrect);
    if (!confessionCanFollow(unit, cacheIndex, condition, ladder.levels.length)) {
      steps = steps.filter((step) => step !== CONFESSION_STEP);
    }
    for (const step of steps) {
      if (cacheIndex.has(stepKey(condition, unit, step))) {
        plan.saved += 1;
      } else {
        plan.atMostNew += 1;
      }
    }
  }
  return plan;
}

/**
 * Count the calls for every model. Returns { models, totals }: models is one { model, saved, atMostNew }
 * per model in the order given, and totals is the sum of those counts.
 * The config argument is passed by both pages but is not used by the count, as in runner.py.
 */
export function planAllModels(
  models, questions, repeats, cacheIndex, condition, families, ladder, probeSpec, config,
) {
  const rows = [];
  const totals = { saved: 0, atMostNew: 0 };
  const settings = { cacheIndex, condition, families, ladder, probeSpec };
  for (const model of models) {
    const plan = planModelCalls(model, questions, repeats, settings);
    rows.push({ model, saved: plan.saved, atMostNew: plan.atMostNew });
    totals.saved += plan.saved;
    totals.atMostNew += plan.atMostNew;
  }
  return { models: rows, totals };
}
