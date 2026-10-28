// Tests for the comparison page's pure helpers (frontend/js/compare/derive.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isNotRun, pct, rateText, numberText, visibleModels, defaultFilters, familyColour, familyOrder,
  familyLabel, rankBands, takeaway, FAMILY_PALETTE, sizeBounds,
} from "../../frontend/js/compare/derive.js";

/** A rate with an interval and unit count. */
function rate(value, low, high, n = 56) {
  return { rate: value, ci_low: low, ci_high: high, n };
}

/** A minimal model with the fields the derive helpers read. */
function model(id, overrides = {}) {
  return {
    id,
    display_name: id,
    family: "Qwen",
    params_b: 30,
    active_params_b: null,
    reasoning: false,
    open_weights: true,
    units: 56,
    questions: 29,
    baseline_accuracy: rate(0.8, 0.7, 0.9),
    flip_rate_last: rate(0.4, 0.3, 0.5),
    flip_curve: [{ level: 1, rate: rate(0.1, 0.05, 0.15) }, { level: 10, rate: rate(0.4, 0.3, 0.5) }],
    backbone_index: null,
    twin: null,
    gates: { low_sample: false, low_sample_cells: [], data_warning: false, consistency_flag: false },
    ...overrides,
  };
}

/** Every filter spelled out, so a test can change one at a time. */
function filtersFor(models, overrides = {}) {
  return { ...defaultFilters(models), ...overrides };
}

// Formatting helpers. A missing result reads "not run" rather than 0 or NaN.
test("isNotRun is true for null, undefined and a null rate, and false for a number", () => {
  assert.equal(isNotRun(null), true);
  assert.equal(isNotRun(undefined), true);
  assert.equal(isNotRun({ rate: null, ci_low: null, ci_high: null, n: null }), true);
  assert.equal(isNotRun(rate(0, 0, 0, 0)), false);
  assert.equal(isNotRun(rate(0.5, null, null, null)), false);
});

test("pct formats fractions and reads not run for null", () => {
  assert.equal(pct(0.62), "62%");
  assert.equal(pct(0), "0%");
  assert.equal(pct(0.5, 1), "50.0%");
  assert.equal(pct(null), "not run");
  assert.equal(pct(undefined), "not run");
  assert.equal(pct(Number.NaN), "not run");
});

test("numberText formats plain numbers and reads not run for null", () => {
  assert.equal(numberText(7.46), "7.5");
  assert.equal(numberText(null), "not run");
});

test("rateText gives the value, the interval and n, and reads not run for null", () => {
  assert.equal(rateText(rate(0.62, 0.55, 0.67, 56)), "62% (95% CI 55–67%, n=56)");
  assert.equal(rateText(null), "not run");
  assert.equal(rateText({ rate: null, ci_low: null, ci_high: null, n: null }), "not run");
  assert.equal(rateText(rate(0.5, null, null, null)), "50%");
  assert.equal(rateText(rate(0.5, null, null, 12)), "50% (n=12)");
});

// Filtering: sizeBounds and defaultFilters set the starting state, visibleModels applies each filter in turn.
test("sizeBounds takes the smallest and largest known size, and 0 when none is known", () => {
  assert.deepEqual(sizeBounds([model("a", { params_b: 3 }), model("b", { params_b: 120 }), model("c", { params_b: null })]), { min: 3, max: 120 });
  assert.deepEqual(sizeBounds([model("a", { params_b: null })]), { min: 0, max: 0 });
});

test("defaultFilters selects every family, takes the full size range and hides low-sample models", () => {
  const models = [
    model("a", { family: "Qwen", params_b: 30 }),
    model("b", { family: "Gemma", params_b: 27 }),
    model("c", { family: null, params_b: 120 }),
  ];
  const filters = defaultFilters(models);
  assert.deepEqual([...filters.families].map(String).sort(), ["Gemma", "Qwen", "null"]);
  assert.equal(filters.sizeMin, 27);
  assert.equal(filters.sizeMax, 120);
  assert.equal(filters.reasoning, "any");
  assert.equal(filters.open, "any");
  assert.equal(filters.lowSampleHidden, true);
  assert.equal(filters.search, "");
});

test("visibleModels with the default filters keeps every model that is not low-sample", () => {
  const models = [
    model("a"),
    model("b", { gates: { low_sample: true, low_sample_cells: ["x"] } }),
    model("c", { params_b: null }),
  ];
  assert.deepEqual(visibleModels(models, defaultFilters(models)).map((m) => m.id), ["a", "c"]);
  assert.deepEqual(visibleModels(models, filtersFor(models, { lowSampleHidden: false })).map((m) => m.id), ["a", "b", "c"]);
});

