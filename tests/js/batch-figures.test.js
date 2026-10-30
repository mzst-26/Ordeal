// Tests for frontend/js/results/batch-figures.js: the pure helpers behind the Batch results figure.
// The helpers take plain numbers and rows and return plain values, so no DOM is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIGURE_VIEWS, DEFAULT_FIGURE_VIEW, PALETTE, colourFor, scatterPosition, splitScatterRows,
} from "../../frontend/js/results/batch-figures.js";

// The radar and the profile were removed. Scatter is the only figure left, and it is the default. A removed view must not
// come back in the switcher, so this test names the views exactly.
test("FIGURE_VIEWS offers only Scatter, and the default view is one of them", () => {
  assert.deepEqual(FIGURE_VIEWS.map((view) => view.key), ["scatter"]);
  assert.deepEqual(FIGURE_VIEWS.map((view) => view.label), ["Scatter"]);
  assert.equal(DEFAULT_FIGURE_VIEW, "scatter");
  assert.ok(FIGURE_VIEWS.some((view) => view.key === DEFAULT_FIGURE_VIEW));
});

test("PALETTE has eight hex colours and colourFor cycles through them", () => {
  assert.equal(PALETTE.length, 8);
  for (const colour of PALETTE) assert.match(colour, /^#[0-9A-Fa-f]{6}$/);
  assert.equal(colourFor(0), PALETTE[0]);
  assert.equal(colourFor(7), PALETTE[7]);
  assert.equal(colourFor(8), PALETTE[0]);
  assert.equal(colourFor(17), PALETTE[1]);
});

test("scatterPosition maps a value onto 0..size using min and max", () => {
  assert.equal(scatterPosition(5, 0, 10, 200), 100);
  assert.equal(scatterPosition(0, 0, 10, 200), 0);
  assert.equal(scatterPosition(10, 0, 10, 200), 200);
});

test("scatterPosition clamps out-of-range values and centres when min equals max", () => {
  assert.equal(scatterPosition(20, 0, 10, 200), 200);
  assert.equal(scatterPosition(-5, 0, 10, 200), 0);
  assert.equal(scatterPosition(3, 3, 3, 200), 100);
});

test("scatterPosition returns null when the value or the range is missing", () => {
  assert.equal(scatterPosition(null, 0, 10, 200), null);
  assert.equal(scatterPosition(5, null, 10, 200), null);
  assert.equal(scatterPosition(5, 0, null, 200), null);
  assert.equal(scatterPosition(undefined, 0, 10, 200), null);
});

test("splitScatterRows separates models that have both values from those that do not", () => {
  const rows = [
    { model: "a/one", index: 0, measures: { x: 1, y: 2 } },
    { model: "b/two", index: 1, measures: { x: null, y: 2 } },
    { model: "c/three", index: 2, measures: { x: 3, y: null } },
  ];
  const split = splitScatterRows(rows, "x", "y");
  assert.deepEqual(split.plotted.map((row) => row.model), ["a/one"]);
  assert.deepEqual(split.skipped, ["b/two", "c/three"]);
});
