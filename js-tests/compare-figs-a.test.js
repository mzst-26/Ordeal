// Tests for the pure logic in the comparison figures 2, 3 and 7: heatmap sort, survivors count and delta labels.
// The figure modules draw into the page only inside mount(), so these tests import the helpers and never touch the DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sortHeatmapRows, heatmapFill, heatmapLabelTokens, bandLabel } from "../frontend/js/compare/fig-fingerprint.js";
import { countSurvivors, survivorState, survivorSentence } from "../frontend/js/compare/fig-survivors.js";
import { deltaLabel, conditionCaption, mitigationRate } from "../frontend/js/compare/fig-mitigation.js";

// Small builders for rate objects (value plus a +/-0.05 interval) and for the not-run shape (all fields null).
const rate = (value, extra = {}) => ({ rate: value, ci_low: value - 0.05, ci_high: value + 0.05, n: 56, ...extra });
const notRun = () => ({ rate: null, ci_low: null, ci_high: null, n: null });
const ids = (rows) => rows.map((row) => row.id);

// Heatmap row sorting: by one column, descending by default, with not-run rows always last and ties stable.
test("sortHeatmapRows sorts highest first by default and puts nulls last", () => {
  const models = [
    { id: "a", fingerprint: { bare: rate(0.2) } },
    { id: "b", fingerprint: { bare: notRun() } },
    { id: "c", fingerprint: { bare: rate(0.9) } },
    { id: "d", fingerprint: {} },
    { id: "e", fingerprint: { bare: rate(0.5) } },
  ];
  assert.deepEqual(ids(sortHeatmapRows(models, "bare")), ["c", "e", "a", "b", "d"]);
});

test("sortHeatmapRows reverses for ascending and still keeps nulls last", () => {
  const models = [
    { id: "a", fingerprint: { bare: rate(0.2) } },
    { id: "b", fingerprint: { bare: notRun() } },
    { id: "c", fingerprint: { bare: rate(0.9) } },
    { id: "d", fingerprint: { bare: rate(0.5) } },
  ];
  assert.deepEqual(ids(sortHeatmapRows(models, "bare", "asc")), ["a", "d", "c", "b"]);
});

test("sortHeatmapRows keeps the given order for equal values and when no key is given", () => {
  const models = [
    { id: "x", fingerprint: { bare: rate(0.4) } },
    { id: "y", fingerprint: { bare: rate(0.4) } },
    { id: "z", fingerprint: { bare: rate(0.1) } },
  ];
  assert.deepEqual(ids(sortHeatmapRows(models, "bare")), ["x", "y", "z"]);
  assert.deepEqual(ids(sortHeatmapRows(models, "bare", "asc")), ["z", "x", "y"]);
  assert.deepEqual(ids(sortHeatmapRows(models, null)), ["x", "y", "z"]);
});

test("sortHeatmapRows returns a new array and does not mutate its input", () => {
  const models = [
    { id: "a", fingerprint: { bare: rate(0.1) } },
    { id: "b", fingerprint: { bare: rate(0.8) } },
  ];
  const sorted = sortHeatmapRows(models, "bare");
  assert.notEqual(sorted, models);
  assert.deepEqual(ids(models), ["a", "b"]);
});

// The heatmap cell colour is a CSS color-mix whose percentage follows the value.
test("heatmapFill mixes cat-1 into paper-raised by the value, clamped to 0 to 1", () => {
  assert.equal(heatmapFill(0), "color-mix(in srgb, var(--cat-1) 0%, var(--paper-raised))");
  assert.equal(heatmapFill(0.5), "color-mix(in srgb, var(--cat-1) 50%, var(--paper-raised))");
  assert.equal(heatmapFill(0.256), "color-mix(in srgb, var(--cat-1) 26%, var(--paper-raised))");
  assert.equal(heatmapFill(1.5), heatmapFill(1));
  assert.equal(heatmapFill(-1), heatmapFill(0));
});

// Survivors figure: a model is holding while its flip rate at the chosen level is 50% or less.
const curve = (points) => points.map(([level, value]) => ({ level, rate: value }));

test("countSurvivors counts held (at or below 50%), flipped (above 50%) and not-run models", () => {
  const models = [
    { id: "a", flip_curve: curve([[1, rate(0.1)], [2, rate(0.5)]]) },
    { id: "b", flip_curve: curve([[1, rate(0.2)], [2, rate(0.7)]]) },
    { id: "c", flip_curve: curve([[1, notRun()], [2, rate(0.3)]]) },
    { id: "d", flip_curve: curve([[1, rate(0.9)], [2, notRun()]]) },
  ];
  assert.deepEqual(countSurvivors(models, 1), { holding: 2, flipped: 1, notRun: 1 });
  assert.deepEqual(countSurvivors(models, 2), { holding: 2, flipped: 1, notRun: 1 });
});

test("countSurvivors treats a missing level and a null curve as not run", () => {
  const models = [
    { id: "a", flip_curve: curve([[1, rate(0.1)]]) },
    { id: "b", flip_curve: null },
    { id: "c" },
  ];
  assert.deepEqual(countSurvivors(models, 5), { holding: 0, flipped: 0, notRun: 3 });
  assert.deepEqual(countSurvivors([], 1), { holding: 0, flipped: 0, notRun: 0 });
});

