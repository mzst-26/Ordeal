// The ECharts side of the benchmark. ECharts has no comparison views in this project, so each case is written here as
// an ECharts option over the same arrays the Vega side uses. The scatter uses large mode, as the owner's plan asks.
// The heatmap uses ECharts' own heatmap series with a visualMap, which is its colour legend. The facets are one grid per
// panel, which is how ECharts facets (the notes say so; no shipped example exists). The toggle and the selection are
// written the same way, so the numbers compare two equivalent drawings, not two finished components.
import { chooseDifferenceView } from "../../frontend/js/compare/differences.js";
import { MAX_SERIES } from "../../frontend/js/compare/vega-specs.js";
import { THEME } from "./cases.js";

// Large mode is the setting the owner's plan names. Progressive drawing sends the points in chunks, so the page can paint.
const LARGE_THRESHOLD = 2000;
const PROGRESSIVE_CHUNK = 10000;
// Marks are small, to match the Vega scatter and facet points.
const SYMBOL_SIZE = 3;
// The grid layout of the facets: three columns, two rows, as percentages of the chart box.
const FACET_COLUMNS = 3;
// A selection rectangle in data units. The runner alternates between two so each run changes the highlight.
export const BRUSH_AREAS = Object.freeze([
  { x0: 0.2, x1: 0.5, y0: 0.2, y1: 0.5 },
  { x0: 0.4, x1: 0.8, y0: 0.35, y1: 0.7 },
]);

// Converted once per case and kept, so building an ECharts option does not repeat the 100k conversions on every run.
const pairCache = new Map();

/** The points as [x, y] pairs, which is the form ECharts reads. Cached per case name. */
function pairsFor(caseId, points) {
  if (!pairCache.has(caseId)) {
    pairCache.set(caseId, points.map((point) => [point.x, point.y]));
  }
  return pairCache.get(caseId);
}

/** A value axis from 0 to 1, the same range the Vega axes use. */
function unitAxis(gridIndex) {
  return { type: "value", min: 0, max: 1, gridIndex, animation: false };
}

/** A scatter series in large mode, with progressive chunks. */
function scatterSeries(name, data, extra) {
  return {
    id: name,
    name,
    type: "scatter",
    large: true,
    largeThreshold: LARGE_THRESHOLD,
    progressive: PROGRESSIVE_CHUNK,
    symbolSize: SYMBOL_SIZE,
    data,
    ...extra,
  };
}

/** The scatter case: one large-mode scatter over the full 100,000 points. */
export function scatterOption(caseData) {
  const data = pairsFor("scatter", caseData.points);
  return {
    animation: false,
    grid: { left: 60, right: 30, top: 30, bottom: 50 },
    xAxis: { type: "value", min: 0, max: 1 },
    yAxis: { type: "value", min: 0, max: 1 },
    series: [scatterSeries("points", data, { itemStyle: { color: THEME.inkSoft } })],
  };
}

/** Grids and axes for a number of panels, laid out in rows of FACET_COLUMNS. Each panel gets its own grid. */
function panelGrids(count) {
  const grids = [];
  const xAxes = [];
  const yAxes = [];
  const rows = Math.ceil(count / FACET_COLUMNS);
  for (let index = 0; index < count; index += 1) {
    const column = index % FACET_COLUMNS;
    const row = Math.floor(index / FACET_COLUMNS);
    grids.push({
      left: `${5 + column * 32}%`,
      width: "26%",
      top: `${5 + (row * 90) / rows}%`,
      height: `${80 / rows - 8}%`,
    });
    xAxes.push(unitAxis(index));
    yAxes.push({ ...unitAxis(index), gridIndex: index });
  }
  return { grids, xAxes, yAxes };
}

/** The facet rows split into one array of [x, y] pairs per facet, in facet order. Cached per case name. */
const facetCache = new Map();
function facetPairs(rows) {
  if (!facetCache.has(rows)) {
    const labels = [...new Set(rows.map((row) => row.facet))];
    const groups = labels.map(() => []);
    for (const row of rows) {
      groups[labels.indexOf(row.facet)].push([row.x, row.y]);
    }
    facetCache.set(rows, groups);
  }
  return facetCache.get(rows);
}

/** The faceted case: six grids with one large scatter each, all on the same 0 to 1 axes. */
export function facetOption(caseData) {
  const groups = facetPairs(caseData.rows);
  const layout = panelGrids(groups.length);
  const series = groups.map((data, index) => scatterSeries(`facet-${index + 1}`, data, {
    xAxisIndex: index,
    yAxisIndex: index,
    itemStyle: { color: THEME.inkSoft },
  }));
  return { animation: false, grid: layout.grids, xAxis: layout.xAxes, yAxis: layout.yAxes, series };
}

