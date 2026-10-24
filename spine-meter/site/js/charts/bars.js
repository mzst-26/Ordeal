// Grouped bar chart with an error bar on each bar. A NaN value draws no bar and writes "no data".
// A NaN bound draws the bar without its error bar.
import { linearScale, packSeries, seriesBlocks, axisTicks, topOf } from "./scale.js";
import {
  svgElement, svgText, seriesColours, legendFor, labelFor, startFrame, drawValueAxis, drawBaseline,
  drawXLabels, drawAxisTitles, createChart, FADED_OPACITY,
} from "./draw.js";

const BAR_HEIGHT = 300;
const BAR_GAP = 2;
const BAR_MAX_WIDTH = 32;
const BAR_RADIUS = 4;
const ERROR_CAP_HALF = 4;

/** Bar chart series, renamed to the same shape the line chart uses. */
function barSeriesOf(options) {
  return (options.series || []).map((item) => ({
    name: item.name,
    color: item.color,
    values: item.valuesByGroup,
    lows: item.lowsByGroup,
    highs: item.highsByGroup,
    faded: item.faded === true,
  }));
}

/** Packed bar numbers: one block per series, with one entry per group. */
function barNumbers(options) {
  const groups = options.groups || [];
  return packSeries(barSeriesOf(options), groups.length);
}

/** Width of one bar: about 70% of its group, shared by the series, and capped. */
function barWidthFor(groupWidth, seriesCount) {
  const share = (groupWidth * 0.7 - (seriesCount - 1) * BAR_GAP) / seriesCount;
  return Math.max(2, Math.min(BAR_MAX_WIDTH, share));
}

/** Path for a bar: a flat baseline with two rounded top corners. */
function barPath(x, top, width, bottom) {
  const radius = Math.min(BAR_RADIUS, width / 2, bottom - top);
  const right = x + width;
  return [
    `M ${x} ${bottom}`,
    `L ${x} ${top + radius}`,
    `Q ${x} ${top} ${x + radius} ${top}`,
    `L ${right - radius} ${top}`,
    `Q ${right} ${top} ${right} ${top + radius}`,
    `L ${right} ${bottom}`,
    "Z",
  ].join(" ");
}

/** Draws the error bar from low to high, with a short cap at each end. */
function drawErrorBar(frame, centreX, lowY, highY) {
  const { svg, theme } = frame;
  const stroke = { stroke: theme.ink, "stroke-width": 1.5 };
  svg.appendChild(svgElement("line", { x1: centreX, x2: centreX, y1: lowY, y2: highY, ...stroke }));
  for (const y of [lowY, highY]) {
    svg.appendChild(svgElement("line", {
      x1: centreX - ERROR_CAP_HALF, x2: centreX + ERROR_CAP_HALF, y1: y, y2: y, ...stroke,
    }));
  }
}

/** True when a bar has both bounds and they are in order, so its error bar can be drawn. */
function hasErrorBar(bar) {
  return Number.isFinite(bar.low) && Number.isFinite(bar.high) && bar.high > bar.low;
}

/** Writes "no data" just above the baseline, under a bar that has no value. */
function drawNoDataLabel(frame, x, baseY) {
  frame.svg.appendChild(svgText("no data", {
    x, y: baseY - 6, "text-anchor": "middle", "font-family": frame.theme.sans, "font-size": 11,
    fill: frame.theme.inkMute,
  }));
}

/** Draws one bar from zero to its value, with its error bar. */
function drawBar(frame, bar) {
  const baseY = bar.yScale(0);
  if (!Number.isFinite(bar.value)) {
    drawNoDataLabel(frame, bar.x + bar.width / 2, baseY);
    return;
  }
  const topY = bar.yScale(bar.value);
  if (baseY - topY > 0) {
    frame.svg.appendChild(svgElement("path", {
      d: barPath(bar.x, topY, bar.width, baseY), fill: bar.colour, "fill-opacity": bar.fillOpacity,
    }));
  }
  if (hasErrorBar(bar)) {
    drawErrorBar(frame, bar.x + bar.width / 2, bar.yScale(bar.low), bar.yScale(bar.high));
  }
}

/** Draws every bar of one series, one per group, each offset so the series sit side by side. */
function drawSeriesBars(frame, drawing) {
  const { series, seriesIndex, numbers, count, centres, barWidth, yScale, colour } = drawing;
  const blocks = seriesBlocks(numbers, seriesIndex, count);
  const offset = (seriesIndex - (series.length - 1) / 2) * (barWidth + BAR_GAP);
  centres.forEach((centre, groupIndex) => {
    drawBar(frame, {
      x: centre + offset - barWidth / 2,
      width: barWidth,
      yScale,
      colour,
      fillOpacity: series[seriesIndex].faded ? FADED_OPACITY : 1,
      value: blocks.values[groupIndex],
      low: blocks.lows[groupIndex],
      high: blocks.highs[groupIndex],
    });
  });
}

/** Draws the grouped bar chart with error bars. */
function buildBars(host, options, numbers) {
  const groups = options.groups || [];
  const series = barSeriesOf(options);
  const count = groups.length;
  const colours = seriesColours(host, series);
  const frame = startFrame(host, {
    height: BAR_HEIGHT,
    title: options.title,
    yTitle: options.yAxisTitle,
    legend: legendFor(series, colours),
    label: labelFor(host, options),
  });
  const ticks = axisTicks(options.yMax, frame.narrow ? 3 : 5);
  const yScale = linearScale(0, topOf(ticks), frame.plot.bottom, frame.plot.top);
  const groupWidth = frame.plot.width / Math.max(count, 1);
  const centres = Array.from({ length: count }, (_, index) => frame.plot.left + groupWidth * (index + 0.5));
  const barWidth = barWidthFor(groupWidth, series.length);
  drawValueAxis(frame, ticks, yScale);
  drawBaseline(frame);
  drawXLabels(frame, centres, groups);
  series.forEach((item, seriesIndex) => {
    drawSeriesBars(frame, {
      series, seriesIndex, numbers, count, centres, barWidth, yScale, colour: colours[seriesIndex],
    });
  });
  drawAxisTitles(frame, options.xAxisTitle, options.yAxisTitle);
  return frame.svg;
}

/**
 * Grouped bar chart with an error bar from low to high on each bar.
 * Returns { update(nextOptions), destroy() }.
 */
export function barErrorChart(host, options) {
  return createChart(host, { build: buildBars, toNumbers: barNumbers, enter: "grow" }, options);
}
