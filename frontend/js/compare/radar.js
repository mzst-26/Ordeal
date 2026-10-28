// A pure SVG radar. radarSvg({axes, series, size, label}) returns an <svg> element.
// Values run from 0 (centre) to 1 (outer ring). A null value leaves a gap in its series.
// Spoke labels wrap onto short lines. The viewBox is widened and heightened by the measured label room,
// so no label is clipped at the edge. `size` is the diameter of the ring, not of the whole SVG.
// Colours and label fonts are tokens, set through element.style (never as style attributes).

const SVG_NS = "http://www.w3.org/2000/svg";
// DEFAULT_SIZE is the svg width and height in px. LABEL_ROOM is the share of the size kept free around the
// ring for spoke labels. LABEL_OFFSET is the gap in px between the outer ring and a label.
const DEFAULT_SIZE = 220;
const WRAP_CHARS = 10;
// Estimated width of one glyph at --size-xs (12px) in the sans face, and the height of one line.
const CHAR_WIDTH = 6.6;
const LINE_HEIGHT = 14;
const LABEL_OFFSET = 8;
const MARGIN = 6;
const MARKER_RADIUS = 2.5;
const FILL_OPACITY = "0.18";
const STROKE_WIDTH = "2";

/** Creates an SVG element with attributes. */
function svgNode(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

/** Sets a CSS property on an SVG node through the CSSOM. */
function paint(node, property, value) {
  node.style.setProperty(property, value);
}

/** The angle of the i-th of n spokes, starting at 12 o'clock and running clockwise. */
function angleFor(index, count) {
  return -Math.PI / 2 + (2 * Math.PI * index) / count;
}

/** Clamps a flip rate to the 0 to 1 range the radar draws. */
function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

/** A label's anchor, chosen by which side of the centre the spoke points to. */
function anchorFor(cos) {
  if (cos > 0.2) {
    return "start";
  }
  if (cos < -0.2) {
    return "end";
  }
  return "middle";
}

/** Splits a label into lines of about WRAP_CHARS characters, breaking only between words. */
function wrapLabel(text) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > WRAP_CHARS) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines.length > 0 ? lines : [""];
}

/** Path data for each run of drawn (non-null) points in one series. */
function runsOf(points) {
  const runs = [];
  let current = [];
  for (const point of points) {
    if (point === null) {
      if (current.length > 0) {
        runs.push(current);
      }
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length > 0) {
    runs.push(current);
  }
  return runs;
}

/**
 * Builds the radar. `axes` is [{id, label}] (short, label or id is shown on the spoke). `series` is
 * [{name, values: {id: number|null}, colour, fill}]. Each series has a <title> for hover and screen readers.
 */
export function radarSvg({ axes = [], series = [], size = DEFAULT_SIZE, label = "Radar chart" } = {}) {
  const count = axes.length;
  const labelLines = axes.map((axis) => wrapLabel(axis.short || axis.label || axis.id));
  // The room the labels need: the widest line, and the most lines, on any side of the ring.
  const widest = Math.max(0, ...labelLines.map((lines) => Math.max(...lines.map((line) => line.length))));
  const tallest = Math.max(1, ...labelLines.map((lines) => lines.length));
  const padX = widest * CHAR_WIDTH + LABEL_OFFSET + MARGIN;
  const padY = tallest * LINE_HEIGHT + LABEL_OFFSET + MARGIN;
  const radius = size / 2;
  const width = size + 2 * padX;
  const height = size + 2 * padY;
  const cx = width / 2;
  const cy = height / 2;

  const svg = svgNode("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": label,
    focusable: "false",
    class: "radar-svg",
  });

  // Two guide rings: the dashed one at 0.5 and the solid outer one at 1.
  for (const ring of [0.5, 1]) {
    const circle = svgNode("circle", {
      cx,
      cy,
      r: radius * ring,
      fill: "none",
      "stroke-width": "1",
    });
    if (ring === 0.5) {
      circle.setAttribute("stroke-dasharray", "3 3");
    }
    paint(circle, "stroke", "var(--rule)");
    svg.append(circle);
  }

  // One spoke and one label for each axis.
  axes.forEach((axis, index) => {
    const angle = angleFor(index, count);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const spoke = svgNode("line", {
      x1: cx,
      y1: cy,
      x2: cx + radius * cos,
      y2: cy + radius * sin,
      "stroke-width": "1",
    });
    paint(spoke, "stroke", "var(--rule)");
    svg.append(spoke);

    const lines = labelLines[index];
    const anchorX = cx + (radius + LABEL_OFFSET) * cos;
    const anchorY = cy + (radius + LABEL_OFFSET) * sin;
    const text = svgNode("text", { "text-anchor": anchorFor(cos) });
    paint(text, "font-size", "var(--size-xs)");
    paint(text, "font-family", "var(--font-sans)");
    paint(text, "fill", "var(--ink-soft)");
    lines.forEach((line, lineIndex) => {
      const tspan = svgNode("tspan", {
        x: anchorX,
        y: anchorY + (lineIndex - (lines.length - 1) / 2) * LINE_HEIGHT,
        "dominant-baseline": "middle",
      });
      tspan.textContent = line;
      text.append(tspan);
    });
    svg.append(text);
  });

  for (const entry of series) {
    const group = svgNode("g");
    const title = svgNode("title");
    title.textContent = `${entry.name}`;
    group.append(title);

    // One point per axis, or null where the series has no number for that axis (a gap, never zero).
    const points = axes.map((axis, index) => {
      const value = entry.values ? entry.values[axis.id] : null;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
      }
      const r = radius * clampUnit(value);
      const angle = angleFor(index, count);
      return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
    });

    for (const run of runsOf(points)) {
      // A single point has no line to draw, so it gets a dot.
      if (run.length === 1) {
        const dot = svgNode("circle", { cx: run[0].x, cy: run[0].y, r: MARKER_RADIUS });
        paint(dot, "fill", entry.colour);
        group.append(dot);
        continue;
      }
      const d = run.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
      // Only a run that covers every axis is closed into a filled shape. A run with gaps stays an open line.
      const closed = run.length === count && entry.fill === true;
      const path = svgNode("path", {
        d: closed ? `${d} Z` : d,
        "stroke-width": STROKE_WIDTH,
        "stroke-linejoin": "round",
        "fill-opacity": entry.fill === true ? FILL_OPACITY : "0",
      });
      paint(path, "stroke", entry.colour);
      paint(path, "fill", entry.fill === true ? entry.colour : "none");
      group.append(path);
    }
    svg.append(group);
  }
  return svg;
}
