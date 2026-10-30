// The benchmark page. It owns one chart at a time and exposes window.benchApi, which the Playwright runner calls. Each
// call that is timed takes its start and end time inside the page with performance.now(), so the browser's own clock
// measures the work, and the runner's round trip is not counted. The page draws with Vega (canvas or SVG) or with
// ECharts, and the runner decides which engine and case to run. Nothing here is shipped: the site never loads this file.
import * as echarts from "echarts";
import { caseData, CASE_IDS, THEME } from "./cases.js";
import {
  scatterSpec, facetSpec, selectionSpec, toggleSpec, heatmapVegaSpec, drawVega, renderedSurface, markItemsOn,
  BRUSH_NAME,
} from "./vega-harness.js";
import {
  scatterOption, facetOption, selectionOption, highlightUpdate, toggleOption, heatmapOption, BRUSH_AREAS,
} from "./echarts-harness.js";

// The size of the box the chart is drawn in, in CSS pixels. Both engines use the same box.
const BOX_WIDTH = 960;
const BOX_HEIGHT = 600;
// How long a hover may take before it counts as no response. A timeout is reported as unmeasured, not as a time.
const HOVER_TIMEOUT_MS = 2000;
// The marks the hover picks: points for the scatter and the facets, rects for the heatmap.
const HOVER_MARK = Object.freeze({ scatter: "symbol", facets: "symbol", heatmap: "rect" });

// The one live chart: its engine, case, container, the Vega view or ECharts instance, and the hover hook.
let live = null;

/** The page element that holds the chart. It is in index.html; each chart gets a fresh container inside it. */
function stage() {
  return document.getElementById("stage");
}

/** Removes the live chart and frees its listeners, so one run cannot leave work behind for the next. */
function destroyLive() {
  if (!live) {
    return;
  }
  if (live.view) {
    live.view.finalize();
  }
  if (live.chart) {
    live.chart.dispose();
  }
  live = null;
  stage().replaceChildren();
}

/** A fresh container for one chart, sized to the benchmark box. */
function newContainer() {
  const container = document.createElement("div");
  container.style.width = `${BOX_WIDTH}px`;
  container.style.height = `${BOX_HEIGHT}px`;
  stage().replaceChildren(container);
  return container;
}

/** Starts counting the longest main-thread task, so a freeze during a render shows up in the result. */
function startLongTaskWatch() {
  const watch = { longest: 0, observer: null };
  if (typeof PerformanceObserver === "undefined") {
    return watch;
  }
  watch.observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      watch.longest = Math.max(watch.longest, entry.duration);
    }
  });
  try {
    watch.observer.observe({ type: "longtask" });
  } catch (error) {
    watch.observer = null;
  }
  return watch;
}

/** Stops the long-task watch and returns the longest task it saw, in milliseconds. */
function stopLongTaskWatch(watch) {
  if (watch.observer) {
    watch.observer.disconnect();
  }
  return watch.longest;
}

/** A promise that resolves when ECharts reports it has finished drawing (after any progressive chunks). */
function echartsFinished(chart) {
  return new Promise((resolve) => {
    chart.on("finished", () => resolve());
  });
}

/** The engine name the runner passes: "vega-canvas", "vega-svg" or "echarts". */
function vegaRenderer(engine) {
  return engine === "vega-svg" ? "svg" : "canvas";
}

/** The Vega spec for one case. The differences-only flag is used by the toggle case only. */
function vegaSpecFor(caseId, data, differencesOnly) {
  if (caseId === "scatter") {
    return scatterSpec(data.points);
  }
  if (caseId === "heatmap") {
    return heatmapVegaSpec(data.rows);
  }
  if (caseId === "facets") {
    return facetSpec(data.rows);
  }
  if (caseId === "selection") {
    return selectionSpec(data.rows);
  }
  return toggleSpec(data.rows, differencesOnly);
}

/**
 * The ECharts option for one case. The item tooltip is switched on, because it is what fires the showTip event that a
 * hover is timed by. Without it, a hover would have nothing to respond with.
 */
