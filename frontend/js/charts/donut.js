// Donut chart: a ring of slices, a centre label, and one legend row per segment.
// A segment with a missing or NaN value draws no slice, and its row says "no data".
import { cleanNumber, roundPx, formatTick } from "./scale.js";
import {
  svgElement, svgText, seriesColours, labelFor, measureWidth, readTheme, createSvg, createChart, addTitle,
} from "./draw.js";

const TWO_PI = Math.PI * 2;
// Largest ring diameter in px, and the height of one legend row in px.
const DONUT_RING_MAX = 240;
const DONUT_ROW_HEIGHT = 24;
// Inner radius as a fraction of the outer radius (the size of the hole).
const DONUT_HOLE_RATIO = 0.62;
// Width in px of the visible gap left between two neighbouring slices.
const SEGMENT_GAP_PX = 2;

/** A segment's value: negative becomes 0, and a missing or NaN value stays NaN. */
function segmentValue(segment) {
  return Math.max(0, cleanNumber(segment.value));
}

/** Total of the segment values. Missing and NaN values count as 0. */
function segmentTotal(segments) {
  return segments.reduce((sum, segment) => {
    const value = segmentValue(segment);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

/** A segment's share of the whole (0 to 1). A NaN value gives a NaN share, which draws nothing. */
function shareOf(value, total) {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  return total > 0 ? value / total : 0;
}

/** Each segment's share of the whole (0 to 1). The shares are what the donut animates. */
function donutNumbers(options) {
  const segments = options.segments || [];
  const total = segmentTotal(segments);
  return segments.map((segment) => shareOf(segmentValue(segment), total));
}

/** Point on a circle, with angles in radians measured clockwise from 12 o'clock. */
function polarPoint(cx, cy, radius, angle) {
  const x = cx + radius * Math.sin(angle);
  const y = cy - radius * Math.cos(angle);
  return `${roundPx(x)} ${roundPx(y)}`;
}

/** Path for one ring slice between two angles, with a small gap on each side. */
function ringSlicePath(ring, startAngle, endAngle) {
  // Half the gap, as an angle: arc length divided by radius gives radians. It is worked out on the outer edge.
  const gap = SEGMENT_GAP_PX / ring.outer / 2;
  const start = startAngle + gap;
  const end = endAngle - gap;
  if (end <= start) {
    return "";
  }
  // The SVG arc flag that picks the long way round when the slice is more than half the ring.
  const largeArc = end - start > Math.PI ? 1 : 0;
  return [
    `M ${polarPoint(ring.cx, ring.cy, ring.outer, start)}`,
    `A ${ring.outer} ${ring.outer} 0 ${largeArc} 1 ${polarPoint(ring.cx, ring.cy, ring.outer, end)}`,
    `L ${polarPoint(ring.cx, ring.cy, ring.inner, end)}`,
    `A ${ring.inner} ${ring.inner} 0 ${largeArc} 0 ${polarPoint(ring.cx, ring.cy, ring.inner, start)}`,
    "Z",
  ].join(" ");
}

/** Draws the ring slices. The shares accumulate, so the ring sweeps round as they grow. */
function drawSlices(svg, ring, shares, colours, segments) {
  let cumulative = 0;
  shares.forEach((share, index) => {
    if (!Number.isFinite(share) || share <= 0) {
      return;
    }
    const startAngle = cumulative * TWO_PI;
    cumulative += share;
    const path = ringSlicePath(ring, startAngle, cumulative * TWO_PI);
    if (path) {
      // The hover label names the segment and its value.
      svg.appendChild(addTitle(svgElement("path", { d: path, fill: colours[index] }), `${segments[index].label}: ${formatTick(segments[index].value)}`));
    }
  });
}

/** The text that says a segment's value: "12 (40%)", or "no data" when the value is missing. */
function valueTextFor(value, total) {
  if (!Number.isFinite(value)) {
    return "no data";
  }
  return `${formatTick(value)} (${percentOf(value, total)}%)`;
}

/** Draws one legend row for a donut segment. The value and share are text, not colour alone. */
function drawDonutRow(svg, theme, row) {
  const baseline = row.top + 14;
  svg.appendChild(svgElement("rect", {
    x: 16, y: baseline - 10, width: 12, height: 12, rx: 2, fill: row.colour,
  }));
  svg.appendChild(svgText(row.label, {
    x: 36, y: baseline, "font-family": theme.sans, "font-size": 14, fill: theme.ink,
  }));
  svg.appendChild(svgText(row.valueText, {
    x: row.right, y: baseline, "text-anchor": "end", "font-family": theme.sans, "font-size": 14, fill: theme.inkSoft,
  }));
}

/** Whole-number percentage of the total. Returns 0 when the total is 0. */
function percentOf(value, total) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

/** Draws the legend row for each segment, under the ring. */
function drawRows(svg, theme, segments, colours, rowsTop, width) {
  const total = segmentTotal(segments);
  segments.forEach((segment, index) => {
    drawDonutRow(svg, theme, {
      top: rowsTop + index * DONUT_ROW_HEIGHT,
      colour: colours[index],
      label: String(segment.label || ""),
      valueText: valueTextFor(segmentValue(segment), total),
      right: width - 16,
    });
  });
}

/** Draws the donut, its centre label, and one legend row per segment. */
function buildDonut(host, options, shares) {
  const segments = options.segments || [];
  const width = measureWidth(host);
  const theme = readTheme(host);
  const ringSize = Math.min(DONUT_RING_MAX, width - 32);
  const outer = ringSize / 2;
  const ring = { cx: width / 2, cy: 8 + outer, outer, inner: outer * DONUT_HOLE_RATIO };
  const rowsTop = 8 + ringSize + 24;
  const height = rowsTop + segments.length * DONUT_ROW_HEIGHT + 8;
  const svg = createSvg(width, height, labelFor(host, options));
  const colours = seriesColours(host, segments);
  drawSlices(svg, ring, shares, colours, segments);
  if (options.centreLabel) {
    svg.appendChild(svgText(options.centreLabel, {
      x: ring.cx, y: ring.cy + 6, "text-anchor": "middle", "font-family": theme.serif,
      "font-size": 22, fill: theme.ink,
    }));
  }
  drawRows(svg, theme, segments, colours, rowsTop, width);
  return svg;
}

/**
 * Donut chart with a centre label and a legend row per segment.
 * Returns { update(nextOptions), destroy() }.
 */
export function donutChart(host, options) {
  return createChart(host, { build: buildDonut, toNumbers: donutNumbers, enter: "grow" }, options);
}
