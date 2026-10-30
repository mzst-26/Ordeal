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
 * Draws the heatmap into host, at the given size in pixels. handlers.onHover(lines, clientX, clientY) is called when
 * the pointer is over a cell, with the tooltip lines; handlers.onLeave() when it leaves the chart. Returns
 * {release()}, which frees the chart and its canvas before another view replaces it.
 */
export function drawHeatmap(host, option, size, handlers) {
  const chart = echarts.init(host, null, { renderer: "canvas", width: size.width, height: size.height });
  chart.setOption(option);
  chart.on("mouseover", (params) => {
    if (params.componentType !== "series") {
      return;
    }
    // Each data item is [questionIndex, modelIndex, rate, n], as the option builder writes it.
    const [questionIndex, modelIndex, rate, count] = params.data;
    const cell = {
      model: option.yAxis.data[modelIndex],
      questionId: option.xAxis.data[questionIndex],
      rate,
      n: count,
    };
    // The native mouse event gives the pointer position, so the page's tooltip can sit next to it.
    const native = params.event && params.event.event;
    handlers.onHover(heatmapTooltipLines(cell), native ? native.clientX : 0, native ? native.clientY : 0);
  });
  chart.on("globalout", () => handlers.onLeave());
  return {
    release() {
      chart.dispose();
    },
  };
}
