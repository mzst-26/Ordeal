// Tests for the Vega-Lite spec builders (frontend/js/compare/vega-specs.js). Each spec is compiled with
// Vega-Lite, parsed with vega-interpreter (the same expression engine the page uses, so the page's CSP is not
// widened), and rendered in Node with no canvas. The tests then count the marks drawn, which checks that a
// missing value is left out of the picture and not drawn as zero.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as vega from "vega";
import * as vegaLite from "vega-lite";
import { expressionInterpreter } from "vega-interpreter";
import {
  MAX_SERIES, colourFieldFor, rampColours, mixHex, smallMultiplesSpec, dotPlotSpec, heatmapSpec,
} from "../../frontend/js/compare/vega-specs.js";
import { conditionRows, questionRows } from "../../frontend/js/compare/vega-rows.js";

// A theme with fixed colours, so the tests do not depend on the page's CSS.
const THEME = Object.freeze({
  ink: "#26211C",
  inkSoft: "#5A5048",
  rule: "#D9CDBB",
  surface: "#F5EFE3",
  accent: "#2E5E5B",
  categorical: Object.freeze(["#892C1A", "#A57C00", "#9A6AAF"]),
});
const DATA = { suite: "gauntlet_v3+easy", conditions: ["none", "mitigation", "control"] };

/** A rate with an interval, as the compare data writes it. */
function rate(value, low = null, high = null, n = 56) {
  return { rate: value, ci_low: low, ci_high: high, n };
}

/** A model entry with the three condition rates and optional per-question rates. */
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

/** Many models with the same shape, named m0 to m(count - 1). */
function manyModels(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => model(`m${index}`, overrides));
}

/** Compiles a Vega-Lite spec, parses it with the interpreter, and runs it with no renderer. */
async function renderSpec(spec) {
  const vegaSpec = vegaLite.compile(spec).spec;
  const runtime = vega.parse(vegaSpec, null, { ast: true });
  const view = new vega.View(runtime, { renderer: "none", expr: expressionInterpreter });
  await view.runAsync();
  return view;
}

/**
 * The drawn items of one Vega mark type, found through nested groups (facets and layers). Axis ticks and grid lines
 * are also rule marks, so the tests that count error bars filter these items by their data (see errorBarItems).
 */
function markItems(node, markType) {
  if (node.marktype === markType) {
    return node.items;
  }
  if (node.marktype && node.marktype !== "group") {
    return [];
  }
  return (node.items || []).flatMap((child) => markItems(child, markType));
}

/**
 * The number of plotted marks of one type: items whose data row has a rate. Vega also draws the colour legend with
 * symbol and rect marks, and those legend items carry no rate, so they are not counted.
 */
function countPlotted(node, markType) {
  return markItems(node, markType).filter((item) => item.datum && item.datum.rate !== undefined).length;
}

/** The error-bar items: rule marks whose data row has an interval. Axis rules have no interval, so they are left out. */
function errorBarItems(node) {
  return markItems(node, "rule").filter((item) => item.datum.low !== undefined && item.datum.low !== null);
}

test("colourFieldFor keeps a field with at most three values and drops a field with more", () => {
  assert.equal(MAX_SERIES, 3);
  const three = conditionRows([model("a"), model("b")], DATA);
  assert.equal(colourFieldFor(three, "condition"), "condition");
  const many = conditionRows(manyModels(4), DATA);
  assert.equal(colourFieldFor(many, "modelId"), null);
  // A single provider is one value, so it is kept: it is a legitimate single-value colour field.
  assert.equal(colourFieldFor(conditionRows(manyModels(4), DATA), "provider"), "provider");
});

test("mixHex gives the start colour at 0, the end colour at 1, and a blend between", () => {
  assert.equal(mixHex("#000000", "#ffffff", 0), "#000000");
  assert.equal(mixHex("#000000", "#ffffff", 1), "#ffffff");
  assert.equal(mixHex("#000000", "#ffffff", 0.5), "#808080");
});

test("rampColours gives one colour per step, from the surface to the accent", () => {
  const ramp = rampColours(THEME.surface, THEME.accent, 9);
  assert.equal(ramp.length, 9);
  assert.equal(ramp[0], THEME.surface.toLowerCase());
  assert.equal(ramp[8], THEME.accent.toLowerCase());
});

// ---------------------------------------------------------------- small multiples

test("small multiples: one model, with the condition as the panel, draws one point per valid rate", async () => {
  const rows = conditionRows([model("solo")], DATA);
  const spec = smallMultiplesSpec(rows, { facet: "condition", colour: null, theme: THEME });
  assert.equal(spec.facet.column.field, "condition");
  const view = await renderSpec(spec);
  assert.equal(countPlotted(view.scenegraph().root, "symbol"), 3);
});

