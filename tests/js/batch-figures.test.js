// Tests for frontend/js/results/batch-figures.js: the pure helpers behind the Batch results figure.
// The helpers take plain numbers and rows and return plain values, so no DOM is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { labelBox } from "../../frontend/js/charts/labels.js";
import {
  FIGURE_VIEWS, DEFAULT_FIGURE_VIEW, PALETTE, colourFor, scatterPosition, splitScatterRows, scatterLabelSpots,
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

// Label collisions: the scatter places every label through the shared labels module, so models with the same score,
// or scores next to each other, keep their names apart. The plot here is a 300 by 200 box in SVG units.
const PLOT = { left: 40, right: 340, top: 10, bottom: 210 };

/** True when two label boxes overlap. Boxes that only touch at an edge do not count. */
function boxesCross(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

test("scatterLabelSpots gives one spot per point, in order, and none for no points", () => {
  assert.deepEqual(scatterLabelSpots([], PLOT), []);
  const spots = scatterLabelSpots([{ x: 100, y: 100, label: "a/one" }, { x: 200, y: 50, label: "b/two" }], PLOT);
  assert.equal(spots.length, 2);
  for (const spot of spots) assert.ok(Number.isFinite(spot.x) && Number.isFinite(spot.y));
});

test("scatterLabelSpots moves labels apart when two models sit on the same dot", () => {
  const points = [
    { x: 150, y: 100, label: "a/one" },
    { x: 150, y: 100, label: "b/two" },
    { x: 150, y: 100, label: "c/three" },
  ];
  const spots = scatterLabelSpots(points, PLOT);
  // 7px is the character width the labels module estimates for point labels.
  const boxes = points.map((point, i) => labelBox(point.label, spots[i], 7));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      assert.ok(!boxesCross(boxes[i], boxes[j]), `${points[i].label} and ${points[j].label} overlap`);
    }
  }
  for (const box of boxes) {
    assert.ok(box.left >= PLOT.left && box.right <= PLOT.right, "a label stays inside the plot across");
  }
});
