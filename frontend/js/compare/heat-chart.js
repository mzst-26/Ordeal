// Draws the ECharts heatmap for the Compare figure. fig-views.js loads this file only when a reader opens the heatmap
// view (a dynamic import), so the ECharts code is downloaded on demand and the small multiples and the dot plot do not
// pay for it.
// Only the parts the heatmap needs are imported: the core, one chart type, three components and the canvas renderer.
// The built-in ECharts tooltip is not imported. Its HTML is written with inline styles, which the site's policy
// (style-src 'self') blocks. The page's own tooltip is used instead, the same one the Vega views use.
import * as echarts from "echarts/core";
import { HeatmapChart } from "echarts/charts";
import { GridComponent, VisualMapComponent, TitleComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { heatmapTooltipLines } from "./echarts-heatmap.js";

// Register the parts once, when this module first loads. A part that is not registered cannot be used by an option.
echarts.use([HeatmapChart, GridComponent, VisualMapComponent, TitleComponent, CanvasRenderer]);

/**
 * The cells by position, so the pointer can find its cell in one lookup. The key is the row (model) times the number
 * of columns (questions) plus the column. A cell that was not drawn has no entry, so it has no tooltip.
 */
function cellsByPosition(option) {
  const columns = option.xAxis.data.length;
  const byKey = new Map();
  for (const cell of option.series[0].data) {
    const [column, row] = cell;
    byKey.set(row * columns + column, cell);
  }
  return byKey;
}

/**
 * The cell under a pointer position, in pixels from the chart's top left, or null when the pointer is off the plot or
 * on a cell that was not drawn. The plot is the chart box less the grid margins, split evenly into one column per
 * question and one row per model, which is how the option builder laid it out.
 */
function cellUnderPointer(option, size, byKey, x, y) {
  const grid = option.grid;
  const columns = option.xAxis.data.length;
  const rows = option.yAxis.data.length;
  const plotWidth = size.width - grid.left - grid.right;
  const plotHeight = size.height - grid.top - grid.bottom;
  const column = Math.floor((x - grid.left) / (plotWidth / columns));
  const row = Math.floor((y - grid.top) / (plotHeight / rows));
  if (column < 0 || row < 0 || column >= columns || row >= rows) {
    return null;
  }
  return byKey.get(row * columns + column) || null;
}

/**
 * Draws the heatmap into host, at the given size in pixels. handlers.onHover(lines, clientX, clientY) is called when
 * the pointer is over a cell, with the tooltip lines; handlers.onLeave() when it leaves the plot. Returns {release()},
 * which frees the chart and its canvas before another view replaces it.
 *
 * Why the pointer is read from the chart's surface and not from ECharts' series events: in the browser check, the
 * series' mouseover never fired for the cells, so no tooltip opened. The surface gives every mouse move, and the
 * position maps to a cell with the same layout the option builder used.
 */
export function drawHeatmap(host, option, size, handlers) {
  const chart = echarts.init(host, null, { renderer: "canvas", width: size.width, height: size.height });
  chart.setOption(option);
  const byKey = cellsByPosition(option);
  const surface = chart.getZr();
  surface.on("mousemove", (event) => {
    const cell = cellUnderPointer(option, size, byKey, event.offsetX, event.offsetY);
    if (!cell) {
      handlers.onLeave();
      return;
    }
    // Each cell is [questionIndex, modelIndex, rate, n], as the option builder writes it.
    const [questionIndex, modelIndex, rate, count] = cell;
    const lines = heatmapTooltipLines({
      model: option.yAxis.data[modelIndex],
      questionId: option.xAxis.data[questionIndex],
      rate,
      n: count,
    });
    // The native mouse event gives the pointer position on the page, so the page's tooltip sits next to it.
    const native = event.event;
    handlers.onHover(lines, native ? native.clientX : 0, native ? native.clientY : 0);
  });
  surface.on("globalout", () => handlers.onLeave());
  return {
    release() {
      chart.dispose();
    },
  };
}