function echartsOptionFor(caseId, data, differencesOnly) {
  let option;
  if (caseId === "scatter") {
    option = scatterOption(data);
  } else if (caseId === "heatmap") {
    option = heatmapOption(data);
  } else if (caseId === "facets") {
    option = facetOption(data);
  } else if (caseId === "selection") {
    option = selectionOption(data);
  } else {
    option = toggleOption(data.rows, differencesOnly);
  }
  option.tooltip = { trigger: "item" };
  return option;
}

/**
 * Draws one case with one engine and returns the time it took. The timer starts before the spec is built, so the time
 * includes building, compiling and drawing. It stops when the engine reports the drawing finished. The browser's own
 * paint of that frame comes after the timer stops, and is not counted.
 */
async function render(caseId, engine) {
  if (!CASE_IDS.includes(caseId)) {
    throw new Error(`Unknown case: ${caseId}`);
  }
  destroyLive();
  const data = caseData(caseId);
  const container = newContainer();
  const watch = startLongTaskWatch();
  const started = performance.now();
  if (engine.startsWith("vega")) {
    const spec = vegaSpecFor(caseId, data, false);
    const view = await drawVega(spec, container, vegaRenderer(engine));
    live = { caseId, engine, container, view, renderer: vegaRenderer(engine), chart: null, differencesOnly: false, onTooltip: null };
    view.tooltip((handler, event, item, value) => {
      if (live && live.onTooltip) {
        live.onTooltip(value);
      }
    });
  } else {
    const chart = echarts.init(container, null, { renderer: "canvas", width: BOX_WIDTH, height: BOX_HEIGHT });
    const finished = echartsFinished(chart);
    chart.setOption(echartsOptionFor(caseId, data, false), true);
    await finished;
    live = { caseId, engine, container, view: null, renderer: null, chart, differencesOnly: false, onTooltip: null };
  }
  const ms = performance.now() - started;
  return { ms, longestTaskMs: stopLongTaskWatch(watch) };
}

/** Runs a promise, or gives up after a timeout. Resolves with the value, or null on timeout. */
function orNull(promise, timeoutMs) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
}

/** The screen position of the mark at the given index, in CSS pixels from the viewport's top-left corner. */
function vegaPointOnScreen(view, container, marktype, index) {
  const items = markItemsOn(view, marktype);
  if (items.length === 0) {
    return null;
  }
  const target = items[index % items.length];
  const box = container.getBoundingClientRect();
  // The pointer position Vega's own hit test uses. view.origin() is 5 px off this value (checked in Chromium), so a
  // pointer at view.origin() misses a 2 px point. The handler's origin is what its pickEvent subtracts.
  const origin = view._handler._origin;
  return { clientX: box.left + origin[0] + target.x, clientY: box.top + origin[1] + target.y, item: target.item };
}

/**
 * Dispatches a pointer move at a client position. Vega listens for pointer events; ECharts' zrender listens for mouse
 * events, so the ECharts path sends a mousemove. Vega's SVG handler reads the element under the pointer (it looks at
 * evt.target), so for Vega the event goes to the element at that point. A canvas is its own element at every point.
 */
function movePointer(surface, clientX, clientY, engineKind) {
  if (engineKind === "echarts") {
    surface.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY, bubbles: true }));
    return;
  }
  const element = document.elementFromPoint(clientX, clientY) || surface;
  element.dispatchEvent(new PointerEvent("pointermove", { clientX, clientY, bubbles: true, pointerType: "mouse" }));
}

/**
 * Hovers one mark and times the response: from the pointer move to the tooltip. The pointer first leaves the chart, so
 * each hover is a real change of target. Returns the time in ms, or null with a reason when no tooltip came in time.
 */
async function hover(index) {
  if (!live) {
    return { ms: null, reason: "no chart is drawn" };
  }
  if (live.view) {
    return hoverVega(index);
  }
  return hoverEcharts(index);
}

