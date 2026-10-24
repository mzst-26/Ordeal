// A pure SVG radar. radarSvg({axes, series, size, label}) returns an <svg> element.
// Values run from 0 (centre) to 1 (outer ring). A null value leaves a gap in its series.
// Colours are CSS values (tokens), set through element.style, never as style attributes.

const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_SIZE = 220;
const LABEL_ROOM = 0.26;
const LABEL_OFFSET = 8;
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
 * Builds the radar. `axes` is [{id, label}] (label, short or id is shown on the spoke). `series` is
 * [{name, values: {id: number|null}, colour, fill}]. Each series has a <title> for hover and screen readers.
 */
export function radarSvg({ axes = [], series = [], size = DEFAULT_SIZE, label = "Radar chart" } = {}) {
  const svg = svgNode("svg", {
    viewBox: `0 0 ${size} ${size}`,
    role: "img",
    "aria-label": label,
    focusable: "false",
  });
  const centre = size / 2;
  const radius = centre - size * LABEL_ROOM * 0.5;
  const count = axes.length;

  for (const ring of [0.5, 1]) {
    const circle = svgNode("circle", {
      cx: centre,
      cy: centre,
      r: radius * ring,
      fill: "none",
      "stroke-width": "1",
      "stroke-dasharray": ring === 0.5 ? "3 3" : "",
    });
    paint(circle, "stroke", "var(--rule)");
    svg.append(circle);
  }

  axes.forEach((axis, index) => {
    const angle = angleFor(index, count);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const spoke = svgNode("line", {
      x1: centre,
      y1: centre,
      x2: centre + radius * cos,
      y2: centre + radius * sin,
      "stroke-width": "1",
    });
    paint(spoke, "stroke", "var(--rule)");
    svg.append(spoke);

    const text = svgNode("text", {
      x: centre + (radius + LABEL_OFFSET) * cos,
      y: centre + (radius + LABEL_OFFSET) * sin,
      "text-anchor": anchorFor(cos),
      "dominant-baseline": "middle",
    });
    // Spoke labels use --size-xs (12px), the nearest token to the 11px they had before.
    paint(text, "font-size", "var(--size-xs)");
    paint(text, "font-family", "var(--font-sans)");
    paint(text, "fill", "var(--ink-soft)");
    text.textContent = String(axis.short || axis.label || axis.id);
    svg.append(text);
  });

  for (const entry of series) {
    const group = svgNode("g");
    const title = svgNode("title");
    title.textContent = `${entry.name}`;
    group.append(title);

    const points = axes.map((axis, index) => {
      const value = entry.values ? entry.values[axis.id] : null;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
      }
      const r = radius * clampUnit(value);
      const angle = angleFor(index, count);
      return { x: centre + r * Math.cos(angle), y: centre + r * Math.sin(angle) };
    });

    for (const run of runsOf(points)) {
      if (run.length === 1) {
        const dot = svgNode("circle", { cx: run[0].x, cy: run[0].y, r: MARKER_RADIUS });
        paint(dot, "fill", entry.colour);
        group.append(dot);
        continue;
      }
      const d = run.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
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