test("visibleModels applies the family filter", () => {
  const models = [model("a", { family: "Qwen" }), model("b", { family: "Gemma" }), model("c", { family: null })];
  const filters = filtersFor(models, { families: new Set(["Gemma"]) });
  assert.deepEqual(visibleModels(models, filters).map((m) => m.id), ["b"]);
  const withUnknown = filtersFor(models, { families: new Set([null]) });
  assert.deepEqual(visibleModels(models, withUnknown).map((m) => m.id), ["c"]);
});

test("visibleModels applies the size filter, and a null size passes only at the full range", () => {
  const models = [model("small", { params_b: 3 }), model("big", { params_b: 120 }), model("unknown", { params_b: null })];
  const narrow = filtersFor(models, { sizeMax: 50 });
  assert.deepEqual(visibleModels(models, narrow).map((m) => m.id), ["small"]);
  const full = filtersFor(models, { sizeMin: 3, sizeMax: 120 });
  assert.deepEqual(visibleModels(models, full).map((m) => m.id), ["small", "big", "unknown"]);
  const justBelowFull = filtersFor(models, { sizeMin: 3, sizeMax: 119 });
  assert.deepEqual(visibleModels(models, justBelowFull).map((m) => m.id), ["small"]);
});

test("visibleModels applies the reasoning and open-weights filters, and a null value fails unless the filter is any", () => {
  const models = [
    model("reasoner", { reasoning: true, open_weights: true }),
    model("plain", { reasoning: false, open_weights: false }),
    model("unknown", { reasoning: null, open_weights: null }),
  ];
  assert.deepEqual(visibleModels(models, filtersFor(models, { reasoning: "yes" })).map((m) => m.id), ["reasoner"]);
  assert.deepEqual(visibleModels(models, filtersFor(models, { reasoning: "no" })).map((m) => m.id), ["plain"]);
  assert.deepEqual(visibleModels(models, filtersFor(models, { reasoning: "any" })).map((m) => m.id), ["reasoner", "plain", "unknown"]);
  assert.deepEqual(visibleModels(models, filtersFor(models, { open: "no" })).map((m) => m.id), ["plain"]);
  assert.deepEqual(visibleModels(models, filtersFor(models, { open: "yes" })).map((m) => m.id), ["reasoner"]);
});

test("visibleModels applies the search to the name and the id, ignoring case and spaces at the ends", () => {
  const models = [model("Qwen/Qwen3-30B", { display_name: "Qwen3 30B" }), model("google/gemma-3", { display_name: "gemma-3" })];
  assert.deepEqual(visibleModels(models, filtersFor(models, { search: "  GEMMA " })).map((m) => m.id), ["google/gemma-3"]);
  assert.deepEqual(visibleModels(models, filtersFor(models, { search: "qwen/" })).map((m) => m.id), ["Qwen/Qwen3-30B"]);
  assert.deepEqual(visibleModels(models, filtersFor(models, { search: "nothing here" })), []);
});

// Family ordering, labels and colours for the legend and charts.
test("familyOrder keeps first-seen order and puts a null family last", () => {
  const models = [model("a", { family: "Gemma" }), model("b", { family: null }), model("c", { family: "Qwen" }), model("d", { family: "Gemma" })];
  assert.deepEqual(familyOrder(models), ["Gemma", "Qwen", null]);
  assert.deepEqual(familyOrder([]), []);
  assert.equal(familyLabel(null), "Unknown");
  assert.equal(familyLabel("Qwen"), "Qwen");
});

test("familyColour uses the palette by position, and the muted ink token for an unknown family", () => {
  const order = ["Gemma", "Qwen", null];
  assert.equal(familyColour("Gemma", order), FAMILY_PALETTE[0]);
  assert.equal(familyColour("Qwen", order), FAMILY_PALETTE[1]);
  assert.equal(familyColour(null, order), "var(--ink-mute)");
  assert.equal(familyColour("Unlisted", order), "var(--ink-mute)");
  assert.equal(FAMILY_PALETTE[0], "var(--cat-1)");
});

// rankBands groups models whose backbone-index confidence intervals overlap; Band 1 is the highest rate.
// A model with no backbone index gets no band.
test("rankBands puts overlapping intervals in one band, following chains of overlap", () => {
  const models = [
    model("a", { backbone_index: rate(0.60, 0.50, 0.70) }),
    model("b", { backbone_index: rate(0.65, 0.55, 0.75) }),
    model("c", { backbone_index: rate(0.72, 0.69, 0.80) }),
  ];
  const bands = rankBands(models);
  assert.equal(bands.get("a"), 1);
  assert.equal(bands.get("b"), 1);
  assert.equal(bands.get("c"), 1);
});

