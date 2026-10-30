// Seeded synthetic data for the chart benchmark. The team's real results are not in this checkout, so every case is
// built here from a fixed seed. The same seed always gives the same numbers, so Vega and ECharts draw identical data
// on every run and on every machine, and the timings are comparable. The numbers say nothing about real data sizes
// beyond the shape: a 1,000 by 100 grid is the shape the owner's plan names, not a measured result.
// Each builder returns plain objects in the shape the shipped row builders read (frontend/js/compare/vega-rows.js).

// The sizes of the five benchmark cases, as the owner's plan names them.
export const SCATTER_POINTS = 100000;
export const HEATMAP_MODELS = 1000;
export const HEATMAP_QUESTIONS = 100;
export const FACET_COUNT = 6;
export const FACET_POINTS = 20000;
export const DIFFERENCE_MODELS = 50;
// The one seed the runner uses. Changing it changes every number, so it is written down in the report.
export const BENCH_SEED = 20261030;

// The three conditions the page compares, in the order the page shows them.
const CONDITIONS = Object.freeze(["none", "mitigation", "control"]);
// Five providers, so that a difference view with fifty models has a provider dimension that really varies.
const PROVIDERS = Object.freeze(["alpha", "beta", "gamma", "delta", "epsilon"]);

/**
 * A small seeded random number generator (mulberry32). It gives the same sequence of numbers from the same seed, and
 * each number is from 0 up to, but not including, 1. Why not Math.random: it cannot be seeded, so runs would differ.
 */
export function makeRandom(seed) {
  let state = seed >>> 0;
  return function nextNumber() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The scatter case: count points with x and y uniform in 0 to 1. Uniform points are the simplest honest shape, and
 * they fill the plot evenly, so the cost of drawing is not hidden by empty space.
 */
export function scatterPoints(count, seed) {
  const random = makeRandom(seed);
  const points = [];
  for (let index = 0; index < count; index += 1) {
    points.push({ x: random(), y: random() });
  }
  return points;
}

/**
 * One flip-rate block, the shape of a Rate in the compare data: a rate from 0 to 1, a 95% interval around it, and a
 * sample size. The interval is kept inside 0 to 1 and always holds the rate, as a real interval does.
 */
function makeRate(random) {
  const rate = random();
  const halfWidth = 0.05 + random() * 0.1;
  return {
    rate,
    ci_low: Math.max(0, rate - halfWidth),
    ci_high: Math.min(1, rate + halfWidth),
    n: 50 + Math.floor(random() * 200),
  };
}

/**
 * One model in the compare shape: an id, a name, a provider, a flip rate under each condition, and optionally one
 * flip rate per question. The provider rotates with the index, so the models spread across all the providers.
 */
function makeModel(index, questionCount, random) {
  const id = `model-${String(index).padStart(4, "0")}`;
  const mitigation = {};
  for (const condition of CONDITIONS) {
    mitigation[condition] = { flip_rate_last: makeRate(random) };
  }
  const questionFlipRates = [];
  for (let question = 0; question < questionCount; question += 1) {
    questionFlipRates.push({
      question_id: `q${String(question).padStart(3, "0")}`,
      flip_rate_last: makeRate(random),
    });
  }
  return {
    id,
    display_name: `Model ${index}`,
    provider: PROVIDERS[index % PROVIDERS.length],
    family: `family-${index % 7}`,
    mitigation,
    question_flip_rates: questionFlipRates,
  };
}

/**
 * The compare data for a number of models and questions. Used by the heatmap case (many questions) and by the
 * difference case (no questions, because the difference views only read the condition rates).
 */
function comparisonData(modelCount, questionCount, seed) {
  const random = makeRandom(seed);
  const models = [];
  for (let index = 0; index < modelCount; index += 1) {
    models.push(makeModel(index, questionCount, random));
  }
  return { suite: "bench-synthetic", conditions: [...CONDITIONS], models };
}

/** The heatmap case: modelCount models, each with questionCount question rates, so modelCount times questionCount cells. */
export function heatmapData(modelCount, questionCount, seed) {
  return comparisonData(modelCount, questionCount, seed);
}

/** The difference case: modelCount models with condition rates only, for the "differences only" rule to read. */
export function differenceData(modelCount, seed) {
  return comparisonData(modelCount, 0, seed);
}

/**
 * The faceted case: facetCount facets, each with perFacet points. Every row names its facet, so the same rows can be
 * split into panels by the spec. The x and y values come from one stream, so the facets differ from one another.
 */
export function facetPoints(facetCount, perFacet, seed) {
  const random = makeRandom(seed);
  const rows = [];
  for (let facet = 1; facet <= facetCount; facet += 1) {
    for (let index = 0; index < perFacet; index += 1) {
      rows.push({ facet: `facet-${facet}`, x: random(), y: random() });
    }
  }
  return rows;
}