/** Hover for a Vega view: the target is a rect for the heatmap and a point otherwise. */
async function hoverVega(index) {
  const surface = renderedSurface(live.container);
  const marktype = HOVER_MARK[live.caseId] || "symbol";
  const target = vegaPointOnScreen(live.view, live.container, marktype, index);
  if (!target) {
    return { ms: null, reason: "no marks were found in the scene graph" };
  }
  const box = live.container.getBoundingClientRect();
  movePointer(surface, box.left + 1, box.top + 1, "vega");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const tooltip = new Promise((resolve) => {
    live.onTooltip = (value) => {
      if (value) {
        resolve(performance.now());
      }
    };
  });
  const started = performance.now();
  movePointer(surface, target.clientX, target.clientY, "vega");
  const finishedAt = await orNull(tooltip, HOVER_TIMEOUT_MS);
  live.onTooltip = null;
  if (finishedAt === null) {
    return { ms: null, reason: `no tooltip within ${HOVER_TIMEOUT_MS} ms` };
  }
  return { ms: finishedAt - started, reason: "" };
}

/** Hover for an ECharts chart: the pointer goes to the pixel of the data point, and the tooltip's showTip is the response. */
async function hoverEcharts(index) {
  const chart = live.chart;
  const surface = renderedSurface(live.container);
  const target = echartsPointOnScreen(chart, live.container, index);
  if (!target) {
    return { ms: null, reason: "no data point could be converted to a pixel" };
  }
  const box = live.container.getBoundingClientRect();
  movePointer(surface, box.left + 1, box.top + 1, "echarts");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const tooltip = new Promise((resolve) => {
    // Only a tooltip that names a data item counts: an axis or empty-area tooltip is not a response to the point.
    const onTip = (payload) => {
      if (!payload || payload.dataIndex === undefined) {
        return;
      }
      chart.off("showTip", onTip);
      resolve(performance.now());
    };
    chart.on("showTip", onTip);
  });
  const started = performance.now();
  movePointer(surface, target.clientX, target.clientY, "echarts");
  const finishedAt = await orNull(tooltip, HOVER_TIMEOUT_MS);
  if (finishedAt === null) {
    chart.off("showTip");
    return { ms: null, reason: `no showTip event within ${HOVER_TIMEOUT_MS} ms` };
  }
  return { ms: finishedAt - started, reason: "" };
}

/** The screen position of one data point for ECharts, found through the chart's own coordinate conversion. */
function echartsPointOnScreen(chart, container, index) {
  const series = chart.getOption().series || [];
  if (series.length === 0) {
    return null;
  }
  const seriesIndex = 0;
  const points = series[seriesIndex].data || [];
  if (points.length === 0) {
    return null;
  }
  const point = points[index % points.length];
  const pixel = chart.convertToPixel({ seriesIndex }, [point[0], point[1]]);
  const box = container.getBoundingClientRect();
  return { clientX: box.left + pixel[0], clientY: box.top + pixel[1] };
}

/**
 * One update step, timed: the difference toggle flips the view, and the selection brushes a rectangle in the first
 * facet so every facet's highlight changes. Each call alternates the state, so repeated runs each do real work.
 */
async function update(step, index) {
  if (!live) {
    throw new Error("no chart is drawn");
  }
  if (step === "toggle") {
    return toggle();
  }
  if (step === "selection") {
    return brush(index);
  }
  throw new Error(`Unknown update step: ${step}`);
}

/** Flips the difference toggle and redraws the chart from scratch, as the site does on a toggle. */
async function toggle() {
  const next = !live.differencesOnly;
  const rows = caseData("toggle").rows;
  const started = performance.now();
  if (live.view) {
    const container = live.container;
    live.view.finalize();
    live.view = null;
    const view = await drawVega(toggleSpec(rows, next), container, live.renderer);
    live.view = view;
    live.differencesOnly = next;
  } else {
    // The listener is attached before setOption, because ECharts can finish drawing during the call itself.
    const finished = echartsFinished(live.chart);
    live.chart.setOption(toggleOption(rows, next), true);
    await finished;
    live.differencesOnly = next;
  }
  return { ms: performance.now() - started };
}

/** Brushes one rectangle in the first facet and waits until every facet has redrawn with the new highlight. */
async function brush(index) {
  const area = BRUSH_AREAS[index % BRUSH_AREAS.length];
  const started = performance.now();
  if (live.view) {
    await brushVega(area);
  } else {
    await brushEcharts(area);
  }
  return { ms: performance.now() - started };
}

