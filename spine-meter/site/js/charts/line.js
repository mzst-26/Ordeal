// Line-and-band chart: one line per series, a shaded band from lows to highs, and a marker at each value.
// A missing or NaN value leaves a gap: no marker is drawn for it, and the line stops before it.
import {
  linearScale, bandPath, formatTick, packSeries, seriesBlocks, validRuns, axisTicks, topOf, roundPx,
} from "./scale.js";
import {
  svgElement, svgText, seriesColours, legendFor, labelFor, startFrame, drawValueAxis, drawBaseline,
  drawXLabels, drawAxisTitles, createChart, DASH_PATTERN,
} from "./draw.js";

const LINE_HEIGHT = 300;
const MARKER_RADIUS = 4;
const BAND_OPACITY = 0.2;

/** Number of x positions a line chart needs: the longest of the labels and the series. */
function pointCount(labels, seriesList) {
  const lengths = [(labels || []).length];
  for (const item of seriesList) {
    lengths.push((item.values || []).length);
  }
  return Math.max(...lengths);
}

/** x positions for count points spread evenly from the left edge to the right edge of the plot. */
function spreadAcross(count, plot) {
  const scale = linearScale(0, Math.max(count - 1, 1), plot.left, plot.right);
  return Array.from({ length: count }, (_, index) => scale(index));
}

/** Turns points into the "x,y x,y" form that a polyline expects. */
function pointsAttribute(points) {
  return points.map((point) => `${roundPx(point.x)},${roundPx(point.y)}`).join(" ");
}

/** Length of the line through the points. It sizes the draw-in dash. */
function polylineLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const dx = points[index].x - points[index - 1].x;
    const dy = points[index].y - points[index - 1].y;
    total += Math.hypot(dx, dy);
  }
  return total;
}

/** Makes a polyline with the house stroke: 1.5px, round joins. */
function polylineFor(points, colour) {
  return svgElement("polyline", {
    points: pointsAttribute(points),
    fill: "none",
    stroke: colour,
    "stroke-width": 1.5,
    "stroke-linejoin": "round",
    "stroke-linecap": "round",
  });
}

/**
 * Sets the dash of one line. While it draws in from the left, the dash is as long as the line and its
 * offset moves back to 0. Once drawn, a dashed series gets the dash pattern.
 */
function applyLineStyle(line, length, reveal, dashed) {
  if (reveal < 1 && length > 0) {
    line.setAttribute("stroke-dasharray", `${length} ${length}`);
    line.setAttribute("stroke-dashoffset", String(length * (1 - reveal)));
  } else if (dashed) {
    line.setAttribute("stroke-dasharray", DASH_PATTERN);
  }
}

/** Picks the items at the given indexes, in order. */
function pick(items, indexes) {
  return indexes.map((index) => items[index]);
}

/** Draws the shaded band for each run of points that has both a low and a high bound. */
function drawBands(frame, xs, yScale, blocks, colour, reveal) {
  const lowY = blocks.lows.map((value) => yScale(value));
  const highY = blocks.highs.map((value) => yScale(value));
  const hasBounds = blocks.lows.map((low, index) => Number.isFinite(low) && Number.isFinite(blocks.highs[index]));
  for (const run of validRuns(hasBounds)) {
    const d = bandPath(pick(xs, run), pick(lowY, run), pick(highY, run));
    frame.svg.appendChild(svgElement("path", {
      d, fill: colour, "fill-opacity": BAND_OPACITY * reveal, stroke: "none",
    }));
  }
}

/** Draws the line, as one polyline for each run of points with a value. The gaps are left empty. */
function drawLines(frame, drawing) {
  const { xs, yScale, blocks, colour, reveal, dashed } = drawing;
  const hasValue = blocks.values.map((value) => Number.isFinite(value));
  for (const run of validRuns(hasValue)) {
    const points = run.map((index) => ({ x: xs[index], y: yScale(blocks.values[index]) }));
    const line = polylineFor(points, colour);
    applyLineStyle(line, polylineLength(points), reveal, dashed);
    frame.svg.appendChild(line);
  }
}

/** Draws a marker, and its value label when the chart is not narrow, at each point that has a value. */
function drawMarkers(frame, xs, yScale, blocks, colour) {
  const { svg, theme, narrow } = frame;
  blocks.values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      return;
    }
    const x = xs[index];
    const y = yScale(value);
    svg.appendChild(svgElement("circle", {
      cx: x, cy: y, r: MARKER_RADIUS, fill: colour, stroke: theme.paper, "stroke-width": 1.5,
    }));
    if (!narrow) {
      svg.appendChild(svgText(formatTick(value), {
        x, y: y - 10, "text-anchor": "middle", "font-family": theme.sans, "font-size": 12, fill: theme.inkSoft,
      }));
    }
  });
}

/** Draws one series of a line chart: the bands, the lines, then the markers and value labels. */
function drawLineSeries(frame, drawing) {
  const { xs, yScale, colour, blocks, reveal } = drawing;
  drawBands(frame, xs, yScale, blocks, colour, reveal);
  drawLines(frame, drawing);
  if (reveal >= 1) {
    drawMarkers(frame, xs, yScale, blocks, colour);
  }
}

/** Packed numbers for the line chart: values, lows and highs for each series. */
function lineNumbers(options) {
  const series = options.series || [];
  return packSeries(series, pointCount(options.xLabels, series));
}

/** Draws the line-and-band chart. reveal (0 to 1) is how far the lines have drawn in. */
function buildLineBand(host, options, numbers, reveal) {
  const series = options.series || [];
  const count = pointCount(options.xLabels, series);
  const colours = seriesColours(host, series);
  const frame = startFrame(host, {
    height: LINE_HEIGHT,
    title: options.title,
    yTitle: options.yAxisTitle,
    legend: legendFor(series, colours),
    label: labelFor(host, options),
  });
  const ticks = axisTicks(options.yMax, frame.narrow ? 3 : 5);
  const yScale = linearScale(0, topOf(ticks), frame.plot.bottom, frame.plot.top);
  const xs = spreadAcross(count, frame.plot);
  drawValueAxis(frame, ticks, yScale);
  drawBaseline(frame);
  drawXLabels(frame, xs, options.xLabels || []);
  drawAxisTitles(frame, options.xAxisTitle, options.yAxisTitle);
  series.forEach((item, index) => {
    drawLineSeries(frame, {
      xs, yScale, colour: colours[index], blocks: seriesBlocks(numbers, index, count), reveal,
      dashed: item.dashed === true,
    });
  });
  return frame.svg;
}

/**
 * Line chart: one line per series, with a shaded band from lows to highs and a marker at each value.
 * Returns { update(nextOptions), destroy() }.
 */
export function lineBandChart(host, options) {
  return createChart(host, { build: buildLineBand, toNumbers: lineNumbers, enter: "dash" }, options);
}
