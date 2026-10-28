// Tests for frontend/js/fingerprint-summary.js: the plain sentences, the "not run yet" choice and the cells
// that the Batch fingerprint figure draws from. The functions are pure, so no DOM is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NOT_RUN_TEXT, probePhrase, percentText, isNotRun, summarySentence, buildFingerprintView,
} from "../frontend/js/fingerprint-summary.js";

// The two probe specs the batch page can load. The fingerprint probes are every single-shot axis except
// tampered_history, which grade.js puts in its own family. Reading the real files means a new probe with no
// phrase fails this test, instead of showing up as jargon on the page.
const PROBE_SPEC_FILES = ["../frontend/data/probe_spec.json", "../frontend/data/probe_spec_v4.json"];

/** Return the fingerprint probe ids of one probe spec file. */
function fingerprintProbesIn(file) {
  const spec = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
  return spec.axes.map((axis) => axis.id).filter((id) => id !== "tampered_history");
}

/** Make one probe row in the shape page-batch.js passes in. Only the fields the figure reads are set. */
function probeRow(model, probe, estimate, low, high, units = 56) {
  return { model, probe, family: "fingerprint", measure: "flip_rate", estimate, low, high, units };
}

test("percentText rounds a rate to a whole percent and keeps zero", () => {
  assert.equal(percentText(0.25), "25%");
  assert.equal(percentText(0.1053), "11%");
  assert.equal(percentText(1), "100%");
  assert.equal(percentText(0), "0%");
});

test("isNotRun is true only when the row is missing or its rate is not a number", () => {
  assert.equal(isNotRun(undefined), true);
  assert.equal(isNotRun({ estimate: Number.NaN, low: Number.NaN, high: Number.NaN }), true);
  assert.equal(isNotRun({ estimate: 0.25, low: 0.1, high: 0.4 }), false);
  // A rate of exactly zero is a real result (the model never flipped), not a missing one.
  assert.equal(isNotRun({ estimate: 0, low: 0, high: 0 }), false);
});

test("every fingerprint probe in the v3 and v4 specs has a plain phrase of its own, not the fallback", () => {
  const probes = new Set(PROBE_SPEC_FILES.flatMap(fingerprintProbesIn));
  // The v4 spec has 15 fingerprint probes, and the v3 spec's 12 are a subset of them.
  assert.equal(probes.size, 15);
  for (const probe of probes) {
    assert.notEqual(probePhrase(probe), probe.replace(/_/g, " "), `${probe} needs a phrase`);
    assert.match(probePhrase(probe), /^Changed its answer/);
  }
});

test("probePhrase falls back to the probe id with spaces for an unknown probe", () => {
  assert.equal(probePhrase("some_new_probe"), "some new probe");
});

test("summarySentence uses the phrase, the rate and the 95 percent range", () => {
  const row = { estimate: 0.25, low: 0.1, high: 0.4 };
  assert.equal(
    summarySentence("oracle", row),
    `${probePhrase("oracle")}: 25% of the time (95% range 10% to 40%).`,
  );
});

test("summarySentence says not run yet when the row is missing", () => {
  assert.equal(summarySentence("oracle", undefined), `${probePhrase("oracle")}: not run yet.`);
  assert.equal(NOT_RUN_TEXT, "Not run yet");
});

test("summarySentence leaves out the range when the bounds are missing", () => {
  const row = { estimate: 0.25, low: Number.NaN, high: Number.NaN };
  assert.equal(summarySentence("oracle", row), `${probePhrase("oracle")}: 25% of the time.`);
});

test("buildFingerprintView keeps the models in the order given and the probes in first-seen order", () => {
  const rows = [
    probeRow("A", "oracle", 0.25, 0.1, 0.4),
    probeRow("A", "bare", 0, 0, 0),
    probeRow("B", "oracle", 0.5, 0.3, 0.7),
  ];
  const view = buildFingerprintView(rows, [
    { id: "B", name: "Model B", index: 1 },
    { id: "A", name: "Model A", index: 0 },
  ]);
  assert.deepEqual(view.models.map((model) => model.id), ["B", "A"]);
  assert.deepEqual(view.probes.map((probe) => probe.probe), ["oracle", "bare"]);
  assert.deepEqual(view.models[1].cells.map((cell) => cell.probe), ["oracle", "bare"]);
});

test("a model with no row for a probe gets a not run cell with no rate text", () => {
  const rows = [probeRow("A", "oracle", 0.25, 0.1, 0.4), probeRow("B", "oracle", 0.5, 0.3, 0.7), probeRow("A", "bare", 0, 0, 0)];
  const view = buildFingerprintView(rows, [{ id: "A", name: "Model A", index: 0 }, { id: "B", name: "Model B", index: 1 }]);
  const missing = view.models[1].cells[1];
  assert.equal(missing.probe, "bare");
  assert.equal(missing.notRun, true);
  assert.equal(missing.text, NOT_RUN_TEXT);
  assert.equal(missing.sentence, `${probePhrase("bare")}: not run yet.`);
});

test("a run cell carries the same numbers in its text, its range and its units", () => {
  const rows = [probeRow("A", "oracle", 0.25, 0.1, 0.4, 56)];
  const view = buildFingerprintView(rows, [{ id: "A", name: "Model A", index: 0 }]);
  const cell = view.models[0].cells[0];
  assert.equal(cell.notRun, false);
  assert.equal(cell.text, "25%");
  assert.equal(cell.low, "10%");
  assert.equal(cell.high, "40%");
  assert.equal(cell.units, 56);
  assert.equal(cell.sentence, `${probePhrase("oracle")}: 25% of the time (95% range 10% to 40%).`);
});
