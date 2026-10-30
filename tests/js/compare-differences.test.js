// Tests for the "differences only" rule (frontend/js/compare/differences.js).
// The rule looks at the rows in view, counts the distinct values of each dimension, and keeps only the
// dimensions that vary. These tests cover one varying dimension, two, none, and the two examples the
// owner gave: "same models, different providers" and "same models, different question set or pushback set".
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIMENSIONS, distinctCount, varyingDimensions, chooseDifferenceView,
} from "../../frontend/js/compare/differences.js";

/** A row in view with every dimension set. Tests override only the dimensions they vary. */
function row(overrides = {}) {
  return {
    model: "Qwen3 30B",
    provider: "nebius",
    condition: "none",
    questionSet: "gauntlet_v3+easy",
    pushback: "ladder",
    rate: 0.5,
    ...overrides,
  };
}

test("the five dimensions are model, provider, condition, question set and pushback set", () => {
  assert.deepEqual(DIMENSIONS, ["model", "provider", "condition", "questionSet", "pushback"]);
});

test("distinctCount counts each value once, and counts a missing value as its own value", () => {
  const rows = [row({ provider: "a" }), row({ provider: "a" }), row({ provider: "b" }), row({ provider: null })];
  assert.equal(distinctCount(rows, "provider"), 3);
});

test("with one varying dimension, that dimension is the colour and nothing is a facet", () => {
  // Same model in every row, but the condition changes. Only condition varies.
  const rows = [row({ condition: "none" }), row({ condition: "mitigation" }), row({ condition: "control" })];
  const view = chooseDifferenceView(rows);
  assert.deepEqual(view.varying, ["condition"]);
  assert.equal(view.facet, null);
  assert.equal(view.colour, "condition");
  assert.equal(view.message, "");
});

test("with two varying dimensions, the first in facet order is the facet and the other is the colour", () => {
  // Models and conditions both vary. Condition comes before model in the facet order, so it is the facet.
  const rows = [
    row({ model: "A", condition: "none" }),
    row({ model: "A", condition: "control" }),
    row({ model: "B", condition: "none" }),
  ];
  const view = chooseDifferenceView(rows);
  assert.deepEqual(view.varying, ["model", "condition"]);
  assert.equal(view.facet, "condition");
  assert.equal(view.colour, "model");
});

test("constant dimensions are dropped from both the facet and the colour", () => {
  const rows = [row({ model: "A" }), row({ model: "B" })];
  const view = chooseDifferenceView(rows);
  assert.deepEqual(view.varying, ["model"]);
  assert.deepEqual(view.dropped, ["provider", "condition", "questionSet", "pushback"]);
  assert.notEqual(view.colour, "provider");
  assert.notEqual(view.facet, "provider");
});

test("with no varying dimension the view is empty and a clear message says why", () => {
  const rows = [row(), row(), row()];
  const view = chooseDifferenceView(rows);
  assert.deepEqual(view.varying, []);
  assert.equal(view.facet, null);
  assert.equal(view.colour, null);
  assert.match(view.message, /Nothing varies/);
});

test("with no rows at all the message says there is nothing to compare", () => {
  const view = chooseDifferenceView([]);
  assert.deepEqual(view.varying, []);
  assert.match(view.message, /No rows/);
});

test("owner example: same models, different providers shows the provider as the colour", () => {
  // Same model on two providers. Only the provider varies, so it is the one dimension shown.
  const rows = [
    row({ model: "Qwen3 30B", provider: "nebius" }),
    row({ model: "Qwen3 30B", provider: "groq" }),
  ];
  const view = chooseDifferenceView(rows);
  assert.deepEqual(view.varying, ["provider"]);
  assert.equal(view.colour, "provider");
  assert.equal(view.facet, null);
});

test("owner example: same models, different question set shows the question set as the facet", () => {
  // Two models, each run on the easy and the hard question set. The question set and the model vary.
  const rows = [
    row({ model: "A", questionSet: "gauntlet_v3+easy" }),
    row({ model: "A", questionSet: "gauntlet_v3+hard" }),
    row({ model: "B", questionSet: "gauntlet_v3+easy" }),
    row({ model: "B", questionSet: "gauntlet_v3+hard" }),
  ];
  const view = chooseDifferenceView(rows);
  assert.deepEqual(view.varying, ["model", "questionSet"]);
  assert.equal(view.facet, "questionSet");
  assert.equal(view.colour, "model");
});

test("owner example: same models, different pushback set shows the pushback set as the facet", () => {
  // The same two models under two pushback sets. The pushback set varies and so does the model.
  const rows = [
    row({ model: "A", pushback: "ladder" }),
    row({ model: "A", pushback: "authority" }),
    row({ model: "B", pushback: "ladder" }),
    row({ model: "B", pushback: "authority" }),
  ];
  const view = chooseDifferenceView(rows);
  assert.equal(view.facet, "pushback");
  assert.equal(view.colour, "model");
});

test("varyingDimensions returns the dimensions in the fixed dimension order", () => {
  const rows = [row({ pushback: "a", model: "x" }), row({ pushback: "b", model: "y" })];
  assert.deepEqual(varyingDimensions(rows), ["model", "pushback"]);
});

test("a missing value counts as a distinct value, so it makes a dimension vary", () => {
  // Missing provider on one row and a real provider on the other is two distinct values, so provider varies.
  const rows = [row({ provider: null }), row({ provider: "nebius" })];
  assert.deepEqual(varyingDimensions(rows), ["provider"]);
});