test("small multiples: three models draw one point per model and condition", async () => {
  const rows = conditionRows([model("a"), model("b"), model("c")], DATA);
  const spec = smallMultiplesSpec(rows, { facet: "condition", colour: "modelId", theme: THEME });
  const view = await renderSpec(spec);
  assert.equal(countPlotted(view.scenegraph().root, "symbol"), 9);
});

test("small multiples: a hundred models render without error", async () => {
  const rows = conditionRows(manyModels(100), DATA);
  const spec = smallMultiplesSpec(rows, { facet: "condition", colour: null, theme: THEME });
  const view = await renderSpec(spec);
  assert.equal(countPlotted(view.scenegraph().root, "symbol"), 300);
});

test("small multiples: empty data renders with no points and no error", async () => {
  const spec = smallMultiplesSpec([], { facet: "condition", colour: null, theme: THEME });
  const view = await renderSpec(spec);
  assert.equal(countPlotted(view.scenegraph().root, "symbol"), 0);
});

test("small multiples: a NaN or missing rate is left out of the picture, not drawn as zero", async () => {
  const broken = model("broken", {
    mitigation: {
      none: { flip_rate_last: rate(NaN, NaN, NaN) },
      mitigation: { flip_rate_last: rate(0.3, 0.2, 0.4) },
      control: null,
    },
  });
  const rows = conditionRows([broken, model("ok")], DATA);
  const spec = smallMultiplesSpec(rows, { facet: "condition", colour: null, theme: THEME });
  // Six rows: two models by three conditions. Two are missing (the NaN "none" and the null "control" of "broken"),
  // so four points are drawn.
  const view = await renderSpec(spec);
  assert.equal(countPlotted(view.scenegraph().root, "symbol"), 4);
  const values = spec.data.values;
  const missing = values.find((row) => row.modelId === "broken" && row.condition === "none");
  assert.equal(missing.rate, null, "the NaN rate is stored as null, never zero");
});

test("small multiples: one provider and three providers both build and draw", async () => {
  const one = conditionRows([model("a"), model("b")], DATA);
  const oneSpec = smallMultiplesSpec(one, { facet: "provider", colour: null, theme: THEME });
  const oneView = await renderSpec(oneSpec);
  assert.equal(countPlotted(oneView.scenegraph().root, "symbol"), 6);
  const three = conditionRows([
    model("a", { provider: "nebius" }),
    model("b", { provider: "groq" }),
    model("c", { provider: "together" }),
  ], DATA);
  const threeSpec = smallMultiplesSpec(three, { facet: "provider", colour: "condition", theme: THEME });
  const threeView = await renderSpec(threeSpec);
  assert.equal(countPlotted(threeView.scenegraph().root, "symbol"), 9);
});

test("small multiples: the axes are shared by default, with the rate scale fixed from 0 to 1", () => {
  const spec = smallMultiplesSpec(conditionRows([model("a")], DATA), { facet: "condition", colour: null, theme: THEME });
  assert.equal(spec.spec.encoding.y.scale.domain[0], 0);
  assert.equal(spec.spec.encoding.y.scale.domain[1], 1);
  assert.equal(spec.resolve.scale.y, "shared");
  assert.equal(spec.resolve.scale.x, "shared");
});

test("small multiples: with no facet the view is one panel", async () => {
  const spec = smallMultiplesSpec(conditionRows([model("a")], DATA), { facet: null, colour: "condition", theme: THEME });
  assert.equal(spec.facet, undefined);
  const view = await renderSpec(spec);
  assert.equal(countPlotted(view.scenegraph().root, "symbol"), 3);
});

// ---------------------------------------------------------------- dot plot

test("dot plot: the condition is the colour, and each model and condition is a dot", async () => {
  const rows = conditionRows([model("a"), model("b")], DATA);
  const spec = dotPlotSpec(rows, { theme: THEME });
  assert.equal(spec.encoding.color.field, "condition");
  const view = await renderSpec(spec);
  assert.equal(countPlotted(view.scenegraph().root, "symbol"), 6);
});

test("dot plot: a missing rate gets no dot, and a missing interval gets no error bar", async () => {
  const partial = model("p", {
    mitigation: {
      none: { flip_rate_last: rate(0.5) },
      mitigation: { flip_rate_last: rate(0.3, 0.2, 0.4) },
      control: { flip_rate_last: rate(NaN, NaN, NaN) },
    },
  });
  const spec = dotPlotSpec(conditionRows([partial], DATA), { theme: THEME });
  const view = await renderSpec(spec);
  assert.equal(countPlotted(view.scenegraph().root, "symbol"), 2, "the NaN rate draws no dot");
  assert.equal(errorBarItems(view.scenegraph().root).length, 1, "only the rate with an interval gets an error bar");
  // The "none" rate has no interval, so it draws a dot but no error bar. The NaN control draws nothing.
});

test("dot plot: a hundred models render without error", async () => {
  const rows = conditionRows(manyModels(100), DATA);
  const view = await renderSpec(dotPlotSpec(rows, { theme: THEME }));
  assert.equal(countPlotted(view.scenegraph().root, "symbol"), 300);
});