/**
 * The selection case: the facet option plus a brush over every panel, and one highlight series per panel that starts
 * empty. The update fills the highlight series with the points inside the brushed rectangle.
 */
export function selectionOption(caseData) {
  const option = facetOption(caseData);
  option.brush = { xAxisIndex: "all", yAxisIndex: "all", brushType: "rect", brushMode: "single" };
  const panels = option.series.length;
  for (let index = 0; index < panels; index += 1) {
    option.series.push(scatterSeries(`highlight-${index + 1}`, [], {
      xAxisIndex: index,
      yAxisIndex: index,
      itemStyle: { color: THEME.highlight },
    }));
  }
  return option;
}

/**
 * The highlight update for one brush area: the points of every panel inside the rectangle, in each panel's highlight
 * series. Returns the series update the runner passes to setOption. Filtering in JavaScript is the cost ECharts pays.
 */
export function highlightUpdate(caseData, area) {
  const groups = facetPairs(caseData.rows);
  const series = groups.map((data, index) => {
    const inside = data.filter(([x, y]) => x >= area.x0 && x <= area.x1 && y >= area.y0 && y <= area.y1);
    return { id: `highlight-${index + 1}`, name: `highlight-${index + 1}`, data: inside };
  });
  return { series };
}

/**
 * The option for the difference toggle, with the shipped rule's choice of panels and colour. The rows are grouped into
 * one series per colour value in each panel. With differences only off, the panels are the conditions and there is no
 * colour, which is the shipped default. The models run along the x axis in the order they first appear.
 */
export function toggleOption(rows, differencesOnly) {
  const rule = differencesOnly
    ? chooseDifferenceView(rows, { maxSeries: MAX_SERIES })
    : { facet: "condition", colour: null };
  const facetValues = rule.facet ? uniqueOf(rows, rule.facet) : [null];
  const colourValues = rule.colour ? uniqueOf(rows, rule.colour) : [null];
  const modelOrder = uniqueOf(rows, "model");
  const layout = panelGrids(facetValues.length);
  const series = [];
  facetValues.forEach((facetValue, panel) => {
    colourValues.forEach((colourValue, colourIndex) => {
      const data = rows
        .filter((row) => (rule.facet ? row[rule.facet] === facetValue : true))
        .filter((row) => (rule.colour ? row[rule.colour] === colourValue : true))
        .filter((row) => row.rate !== null)
        .map((row) => [modelOrder.indexOf(row.model) / Math.max(1, modelOrder.length - 1), row.rate]);
      series.push(scatterSeries(`panel-${panel}-${colourIndex}`, data, {
        xAxisIndex: panel,
        yAxisIndex: panel,
        itemStyle: { color: THEME.categorical[colourIndex % THEME.categorical.length] },
      }));
    });
  });
  return {
    animation: false,
    grid: layout.grids,
    xAxis: layout.xAxes,
    yAxis: layout.yAxes,
    series,
  };
}

/** The distinct values of one field in the order they first appear. A local copy of the shipped helper, for clarity. */
function uniqueOf(rows, field) {
  return [...new Set(rows.map((row) => row[field]))];
}

/**
 * The heatmap case: a model by question grid with the ECharts heatmap series. The visualMap is the colour legend, which
 * the owner's plan requires to be working. Every cell has a rate, so no cell is left out.
 */
export function heatmapOption(caseData) {
  const questions = uniqueOf(caseData.rows, "questionId");
  const models = uniqueOf(caseData.rows, "model");
  const questionIndex = new Map(questions.map((value, index) => [value, index]));
  const modelIndex = new Map(models.map((value, index) => [value, index]));
  const data = caseData.rows.map((row) => [questionIndex.get(row.questionId), modelIndex.get(row.model), row.rate]);
  return {
    animation: false,
    grid: { left: 90, right: 30, top: 20, bottom: 90 },
    xAxis: { type: "category", data: questions, splitArea: { show: false } },
    yAxis: { type: "category", data: models },
    visualMap: {
      min: 0,
      max: 1,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      show: true,
      text: ["High", "Low"],
      inRange: { color: [THEME.surface, THEME.accent] },
    },
    series: [{ type: "heatmap", data, progressive: PROGRESSIVE_CHUNK }],
  };
}
