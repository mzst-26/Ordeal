// Tests for the row builders that turn the compare data into the long rows the Vega-Lite views draw
// (frontend/js/compare/vega-rows.js). A missing or NaN value must come out as null, never as zero.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LADDER_PUSHBACK, conditionRows, questionRows, finiteOrNull, modelLabel,
} from "../../frontend/js/compare/vega-rows.js";

/** A rate with an interval and unit count, as the compare data writes it. */
function rate(value, low = null, high = null, n = 56) {
  return { rate: value, ci_low: low, ci_high: high, n };
}

/** A model entry with the mitigation block and per-question rates the row builders read. */
function model(id, overrides = {}) {
  return {
    id,
    display_name: id,
    provider: "nebius",
    family: "Qwen",
    mitigation: {
      none: { flip_rate_last: rate(0.5, 0.4, 0.6) },
      mitigation: { flip_rate_last: rate(0.3, 0.2, 0.4) },
      control: { flip_rate_last: rate(0.1, 0.05, 0.2) },
    },
    question_flip_rates: [],
    ...overrides,
  };
}

const DATA = { suite: "gauntlet_v3+easy", conditions: ["none", "mitigation", "control"] };

test("finiteOrNull keeps finite numbers and turns NaN, null and undefined into null", () => {
  assert.equal(finiteOrNull(0.25), 0.25);
  assert.equal(finiteOrNull(0), 0);
  assert.equal(finiteOrNull(NaN), null);
  assert.equal(finiteOrNull(null), null);
  assert.equal(finiteOrNull(undefined), null);
  assert.equal(finiteOrNull(Infinity), null);
});

test("modelLabel uses the display name, and falls back to the id", () => {
  assert.equal(modelLabel({ id: "a/b", display_name: "Model B" }), "Model B");
  assert.equal(modelLabel({ id: "a/b", display_name: null }), "a/b");
});

test("conditionRows gives one row per model and condition, with the rate and its interval", () => {
  const rows = conditionRows([model("m1")], DATA);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    modelId: "m1",
    model: "m1",
    family: "Qwen",
    provider: "nebius",
    condition: "none",
    questionSet: "gauntlet_v3+easy",
    pushback: LADDER_PUSHBACK,
    rate: 0.5,
    low: 0.4,
    high: 0.6,
    n: 56,
  });
});

test("a condition that was not run gives a null rate, never zero", () => {
  const notRun = model("m2", {
    mitigation: { none: { flip_rate_last: rate(0.5) }, mitigation: null, control: { flip_rate_last: rate(null, null, null, null) } },
  });
  const rows = conditionRows([notRun], DATA);
  const mitigation = rows.find((item) => item.condition === "mitigation");
  const control = rows.find((item) => item.condition === "control");
  assert.equal(mitigation.rate, null);
  assert.equal(control.rate, null);
  assert.equal(mitigation.low, null);
});

test("NaN and infinite values from the data are turned into null, not drawn as zero", () => {
  const broken = model("m3", {
    mitigation: { none: { flip_rate_last: rate(NaN, NaN, NaN, 10) }, mitigation: { flip_rate_last: rate(0.2, Infinity, 0.3) }, control: null },
  });
  const rows = conditionRows([broken], DATA);
  assert.equal(rows[0].rate, null);
  assert.equal(rows[1].rate, 0.2);
  assert.equal(rows[1].low, null);
  assert.equal(rows[1].high, 0.3);
});

test("a model with no provider is labelled unknown", () => {
  const rows = conditionRows([model("m4", { provider: undefined })], DATA);
  assert.equal(rows[0].provider, "unknown");
});

test("one provider and three providers both keep each model's own provider", () => {
  const one = conditionRows([model("a"), model("b")], DATA);
  assert.deepEqual([...new Set(one.map((item) => item.provider))], ["nebius"]);
  const three = conditionRows([
    model("a", { provider: "nebius" }),
    model("b", { provider: "groq" }),
    model("c", { provider: "together" }),
  ], DATA);
  assert.deepEqual([...new Set(three.map((item) => item.provider))].sort(), ["groq", "nebius", "together"]);
});

test("conditionRows uses the conditions in the data, in that order", () => {
  const rows = conditionRows([model("m5")], { suite: "s", conditions: ["control", "none"] });
  assert.deepEqual(rows.map((item) => item.condition), ["control", "none"]);
});

test("conditionRows with no models gives no rows", () => {
  assert.deepEqual(conditionRows([], DATA), []);
  assert.deepEqual(conditionRows(undefined, DATA), []);
});

test("a hundred models give three hundred condition rows", () => {
  const models = Array.from({ length: 100 }, (_, index) => model(`m${index}`));
  assert.equal(conditionRows(models, DATA).length, 300);
});

test("questionRows gives one row per question a model has, with its rate and count", () => {
  const withQuestions = model("q1", {
    question_flip_rates: [
      { question_id: "c01", flip_rate_last: rate(0.5, null, null, 2) },
      { question_id: "c02", flip_rate_last: rate(1, null, null, 1) },
    ],
  });
  const rows = questionRows([withQuestions], DATA);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    modelId: "q1",
    model: "q1",
    provider: "nebius",
    questionId: "c01",
    questionSet: "gauntlet_v3+easy",
    rate: 0.5,
    n: 2,
  });
});

test("a model with no question data gives no question rows, and a null rate stays null", () => {
  const none = model("q2", { question_flip_rates: undefined });
  assert.deepEqual(questionRows([none], DATA), []);
  const broken = model("q3", { question_flip_rates: [{ question_id: "c03", flip_rate_last: rate(NaN, null, null, 4) }] });
  assert.equal(questionRows([broken], DATA)[0].rate, null);
});