test("dot plot: empty data renders with no dots", async () => {
  const view = await renderSpec(dotPlotSpec([], { theme: THEME }));
  assert.equal(countPlotted(view.scenegraph().root, "symbol"), 0);
});

// ---------------------------------------------------------------- heatmap

test("heatmap: a cell per model and question with a rate, and no cell for a missing rate", async () => {
  const withRates = model("h1", {
    question_flip_rates: [
      { question_id: "c01", flip_rate_last: rate(0.5, null, null, 2) },
      { question_id: "c02", flip_rate_last: rate(NaN, null, null, 1) },
      { question_id: "c03", flip_rate_last: rate(1, null, null, 1) },
    ],
  });
  const rows = questionRows([withRates], DATA);
  const spec = heatmapSpec(rows, { theme: THEME });
  assert.equal(spec.encoding.color.field, "rate");
  const view = await renderSpec(spec);
  assert.equal(countPlotted(view.scenegraph().root, "rect"), 2);
});

test("heatmap: a hundred models by twenty-nine questions render without error", async () => {
  const questions = Array.from({ length: 29 }, (_, index) => ({
    question_id: `q${String(index).padStart(2, "0")}`,
    flip_rate_last: rate(0.25, null, null, 2),
  }));
  const models = manyModels(100, { question_flip_rates: questions });
  const view = await renderSpec(heatmapSpec(questionRows(models, DATA), { theme: THEME }));
  assert.equal(countPlotted(view.scenegraph().root, "rect"), 2900);
});

test("heatmap: no rows renders an empty grid with no error", async () => {
  const view = await renderSpec(heatmapSpec([], { theme: THEME }));
  assert.equal(countPlotted(view.scenegraph().root, "rect"), 0);
});

test("heatmap: the colour scale runs from the surface to the accent in nine steps", () => {
  const spec = heatmapSpec([], { theme: THEME });
  assert.deepEqual(spec.encoding.color.scale.domain, [0, 1]);
  assert.equal(spec.encoding.color.scale.range.length, 9);
  assert.equal(spec.encoding.color.scale.range[0], THEME.surface.toLowerCase());
});

// The page's Content-Security-Policy has no 'unsafe-eval', so the browser refuses any code made from a string. Node can
// refuse the same thing with its own flag. This test renders each view in a child process started with that flag, so a
// compile step that uses the Function constructor fails here as it would on the page.
test("the three views render with code generation from strings disabled, as the page's CSP requires", () => {
  const projectDir = fileURLToPath(new URL("../../", import.meta.url));
  const specsUrl = pathToFileURL(fileURLToPath(new URL("../../frontend/js/compare/vega-specs.js", import.meta.url))).href;
  const rowsUrl = pathToFileURL(fileURLToPath(new URL("../../frontend/js/compare/vega-rows.js", import.meta.url))).href;
  const script = `
    import * as vega from "vega";
    import * as vegaLite from "vega-lite";
    import { expressionInterpreter } from "vega-interpreter";
    const specs = await import(${JSON.stringify(specsUrl)});
    const rows = await import(${JSON.stringify(rowsUrl)});
    const theme = ${JSON.stringify(THEME)};
    const models = [0, 1, 2].map((index) => ({
      id: "m" + index, display_name: "Model " + index, provider: "nebius", family: "Qwen",
      mitigation: {
        none: { flip_rate_last: { rate: 0.5, ci_low: 0.4, ci_high: 0.6, n: 56 } },
        mitigation: { flip_rate_last: { rate: 0.3, ci_low: 0.2, ci_high: 0.4, n: 56 } },
        control: { flip_rate_last: { rate: null, ci_low: null, ci_high: null, n: null } },
      },
      question_flip_rates: [{ question_id: "c01", flip_rate_last: { rate: 0.5, ci_low: null, ci_high: null, n: 2 } }],
    }));
    const data = { suite: "gauntlet_v3+easy", conditions: ["none", "mitigation", "control"] };
    const conditionRows = rows.conditionRows(models, data);
    const questionRows = rows.questionRows(models, data);
    const specList = [
      specs.smallMultiplesSpec(conditionRows, { facet: "condition", colour: "model", theme }),
      specs.dotPlotSpec(conditionRows, { theme }),
      specs.heatmapSpec(questionRows, { theme }),
    ];
    for (const spec of specList) {
      const runtime = vega.parse(vegaLite.compile(spec).spec, null, { ast: true });
      const view = new vega.View(runtime, { renderer: "none", expr: expressionInterpreter });
      await view.runAsync();
    }
    console.log("rendered " + specList.length);
  `;
  const result = spawnSync(process.execPath, ["--disallow-code-generation-from-strings", "--input-type=module", "-e", script], {
    cwd: projectDir,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rendered 3/);
});
