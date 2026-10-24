// Pure helpers for the comparison page. No DOM access, so the node tests can run them.
// A Rate is {rate, ci_low, ci_high, n}. A null Rate, or a null rate.rate, means "not run": never zero.

/** The family colours in first-seen order (PLAN_COMPARE D10). Each is a token, so both themes follow. */
export const FAMILY_PALETTE = Object.freeze([
  "var(--cat-1)", "var(--cat-2)", "var(--cat-3)", "var(--teal)",
  "var(--sage)", "var(--terracotta)", "var(--plum)", "var(--ochre)",
]);

const NOT_RUN = "not run";
const UNKNOWN_COLOUR = "var(--ink-mute)";
const DEFAULT_PCT_DIGITS = 0;

/** True when a finite number is present. */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** True when a Rate is missing, or its rate is null: the value was not run. */
export function isNotRun(rate) {
  return rate === null || rate === undefined || !isFiniteNumber(rate.rate);
}

/** A fraction as a percentage string, such as "62%". A missing value reads "not run". */
export function pct(value, digits = DEFAULT_PCT_DIGITS) {
  if (!isFiniteNumber(value)) {
    return NOT_RUN;
  }
  return `${(value * 100).toFixed(digits)}%`;
}

/** A plain number to a fixed number of digits, such as a mean Spine Score. A missing value reads "not run". */
export function numberText(value, digits = 1) {
  if (!isFiniteNumber(value)) {
    return NOT_RUN;
  }
  return value.toFixed(digits);
}

/**
 * A rate with its interval and unit count, such as "62% (95% CI 55–67%, n=56)".
 * Missing interval parts or a missing n are left out of the text. A null rate reads "not run".
 */
export function rateText(rate) {
  if (isNotRun(rate)) {
    return NOT_RUN;
  }
  const main = pct(rate.rate);
  const parts = [];
  if (isFiniteNumber(rate.ci_low) && isFiniteNumber(rate.ci_high)) {
    parts.push(`95% CI ${pct(rate.ci_low).replace("%", "")}–${pct(rate.ci_high)}`);
  }
  if (isFiniteNumber(rate.n)) {
    parts.push(`n=${rate.n}`);
  }
  return parts.length > 0 ? `${main} (${parts.join(", ")})` : main;
}

/** The smallest and largest params_b among the models. With no sizes at all, both are 0. */
export function sizeBounds(models) {
  const sizes = (models || []).map((model) => model.params_b).filter(isFiniteNumber);
  if (sizes.length === 0) {
    return { min: 0, max: 0 };
  }
  return { min: Math.min(...sizes), max: Math.max(...sizes) };
}

/**
 * The unique families in first-seen order. A model with no family gives a null entry, placed last.
 * The null entry is shown with the label "Unknown" (see familyLabel).
 */
export function familyOrder(models) {
  const order = [];
  let hasUnknown = false;
  for (const model of models || []) {
    const family = model.family;
    if (family === null || family === undefined || family === "") {
      hasUnknown = true;
      continue;
    }
    if (!order.includes(family)) {
      order.push(family);
    }
  }
  if (hasUnknown) {
    order.push(null);
  }
  return order;
}

/** The label for a family entry, with the null family shown as "Unknown". */
export function familyLabel(family) {
  return family === null || family === undefined || family === "" ? "Unknown" : String(family);
}

/**
 * The colour for a family: a palette token by its position in familyOrder. A model with no family,
 * or a family not in the order, gets the muted ink token.
 */
export function familyColour(family, order) {
  if (family === null || family === undefined || family === "") {
    return UNKNOWN_COLOUR;
  }
  const index = (order || []).indexOf(family);
  if (index < 0) {
    return UNKNOWN_COLOUR;
  }
  return FAMILY_PALETTE[index % FAMILY_PALETTE.length];
}

/**
 * The filters that start the page: every family selected, the full size range, any reasoning and
 * weights, low-sample models hidden, and an empty search.
 */
export function defaultFilters(models) {
  const bounds = sizeBounds(models);
  return {
    families: new Set(familyOrder(models)),
    sizeMin: bounds.min,
    sizeMax: bounds.max,
    reasoning: "any",
    open: "any",
    lowSampleHidden: true,
    search: "",
  };
}

/** True when a three-way filter ("any", "yes", "no") accepts a value that may be null. */
function passesTriState(choice, value) {
  if (choice === "any") {
    return true;
  }
  if (value === null || value === undefined) {
    return false;
  }
  return choice === "yes" ? value === true : value === false;
}

/**
 * The models that pass every filter, in their original order.
 * A null params_b passes the size filter only when the size range is at its full range, meaning the
 * slider covers the smallest and the largest size in `models`. A null reasoning or open_weights passes
 * only when that filter is "any".
 */
