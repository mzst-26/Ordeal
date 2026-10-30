// The Vega side of the benchmark. It draws each case the way the site does: the spec goes through Vega-Lite's compile,
// then vega.parse with { ast: true }, then a vega.View that uses vega-interpreter as its expression engine (the same
// lines as frontend/js/compare/fig-views.js). Where the site has a builder (heatmap, the difference toggle), this file
// calls the shipped builder itself, so the timed code is the code that ships. Scatter, faceted and selection specs
// have no shipped builder, so they are written here in the same style and are marked as harness specs in the report.
import * as vega from "vega";
import * as vegaLite from "vega-lite";
import { expressionInterpreter } from "vega-interpreter";
import { heatmapSpec, smallMultiplesSpec, MAX_SERIES } from "../../frontend/js/compare/vega-specs.js";
import { chooseDifferenceView } from "../../frontend/js/compare/differences.js";
import { THEME } from "./cases.js";

// The size of a single chart in pixels, and of one facet panel in the faceted and selection cases.
const CHART_WIDTH = 900;
const CHART_HEIGHT = 560;
const PANEL_WIDTH = 260;
const PANEL_HEIGHT = 200;
const FACET_COLUMNS = 3;
// The size of each mark. Small points keep 100k marks readable without hiding the cost of drawing them.
const POINT_SIZE = 9;
// The name of the interval selection the selection case uses. The runner refers to it when it sets a brush.
export const BRUSH_NAME = "brush";

/** A linear field from 0 to 1, shared by the scatter and the facets, so the scales are the same in every panel. */
function unitAxis(field) {
  return { field, type: "quantitative", scale: { domain: [0, 1] } };
}

/** The scatter case: one point per row, on fixed 0 to 1 axes. The tooltip shows the point, so hover has a tooltip to fire. */
export function scatterSpec(points) {
  return {
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    data: { values: points },
    mark: { type: "point", filled: true, size: POINT_SIZE, color: THEME.inkSoft },
    encoding: {
      x: unitAxis("x"),
      y: unitAxis("y"),
      tooltip: [{ field: "x" }, { field: "y" }],
    },
  };
}

/** The faceted case: one panel per facet value, shared scales, so the six panels line up. */
export function facetSpec(rows) {
  return {
    data: { values: rows },
    facet: { field: "facet", type: "nominal" },
    columns: FACET_COLUMNS,
    spec: {
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      mark: { type: "point", filled: true, size: POINT_SIZE, color: THEME.inkSoft },
      encoding: { x: unitAxis("x"), y: unitAxis("y") },
    },
    resolve: { scale: { x: "shared", y: "shared" } },
  };
}

/**
 * The selection case: an interval selection defined once at the top, so every facet panel shares it. Points inside the
 * brush take the highlight colour. Changing the brush re-runs the filter in every panel, which is what the case times.
 */
export function selectionSpec(rows) {
  const spec = facetSpec(rows);
  spec.params = [{ name: BRUSH_NAME, select: { type: "interval", encodings: ["x", "y"] } }];
  // empty: false makes an empty brush draw the base colour. By default Vega-Lite counts an empty selection as all
  // points selected, which would highlight every point before any brush is drawn.
  spec.spec.encoding.color = {
    condition: { param: BRUSH_NAME, value: THEME.highlight, empty: false },
    value: THEME.inkSoft,
  };
  return spec;
}

/**
 * The difference toggle. With differences only off, the page shows one panel per condition (the shipped default). With
 * it on, the shipped rule picks the panels and the colour from the rows. Both use the shipped small-multiples builder.
 */
export function toggleSpec(rows, differencesOnly) {
  if (!differencesOnly) {
    return smallMultiplesSpec(rows, { facet: "condition", colour: null, theme: THEME });
  }
  const rule = chooseDifferenceView(rows, { maxSeries: MAX_SERIES });
  return smallMultiplesSpec(rows, { facet: rule.facet, colour: rule.colour, theme: THEME });
}

/** The heatmap case: the shipped rect heatmap builder, which includes the colour legend. */
export function heatmapVegaSpec(rows) {
  return heatmapSpec(rows, { theme: THEME });
}

/**
 * Parses a Vega-Lite spec the way the site does, then creates and runs a view in the container. The renderer is the
 * only thing that differs between the canvas and SVG runs. Returns the finished view. The caller must finalize it.
 */
export async function drawVega(spec, container, renderer) {
  const runtime = vega.parse(vegaLite.compile(spec).spec, null, { ast: true });
  const view = new vega.View(runtime, { renderer, container, hover: true, expr: expressionInterpreter });
  await view.runAsync();
  return view;
}

/** The first element the renderer put in the container: a canvas or an svg. Events are dispatched on it. */
export function renderedSurface(container) {
  return container.querySelector("canvas") || container.querySelector("svg");
}

/**
 * Walks the scene graph and collects every mark item of the given marktype, with its position on the page relative to
 * the container. A rect is reported at its centre, so a click or hover lands inside the cell. Groups add their offsets.
 */
export function markItemsOn(view, marktype) {
  const found = [];
  collectItems(view.scenegraph().root, 0, 0, marktype, found);
  return found;
}

/** Recursive helper for markItemsOn: groups pass their offset down, and matching marks add their items. */
function collectItems(node, offsetX, offsetY, marktype, found) {
  if (node.marktype === marktype) {
    for (const item of node.items) {
      found.push(itemCentre(item, offsetX, offsetY, marktype));
    }
    return;
  }
  if (node.marktype !== "group") {
    return;
  }
  for (const groupItem of node.items) {
    const nextX = offsetX + (groupItem.x || 0);
    const nextY = offsetY + (groupItem.y || 0);
    for (const child of groupItem.items || []) {
      collectItems(child, nextX, nextY, marktype, found);
    }
  }
}

/** A mark item's centre, plus the item itself: a point is its x and y, and a rect is the middle of its box. */
function itemCentre(item, offsetX, offsetY, marktype) {
  const centreX = marktype === "rect" ? item.x + (item.width || 0) / 2 : item.x;
  const centreY = marktype === "rect" ? item.y + (item.height || 0) / 2 : item.y;
  return { x: offsetX + centreX, y: offsetY + centreY, item };
}
