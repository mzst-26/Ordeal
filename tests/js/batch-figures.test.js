// Tests for frontend/js/results/batch-figures.js: the pure helpers behind the Batch results figures.
// The helpers take plain numbers and rows and return plain values, so no DOM is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIGURE_VIEWS, PALETTE, colourFor, dashFor, radarPoints, polygonPoints, scatterPosition,
  splitScatterRows, wrapLabel, describeValues,
} from "../../frontend/js/results/batch-figures.js";

test("FIGURE_VIEWS lists Radar, Scatter and Profile with Radar first", () => {
  assert.deepEqual(FIGURE_VIEWS.map((view) => view.key), ["radar", "scatter", "profile"]);
  assert.deepEqual(FIGURE_VIEWS.map((view) => view.label), ["Radar", "Scatter", "Profile"]);
});

test("PALETTE has eight hex colours and colourFor cycles through them", () => {
  assert.equal(PALETTE.length, 8);
  for (const colour of PALETTE) assert.match(colour, /^#[0-9A-Fa-f]{6}$/);
  assert.equal(colourFor(0), PALETTE[0]);
  assert.equal(colourFor(7), PALETTE[7]);
  assert.equal(colourFor(8), PALETTE[0]);
  assert.equal(colourFor(17), PALETTE[1]);
});

test("dashFor is solid for the first eight models and changes pattern after that", () => {
  for (let i = 0; i < 8; i += 1) assert.equal(dashFor(i), "");
  assert.notEqual(dashFor(8), "");
  assert.notEqual(dashFor(8), dashFor(16));
});

test("radarPoints puts axis 0 at the top and skips axes with no value", () => {
  // Four axes, centre (50, 50), radius 100. Axis 1 is null so it has no point.
  // Value 0.5 on axis 3 (pointing left) lands halfway along that axis.
  assert.deepEqual(radarPoints([1, null, 0, 0.5], 4, 100, [50, 50]), [
    "50.00,-50.00",
    "50.00,50.00",
    "0.00,50.00",
  ]);
});

test("radarPoints clamps values to 0..1", () => {
  assert.deepEqual(radarPoints([2, -1], 2, 10, [0, 0]), ["0.00,-10.00", "0.00,0.00"]);
});

test("radarPoints returns no points when no axis has a value", () => {
  assert.deepEqual(radarPoints([null, null], 2, 10, [0, 0]), []);
});

test("polygonPoints joins the point strings with spaces", () => {
  assert.equal(polygonPoints(["1.00,2.00", "3.00,4.00"]), "1.00,2.00 3.00,4.00");
  assert.equal(polygonPoints([]), "");
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

test("wrapLabel breaks a label at word boundaries and keeps long words whole", () => {
  assert.deepEqual(wrapLabel("Units (questions right at the start)", 14), [
    "Units",
    "(questions",
    "right at the",
    "start)",
  ]);
  assert.deepEqual(wrapLabel("Baseline", 14), ["Baseline"]);
  assert.deepEqual(wrapLabel("Supercalifragilistic word", 8), ["Supercalifragilistic", "word"]);
});

test("describeValues gives each measure with its digits, and no data for null", () => {
  const measures = [
    { key: "a", label: "Baseline accuracy", digits: 3 },
    { key: "b", label: "Flip at level 10", digits: 2 },
  ];
  assert.equal(
    describeValues({ a: 0.8125, b: null }, measures),
    "Baseline accuracy 0.813; Flip at level 10 no data",
  );
});