export function visibleModels(models, filters) {
  const bounds = sizeBounds(models);
  const fullSize = filters.sizeMin <= bounds.min && filters.sizeMax >= bounds.max;
  const query = (filters.search || "").trim().toLowerCase();
  return (models || []).filter((model) => {
    const family = model.family ? model.family : null;
    if (!filters.families.has(family)) {
      return false;
    }
    if (isFiniteNumber(model.params_b)) {
      if (model.params_b < filters.sizeMin || model.params_b > filters.sizeMax) {
        return false;
      }
    } else if (!fullSize) {
      return false;
    }
    if (!passesTriState(filters.reasoning, model.reasoning)) {
      return false;
    }
    if (!passesTriState(filters.open, model.open_weights)) {
      return false;
    }
    if (filters.lowSampleHidden && model.gates && model.gates.low_sample === true) {
      return false;
    }
    if (query) {
      const haystack = `${model.display_name || ""} ${model.id || ""}`.toLowerCase();
      if (!haystack.includes(query)) {
        return false;
      }
    }
    return true;
  });
}

/** The interval of a model's backbone index. A missing bound falls back to the rate itself. */
function backboneInterval(model) {
  const index = model.backbone_index;
  const low = isFiniteNumber(index.ci_low) ? index.ci_low : index.rate;
  const high = isFiniteNumber(index.ci_high) ? index.ci_high : index.rate;
  return { low, high, rate: index.rate };
}

/**
 * Rank bands from the backbone index intervals. Models whose intervals overlap, directly or through a
 * chain of overlaps, share a band. Bands are numbered from 1, the band with the highest backbone index
 * first. A model with no backbone index maps to null.
 * Returns a Map from model id to band number.
 */
export function rankBands(models) {
  const list = models || [];
  const result = new Map();
  const ranked = list.filter((model) => model.backbone_index && !isNotRun(model.backbone_index));
  for (const model of list) {
    if (!ranked.includes(model)) {
      result.set(model.id, null);
    }
  }

  const parent = ranked.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root];
    }
    parent[index] = root;
    return root;
  };
  const intervals = ranked.map(backboneInterval);
  for (let i = 0; i < ranked.length; i += 1) {
    for (let j = i + 1; j < ranked.length; j += 1) {
      const a = intervals[i];
      const b = intervals[j];
      if (a.low <= b.high && b.low <= a.high) {
        parent[find(i)] = find(j);
      }
    }
  }

  const groups = new Map();
  ranked.forEach((model, index) => {
    const root = find(index);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root).push(index);
  });

  const ordered = [...groups.values()].map((members) => ({
    members,
    top: Math.max(...members.map((index) => intervals[index].rate)),
    first: Math.min(...members),
  }));
  ordered.sort((a, b) => (b.top - a.top) || (a.first - b.first));
  ordered.forEach((group, position) => {
    for (const index of group.members) {
      result.set(ranked[index].id, position + 1);
    }
  });
  return result;
}

/** The last level of a model's flip curve, or null when there is no curve. */
function lastLevel(model) {
  const curve = model.flip_curve;
  if (!Array.isArray(curve) || curve.length === 0) {
    return null;
  }
  return curve[curve.length - 1].level;
}

/**
 * One plain sentence about the run. The count comes from allModels, so a filter never changes it.
 * The held-longest model is picked from visibleModels (the filtered list), which defaults to allModels.
 * The model that held longest is the one with the lowest flip rate at the last level.
 */
export function takeaway(allModels, visibleModels) {
  const all = allModels || [];
  const shown = visibleModels === undefined ? all : visibleModels || [];
  if (all.length === 0) {
    return "No models to compare yet.";
  }
  const noun = all.length === 1 ? "1 model was compared" : `${all.length} models were compared`;
  if (shown.length === 0) {
    return `On this run, ${noun}; none match the current filters.`;
  }
  const scored = shown.filter((model) => !isNotRun(model.flip_rate_last));
  if (scored.length === 0) {
    return `On this run, ${noun}; flip rates are not run yet.`;
  }
  let best = scored[0];
  for (const model of scored) {
    if (model.flip_rate_last.rate < best.flip_rate_last.rate) {
      best = model;
    }
  }
  const level = lastLevel(best);
  const levelText = level === null ? "the last level" : `Level ${level}`;
  const name = best.display_name || best.id;
  const flipped = pct(best.flip_rate_last.rate);
  if (all.length === 1) {
    return `On this run, ${noun}: ${name} reached ${levelText} with ${flipped} flipped.`;
  }
  const scope = shown.length === all.length ? "" : `of the ${shown.length} shown, `;
  return `On this run, ${noun}; ${scope}the one that held longest, ${name}, reached ${levelText} with ${flipped} flipped.`;
}
