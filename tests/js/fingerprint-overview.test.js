// Tests for frontend/js/fingerprint-overview.js: the overall flip rate for a model, the probe where it flips most,
// the order of the models in the Summary, and the order of the models for one probe in the Chart and Table.
// The functions are pure, so no DOM is needed. The cells come from buildFingerprintView, so the tests use the
// same cell shape the figure draws from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFingerprintView, probePhrase } from "../../frontend/js/fingerprint-summary.js";
import { overallRate, mostFlipsCell, rankModels, rowsForProbe, chooseProbe } from "../../frontend/js/fingerprint-overview.js";

/** Make one probe row in the shape page-batch.js passes in. Only the fields the figure reads are set. */
function probeRow(model, probe, estimate, low, high, units = 40) {
  return { model, probe, family: "fingerprint", measure: "flip_rate", estimate, low, high, units };
}

/** Build the view for the given rows and models, and return the view's models, in the order given. */
function modelsFor(rows, models) {
  return buildFingerprintView(rows, models.map((model) => ({ ...model, index: 0 }))).models;
}

test("overallRate weights each probe by the number of questions behind it", () => {
  // Probe one: 10 questions at 50%. Probe two: 30 questions at 10%. The overall rate is (5 + 3) / 40 = 20%.
  const rows = [
    probeRow("A", "oracle", 0.5, 0.3, 0.7, 10),
    probeRow("A", "bare", 0.1, 0.05, 0.2, 30),
  ];
  const [model] = modelsFor(rows, [{ id: "A", name: "Model A" }]);
  const overall = overallRate(model);
  assert.equal(overall.notRun, false);
  assert.ok(Math.abs(overall.estimate - 0.2) < 1e-9);
  // The range is the same weighted average of each probe's low and high bound: (3 + 1.5) / 40 and (7 + 6) / 40.
  assert.ok(Math.abs(overall.low - 0.1125) < 1e-9);
  assert.ok(Math.abs(overall.high - 0.325) < 1e-9);
});

test("overallRate leaves out probes that were not run, and says not run when none were", () => {
  const rows = [probeRow("A", "oracle", 0.5, 0.3, 0.7, 10), probeRow("B", "bare", 0.2, 0.1, 0.3, 10)];
  const [a, b] = modelsFor(rows, [{ id: "A", name: "Model A" }, { id: "B", name: "Model B" }]);
  // Model A has no reply for "bare", so only "oracle" counts for it.
  assert.equal(overallRate(a).estimate, 0.5);
  // Model B has rows only for "bare", so its overall rate is its one probe. A model with no cell at all is not run.
  assert.equal(overallRate(b).estimate, 0.2);
  const [empty] = modelsFor([probeRow("A", "oracle", 0.5, 0.3, 0.7, 10)], [{ id: "C", name: "Model C" }]);
  assert.deepEqual(overallRate(empty), { notRun: true, estimate: null, low: null, high: null });
});

test("overallRate has no range when a probe has no bounds", () => {
  const rows = [probeRow("A", "oracle", 0.5, Number.NaN, Number.NaN, 10)];
  const [model] = modelsFor(rows, [{ id: "A", name: "Model A" }]);
  const overall = overallRate(model);
  assert.equal(overall.estimate, 0.5);
  assert.equal(overall.low, null);
  assert.equal(overall.high, null);
});

test("mostFlipsCell picks the probe with the highest rate, and the first probe when rates tie", () => {
  const rows = [
    probeRow("A", "oracle", 0.2, 0.1, 0.3),
    probeRow("A", "bare", 0.6, 0.4, 0.8),
    probeRow("A", "authority", 0.6, 0.4, 0.8),
  ];
  const [model] = modelsFor(rows, [{ id: "A", name: "Model A" }]);
  assert.equal(mostFlipsCell(model).probe, "bare");
});

test("mostFlipsCell is null when no probe was run for the model", () => {
  const [model] = modelsFor([probeRow("A", "oracle", 0.5, 0.3, 0.7)], [{ id: "B", name: "Model B" }]);
  assert.equal(mostFlipsCell(model), null);
});

test("rankModels sorts the highest overall rate first, puts not run last, and breaks ties by name", () => {
  const rows = [
    probeRow("A", "oracle", 0.3, 0.2, 0.4),
    probeRow("B", "oracle", 0.6, 0.5, 0.7),
    probeRow("C", "oracle", 0.3, 0.2, 0.4),
  ];
  const models = modelsFor(rows, [
    { id: "A", name: "Alpha" },
    { id: "B", name: "Bravo" },
    { id: "C", name: "Charlie" },
    { id: "D", name: "Delta" },
  ]);
  const ranked = rankModels(models);
  assert.deepEqual(ranked.map((item) => item.model.name), ["Bravo", "Alpha", "Charlie", "Delta"]);
  assert.equal(ranked[3].overall.notRun, true);
  assert.equal(ranked[0].most.probe, "oracle");
  assert.equal(ranked[3].most, null);
});

test("rowsForProbe sorts the models by that probe's rate, highest first, with not run models last", () => {
  const rows = [
    probeRow("A", "oracle", 0.3, 0.2, 0.4),
    probeRow("A", "bare", 0.9, 0.8, 1),
    probeRow("B", "oracle", 0.6, 0.5, 0.7),
    probeRow("C", "bare", 0.1, 0.0, 0.2),
  ];
  const models = modelsFor(rows, [
    { id: "A", name: "Alpha" },
    { id: "B", name: "Bravo" },
    { id: "C", name: "Charlie" },
  ]);
  const forOracle = rowsForProbe(models, "oracle");
  assert.deepEqual(forOracle.map((item) => item.model.name), ["Bravo", "Alpha", "Charlie"]);
  assert.equal(forOracle[2].cell.notRun, true);
  assert.equal(forOracle[0].cell.estimate, 0.6);
});

test("chooseProbe keeps the probe already chosen, or falls back to the first probe", () => {
  const probes = [{ probe: "oracle", phrase: probePhrase("oracle") }, { probe: "bare", phrase: probePhrase("bare") }];
  assert.equal(chooseProbe(probes, "bare"), "bare");
  assert.equal(chooseProbe(probes, "gone"), "oracle");
  assert.equal(chooseProbe(probes, null), "oracle");
  assert.equal(chooseProbe([], "oracle"), null);
});
