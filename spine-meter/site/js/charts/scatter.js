// Quadrant scatter on a 0 to 1 square, with dashed middle lines and corner labels.
// A point with a missing or NaN coordinate is left out: it draws no dot and no label.
import { linearScale, niceTicks, formatTick, clamp01 } from "./scale.js";
import {
  svgElement, svgText, resolveColour, labelFor, startFrame, drawValueAxis, drawBaseline, drawXLabels,
  drawAxisTitles, createChart, FADED_OPACITY,
} from "./draw.js";
import { cornerBoxes, cornerSpots, placeDotLabels } from "./labels.js";

// Chart height in px and dot radius in px.
const SCATTER_HEIGHT = 360;
const DOT_RADIUS = 5;

/** Flat x, y pairs for the scatter points, clamped to the square. A missing coordinate stays NaN. */
function scatterNumbers(options) {
  const numbers = [];
  for (const point of options.points || []) {
    numbers.push(clamp01(point.x), clamp01(point.y));
  }
  return numbers;
}

/**
 * The dots to draw: one per point that has both coordinates. labelGoesLeft is true when the dot sits
 * right of the middle line, so its label faces the middle of the plot.
 */
function dotsFor(host, points, numbers, scales, middle) {
  const dots = [];
  points.forEach((point, index) => {
    const x = numbers[index * 2];
    const y = numbers[index * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    dots.push({
      label: String(point.label || ""),
      colour: resolveColour(host, point.color),
      x: scales.x(x),
      y: scales.y(y),
      labelGoesLeft: x > middle,
      faded: point.faded === true,
    });
  });
  return dots;
}

/** Draws the dashed lines through the middle of the plot. */
function drawMidLines(frame, midX, midY) {
  const { svg, theme, plot } = frame;
  const dashed = { stroke: theme.edge, "stroke-width": 1, "stroke-dasharray": "4 4" };
  svg.appendChild(svgElement("line", { x1: midX, x2: midX, y1: plot.top, y2: plot.bottom, ...dashed }));
  svg.appendChild(svgElement("line", { x1: plot.left, x2: plot.right, y1: midY, y2: midY, ...dashed }));
}

/** Draws the four corner labels in small capitals. */
function drawCornerLabels(frame, names) {
  const { svg, theme, plot } = frame;
  for (const spot of cornerSpots(plot, names)) {
    svg.appendChild(svgText(String(spot.text).toUpperCase(), {
      x: spot.x,
      y: spot.y,
      "text-anchor": spot.anchor,
      "font-family": theme.sans,
      "font-size": 12,
      "letter-spacing": 1,
      fill: theme.inkMute,
    }));
  }
}

/** Draws one dot. */
function drawDot(frame, dot) {
  frame.svg.appendChild(svgElement("circle", {
    cx: dot.x, cy: dot.y, r: DOT_RADIUS, fill: dot.colour, stroke: frame.theme.paper, "stroke-width": 2,
    "fill-opacity": dot.faded ? FADED_OPACITY : 1,
  }));
}

/** Draws a dot's label at the spot chosen for it. Text stays in ink. */
function drawDotLabel(frame, dot) {
  frame.svg.appendChild(svgText(dot.label, {
    x: dot.spot.x,
    y: dot.spot.y,
    "text-anchor": dot.spot.anchor,
    "font-family": frame.theme.sans,
    "font-size": 13,
    fill: frame.theme.ink,
  }));
}

/** Draws the quadrant scatter. Each label picks a free spot, clear of the corner labels and other labels. */
function buildScatter(host, options, numbers) {
  const points = options.points || [];
  const frame = startFrame(host, {
    height: SCATTER_HEIGHT,
    title: options.title,
    yTitle: options.yTitle,
    legend: [],
    label: labelFor(host, options),
  });
  const { plot } = frame;
  const xScale = linearScale(0, 1, plot.left, plot.right);
  const yScale = linearScale(0, 1, plot.bottom, plot.top);
  const ticks = niceTicks(0, 1, frame.narrow ? 2 : 3);
  drawValueAxis(frame, ticks, yScale);
  drawXLabels(frame, ticks.map((tick) => xScale(tick)), ticks.map((tick) => formatTick(tick)));
  drawBaseline(frame);
  // Where the dashed middle lines cross, on the same 0 to 1 scale as the data. Defaults to the centre.
  const middle = Number.isFinite(options.midLines) ? options.midLines : 0.5;
  drawMidLines(frame, xScale(middle), yScale(middle));
  const names = options.quadrantLabels || {};
  drawCornerLabels(frame, names);
  const dots = dotsFor(host, points, numbers, { x: xScale, y: yScale }, middle);
  placeDotLabels(dots, plot, cornerBoxes(plot, names));
  // Dots first, then labels, so a label is never covered by a dot.
  dots.forEach((dot) => drawDot(frame, dot));
  dots.forEach((dot) => drawDotLabel(frame, dot));
  drawAxisTitles(frame, options.xTitle, options.yTitle);
  return frame.svg;
}

/**
 * Scatter chart on a 0 to 1 square, with dashed middle lines and corner labels.
 * Returns { update(nextOptions), destroy() }.
 */
export function scatterQuadrant(host, options) {
  return createChart(host, { build: buildScatter, toNumbers: scatterNumbers, enter: "none" }, options);
}