/**
 * Sets the Vega selection to the rectangle, as a drag on the first facet's panel would. Vega-Lite keeps each panel's
 * brush as a tuple in the shared store, named by the panel's unit, and the spec's colour condition reads the store in
 * every panel. So one store update redraws all the facets. The tuple has the shape Vega-Lite writes itself (checked in
 * the compiled spec: unit, fields with type R, and the two ranges).
 */
async function brushVega(area) {
  const tuple = {
    unit: "child__facet_column_facet-1",
    fields: [{ field: "x", channel: "x", type: "R" }, { field: "y", channel: "y", type: "R" }],
    values: [[area.x0, area.x1], [area.y0, area.y1]],
  };
  const changes = live.view.changeset().remove(() => true).insert(tuple);
  live.view.change(`${BRUSH_NAME}_store`, changes);
  await live.view.runAsync();
}

/** Brushes the rectangle in the first panel, then fills the highlight series of every panel with the points inside. */
async function brushEcharts(area) {
  const data = caseData("facets");
  const finished = echartsFinished(live.chart);
  live.chart.dispatchAction({
    type: "brush",
    areas: [{ brushType: "rect", coordRange: [[area.x0, area.x1], [area.y0, area.y1]], xAxisIndex: 0, yAxisIndex: 0 }],
  });
  live.chart.setOption(highlightUpdate(data, area));
  await finished;
}

/**
 * Checks that matter for the pass lines. The legend check asks whether the colour legend exists in the drawing. The
 * selection check counts the highlighted points, so a selection that did not redraw the facets is caught.
 */
function checks(step, area) {
  if (!live) {
    return { passed: null, reason: "no chart is drawn" };
  }
  if (step === "legend") {
    return legendCheck();
  }
  if (step === "selection") {
    return selectionCheck(area);
  }
  throw new Error(`Unknown check: ${step}`);
}

/** Whether the colour legend is in the drawn chart. Vega's legend is in the scene graph; ECharts' is in its model. */
function legendCheck() {
  if (live.view) {
    const legends = countLegendGroups(live.view.scenegraph().root);
    return legends > 0 ? { passed: true, reason: "" } : { passed: false, reason: "no legend group in the scene graph" };
  }
  const visualMap = live.chart.getModel().getComponent("visualMap");
  return visualMap ? { passed: true, reason: "" } : { passed: false, reason: "no visualMap component" };
}

/** Counts the scene-graph groups that Vega marks as a legend. Walks the whole tree, so nested groups are counted too. */
function countLegendGroups(node) {
  let count = node.role && node.role.startsWith("legend") && node.marktype === "group" ? 1 : 0;
  for (const groupItem of node.items || []) {
    for (const child of groupItem.items || []) {
      count += countLegendGroups(child);
    }
  }
  return count;
}

/** Compares the highlighted points with the number the rectangle should contain. Only the selection case has one. */
function selectionCheck(area) {
  const expected = expectedInside(caseData("facets").rows, area);
  const highlighted = live.view ? highlightedVega() : highlightedEcharts();
  if (highlighted === expected) {
    return { passed: true, reason: "", highlighted, expected };
  }
  return { passed: false, reason: `highlighted ${highlighted}, expected ${expected}`, highlighted, expected };
}

/** How many rows lie inside the rectangle. This is the number a correct selection must highlight. */
function expectedInside(rows, area) {
  return rows.filter((row) => row.x >= area.x0 && row.x <= area.x1 && row.y >= area.y0 && row.y <= area.y1).length;
}

/** The number of points Vega painted in the highlight colour. Read from the scene graph, so both renderers are counted. */
function highlightedVega() {
  const highlight = THEME.highlight.toLowerCase();
  return markItemsOn(live.view, "symbol").filter((point) => String(point.item.fill).toLowerCase() === highlight).length;
}

/** The number of points ECharts has in its highlight series. */
function highlightedEcharts() {
  return (live.chart.getOption().series || [])
    .filter((series) => series.name && series.name.startsWith("highlight"))
    .reduce((sum, series) => sum + (series.data || []).length, 0);
}

window.benchApi = { render, hover, update, checks, destroy: destroyLive };
