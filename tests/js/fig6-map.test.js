// Tests for FIG 6 (spineless against stubborn), the map of twin false-alarm rate against a vertical measure.
// The figure draws into the page, which node cannot do, so these tests check the pure helpers it draws from: the
// points for each vertical choice, the choices the selector offers, and the FIG 1 points that share the same function.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plotFor, mapYOptions } from "../../frontend/js/compare/fig-scatter.js";

/** One rate in the shape the compare data uses: the rate and its interval. */
function rate(value) {
  return { rate: value, ci_low: value - 0.05, ci_high: value + 0.05, n: 100 };
}

/** One model with twin data, as frontend/data/compare/results.json holds it. */
function twinModel(falseAlarm, hit, acceptance) {
  return {
    family: "test",
    baseline_accuracy: rate(0.8),
    flip_rate_last: rate(0.3),
    acceptance_mean: rate(acceptance),
    twin: {
      hit_rate: rate(hit),
      false_alarm_rate: rate(falseAlarm),
      discrimination: rate(hit - falseAlarm),
    },
  };
}

test("FIG 6 puts the false-alarm rate on x and the twin hit rate on y when hit rate is chosen", () => {
  const model = twinModel(0.2, 0.9, 0.5);
  const { points, leftOut } = plotFor("map", [model], "hit");
  assert.equal(points.length, 1);
  assert.equal(points[0].x, 0.2);
  assert.equal(points[0].y, 0.9);
  assert.deepEqual(leftOut, []);
});

test("FIG 6 keeps acceptance mean and discrimination as the vertical values for their own choices", () => {
  const model = twinModel(0.2, 0.9, 0.5);
  assert.equal(plotFor("map", [model], "acceptance").points[0].y, 0.5);
  assert.ok(Math.abs(plotFor("map", [model], "discrimination").points[0].y - 0.7) < 1e-9);
});

test("FIG 6 leaves out a model with no twin data, and never plots it as zero", () => {
  const withoutTwin = { family: "test", acceptance_mean: rate(0.5), baseline_accuracy: rate(0.8), flip_rate_last: rate(0.3) };
  const { points, leftOut } = plotFor("map", [withoutTwin], "hit");
  assert.deepEqual(points, []);
  assert.equal(leftOut.length, 1);
  assert.equal(leftOut[0].reason, "no twin data");
});

test("FIG 6 leaves out a model whose hit rate is not run, and says not run", () => {
  const model = twinModel(0.2, 0.9, 0.5);
  model.twin.hit_rate = rate(Number.NaN);
  const { points, leftOut } = plotFor("map", [model], "hit");
  assert.deepEqual(points, []);
  assert.equal(leftOut[0].reason, "not run");
});

test("FIG 6 plots every model with data, whether one provider or three are in the view", () => {
  const one = [twinModel(0.1, 0.8, 0.4)];
  const three = [twinModel(0.1, 0.8, 0.4), twinModel(0.3, 0.6, 0.2), twinModel(0.5, 0.9, 0.7)];
  assert.equal(plotFor("map", one, "hit").points.length, 1);
  assert.equal(plotFor("map", three, "hit").points.length, 3);
});

test("FIG 1 still plots baseline accuracy against the flip rate at the last level", () => {
  const model = twinModel(0.2, 0.9, 0.5);
  const point = plotFor("smart", [model], "hit").points[0];
  assert.equal(point.x, 0.8);
  assert.equal(point.y, 0.3);
});

test("the FIG 6 vertical selector offers only acceptance until some model has twin data", () => {
  assert.deepEqual(mapYOptions(false).map(([value]) => value), ["acceptance"]);
  assert.deepEqual(mapYOptions(true).map(([value]) => value), ["acceptance", "discrimination", "hit"]);
  assert.deepEqual(mapYOptions(true)[2], ["hit", "Twin hit rate"]);
});