test("survivorState and survivorSentence give the words the brief asks for", () => {
  assert.equal(survivorState(rate(0.5)), "held");
  assert.equal(survivorState(rate(0.51)), "flipped");
  assert.equal(survivorState(notRun()), "not-run");
  assert.equal(survivorState(null), "not-run");
  assert.equal(survivorSentence({ holding: 2, flipped: 1, notRun: 0 }, 4), "2 of 3 still holding at level 4");
  assert.equal(survivorSentence({ holding: 0, flipped: 0, notRun: 2 }, 4), "No model has a result at level 4.");
});

// Mitigation figure: wording for the change in flip rate between conditions, and the caption for each condition.
test("deltaLabel gives signed points with an interval, and not run when either side is null", () => {
  const base = { rate: 0.42, ci_low: 0.36, ci_high: 0.48, n: 56 };
  const better = { rate: 0.30, ci_low: 0.24, ci_high: 0.36, n: 56 };
  const worse = { rate: 0.45, ci_low: 0.39, ci_high: 0.51, n: 56 };
  assert.equal(deltaLabel(better, base), "−12 points (95% CI −24 to 0 points)");
  assert.equal(deltaLabel(worse, base), "+3 points (95% CI −9 to +15 points)");
  assert.equal(deltaLabel(null, base), "not run");
  assert.equal(deltaLabel(base, null), "not run");
  assert.equal(deltaLabel(notRun(), base), "not run");
  assert.equal(deltaLabel(base, notRun()), "not run");
});

test("deltaLabel uses the singular for one point, leaves out the interval without one, and shows zero unsigned", () => {
  assert.equal(deltaLabel({ rate: 0.51 }, { rate: 0.5 }), "+1 point");
  assert.equal(deltaLabel({ rate: 0.4 }, { rate: 0.5 }), "−10 points");
  assert.equal(deltaLabel({ rate: 0.5, ci_low: 0.4, ci_high: 0.6 }, { rate: 0.5, ci_low: 0.4, ci_high: 0.6 }).startsWith("0 points"), true);
  assert.equal(deltaLabel({ rate: 0.5 }, { rate: 0.5 }), "0 points");
});

test("conditionCaption states the exact prompt, and says no prompt for none", () => {
  const prompts = { mitigation: "Be careful.", control: "Be polite." };
  assert.equal(conditionCaption("none", prompts), "No system prompt is added.");
  assert.equal(conditionCaption("mitigation", prompts), 'The mitigation condition adds this system prompt: "Be careful."');
  assert.equal(conditionCaption("control", {}), "The control condition's system prompt text is missing from the results file.");
});

test("mitigationRate returns null for a missing condition or a null flip rate", () => {
  const model = { mitigation: { none: { flip_rate_last: rate(0.4) }, mitigation: null, control: { flip_rate_last: notRun() } } };
  assert.equal(mitigationRate(model, "none").rate, 0.4);
  assert.equal(mitigationRate(model, "mitigation"), null);
  assert.equal(mitigationRate(model, "control"), null);
  assert.equal(mitigationRate({}, "none"), null);
});

// Contrast of the heatmap text against the cell fill, from the token values in tokens.css (WCAG relative luminance).
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const linear = (c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const luminance = (rgb) => {
  const [r, g, b] = rgb.map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** The cell colour that heatmapFill("...") names, mixed in sRGB as color-mix(in srgb) does. */
const fillRgb = (css, cat, paper) => {
  const share = Number(css.match(/var\(--cat-1\) (\d+)%/)[1]) / 100;
  return hexRgb(cat).map((c, i) => c * share + hexRgb(paper)[i] * (1 - share));
};
const THEMES = {
  light: { cat: "#892C1A", paper: "#FBF7EF", ink: "#26211C" },
  dark: { cat: "#AD5349", paper: "#26201B", ink: "#EDE4D3" },
};

// Accessibility: the cell fill uses the full colour range, and the label text is checked for enough
// contrast against the paper-raised background in both themes.
test("heatmap fill uses the full scale: value 1 is the full cat-1 mix, not a cap", () => {
  assert.equal(heatmapFill(1), "color-mix(in srgb, var(--cat-1) 100%, var(--paper-raised))");
  assert.equal(heatmapFill(0), "color-mix(in srgb, var(--cat-1) 0%, var(--paper-raised))");
  assert.notEqual(heatmapFill(0.6), heatmapFill(1));
});

test("heatmap labels are ink on paper-raised, with at least 4.5:1, in both themes", () => {
  const tokens = heatmapLabelTokens();
  assert.equal(tokens.text, "var(--ink)");
  assert.equal(tokens.background, "var(--paper-raised)");
  for (const [name, theme] of Object.entries(THEMES)) {
    const ratio = contrast(hexRgb(theme.ink), hexRgb(theme.paper));
    assert.ok(ratio >= 4.5, `${name} theme: ink on paper-raised is ${ratio.toFixed(2)}, below 4.5`);
  }
});

test("the full cell scale stays in use: the darkest fill is the full cat-1 token", () => {
  for (const theme of Object.values(THEMES)) {
    assert.deepEqual(fillRgb(heatmapFill(1), theme.cat, theme.paper), hexRgb(theme.cat));
  }
});

test("bandLabel gives the text for a banded model and null otherwise", () => {
  const bands = new Map([["a", 1], ["b", 2]]);
  assert.equal(bandLabel(bands, "a"), "Band 1");
  assert.equal(bandLabel(bands, "b"), "Band 2");
  assert.equal(bandLabel(bands, "missing"), null);
  assert.equal(bandLabel(null, "a"), null);
});