test("rankBands numbers separate bands firmest first: Band 1 is the highest backbone rate, whatever the list order", () => {
  const models = [
    model("low", { backbone_index: rate(0.20, 0.10, 0.30) }),
    model("high", { backbone_index: rate(0.90, 0.85, 0.95) }),
    model("mid", { backbone_index: rate(0.55, 0.45, 0.65) }),
  ];
  const bands = rankBands(models);
  assert.equal(bands.get("high"), 1);
  assert.equal(bands.get("mid"), 2);
  assert.equal(bands.get("low"), 3);
});

test("rankBands treats touching intervals as overlapping and gives no band to a null backbone index", () => {
  const models = [
    model("a", { backbone_index: rate(0.5, 0.4, 0.6) }),
    model("b", { backbone_index: rate(0.7, 0.6, 0.8) }),
    model("none", { backbone_index: null }),
  ];
  const bands = rankBands(models);
  assert.equal(bands.get("a"), 1);
  assert.equal(bands.get("b"), 1);
  assert.equal(bands.get("none"), null);
});

// takeaway builds the one-sentence summary. Its count is always of all loaded models;
// the optional second argument is the filtered list shown on screen.
test("takeaway reads for no models, one model and several models", () => {
  assert.equal(takeaway([]), "No models to compare yet.");
  assert.equal(
    takeaway([model("solo", { display_name: "Solo model", flip_rate_last: rate(0, 0, 0.1) })]),
    "On this run, 1 model was compared: Solo model reached Level 10 with 0% flipped.",
  );
  const several = [
    model("a", { display_name: "Alpha", flip_rate_last: rate(0.4, 0.3, 0.5) }),
    model("b", { display_name: "Beta", flip_rate_last: rate(0, 0, 0.1) }),
    model("c", { display_name: "Gamma", flip_rate_last: rate(0.2, 0.1, 0.3) }),
  ];
  assert.equal(
    takeaway(several),
    "On this run, 3 models were compared; the one that held longest, Beta, reached Level 10 with 0% flipped.",
  );
});

test("takeaway says flip rates are not run when no model has one", () => {
  const models = [model("a", { flip_rate_last: null }), model("b", { flip_rate_last: null })];
  assert.equal(takeaway(models), "On this run, 2 models were compared; flip rates are not run yet.");
});

test("defaultFilters gives a Set for families, so a set of one family is a real filter", () => {
  const models = [model("a", { family: "Qwen" }), model("b", { family: "Gemma" })];
  const filters = defaultFilters(models);
  assert.ok(filters.families instanceof Set);
  filters.families.delete("Gemma");
  assert.deepEqual(visibleModels(models, filters).map((m) => m.id), ["a"]);
});

test("rankBands orders bands by backbone rate, not by the order the models are listed in", () => {
  const models = [
    model("third", { backbone_index: rate(0.10, 0.05, 0.15) }),
    model("first", { backbone_index: rate(0.95, 0.90, 1.00) }),
    model("second", { backbone_index: rate(0.50, 0.40, 0.60) }),
  ];
  const bands = rankBands(models);
  assert.equal(bands.get("first"), 1);
  assert.equal(bands.get("second"), 2);
  assert.equal(bands.get("third"), 3);
});

test("takeaway counts every loaded model, even when the filters show fewer", () => {
  const all = [
    model("a", { display_name: "Alpha", flip_rate_last: rate(0.4, 0.3, 0.5) }),
    model("b", { display_name: "Beta", flip_rate_last: rate(0, 0, 0.1) }),
    model("c", { display_name: "Gamma", flip_rate_last: rate(0.2, 0.1, 0.3) }),
  ];
  assert.equal(
    takeaway(all, [all[0]]),
    "On this run, 3 models were compared; of the 1 shown, the one that held longest, Alpha, reached Level 10 with 40% flipped.",
  );
  assert.equal(
    takeaway(all, [all[1], all[2]]),
    "On this run, 3 models were compared; of the 2 shown, the one that held longest, Beta, reached Level 10 with 0% flipped.",
  );
});

test("takeaway says so when the filters hide every model, and never reads the filtered count as the total", () => {
  const all = [model("a"), model("b"), model("c")];
  assert.equal(takeaway(all, []), "On this run, 3 models were compared; none match the current filters.");
  assert.doesNotMatch(takeaway(all, [all[0]]), /1 model was compared/);
});

test("takeaway with the visible list left out uses the full list for both count and choice", () => {
  const all = [
    model("a", { display_name: "Alpha", flip_rate_last: rate(0.4, 0.3, 0.5) }),
    model("b", { display_name: "Beta", flip_rate_last: rate(0, 0, 0.1) }),
  ];
  assert.equal(takeaway(all), takeaway(all, all));
  assert.equal(
    takeaway(all),
    "On this run, 2 models were compared; the one that held longest, Beta, reached Level 10 with 0% flipped.",
  );
});
