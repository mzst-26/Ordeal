// Shared drawing helpers for the chart kit: svg elements, theme tokens, the frame with axes and legend,
// and createChart, the wiring that every chart uses to animate and redraw itself.
import { formatTick } from "./scale.js";
import { tweenNumbers } from "./animate.js";

const SVG_NS = "http://www.w3.org/2000/svg";
// Hosts narrower than NARROW_WIDTH count as narrow (fewer ticks, no value labels). MIN_WIDTH is the smallest
// width a chart is drawn at. FALLBACK_WIDTH is used when the host has no layout width yet (for example hidden).
const NARROW_WIDTH = 560;
const MIN_WIDTH = 240;
const FALLBACK_WIDTH = 640;
// Used when a CSS token cannot be read; a neutral grey that is visible on both themes.
const FALLBACK_COLOUR = "#808080";
const FALLBACK_SANS = "Helvetica Neue, Arial, sans-serif";
const FALLBACK_SERIF = "Georgia, serif";
// Animation lengths used when the --dur-slow / --dur-base tokens cannot be read.
const FALLBACK_ENTER_MS = 480;
const FALLBACK_UPDATE_MS = 240;
// Estimated width of one legend character in px, used to space legend items (text is not measured).
const LEGEND_CHAR_WIDTH = 7;
// Title lines: an average character width for the 18px serif title, the fewest characters per line,
// and the distance between two title lines, all in px.
const TITLE_CHAR_WIDTH = 11;
const MIN_TITLE_CHARS = 16;
const TITLE_LINE_HEIGHT = 22;
// The least horizontal room, in px, given to each x-axis label before labels are thinned out.
const TICK_LABEL_SPACING = 64;
// Rough width in px of one character of a 12px tick label, so long category names get more room.
const TICK_CHAR_WIDTH = 7;
// A repeat series (series 4 and later) is drawn with this fill opacity, and its lines with this dash.
export const FADED_OPACITY = 0.45;
export const DASH_PATTERN = "6 4";

/** Creates an SVG element and sets its attributes. */
export function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

/** Creates an SVG text element. The text goes in as textContent, never as markup. */
export function svgText(content, attributes = {}) {
  const element = svgElement("text", attributes);
  element.textContent = String(content);
  return element;
}

/**
 * Gives an SVG shape a hover label. A <title> child is shown by the browser when the pointer rests on the shape, so the
 * visitor can see which model a line, bar or dot belongs to. The text goes in as textContent, never as markup.
 */
export function addTitle(element, text) {
  const title = svgElement("title");
  title.textContent = String(text);
  element.appendChild(title);
  return element;
}

/** Reads one CSS token (a custom property) from the host. Returns the fallback when the token is empty. */
function readToken(host, name, fallback) {
  const value = globalThis.getComputedStyle(host).getPropertyValue(name).trim();
  return value || fallback;
}

/** Reads a duration token such as --dur-slow ("480ms") and returns milliseconds. */
export function readDuration(host, name, fallbackMs) {
  const value = parseFloat(readToken(host, name, ""));
  return Number.isFinite(value) ? value : fallbackMs;
}

/** Reads the text, rule and font tokens that every chart shares. */
export function readTheme(host) {
  return {
    ink: readToken(host, "--ink", FALLBACK_COLOUR),
    inkSoft: readToken(host, "--ink-soft", FALLBACK_COLOUR),
    inkMute: readToken(host, "--ink-mute", FALLBACK_COLOUR),
    rule: readToken(host, "--rule", FALLBACK_COLOUR),
    edge: readToken(host, "--edge", FALLBACK_COLOUR),
    paper: readToken(host, "--paper", FALLBACK_COLOUR),
    sans: readToken(host, "--font-sans", FALLBACK_SANS),
    serif: readToken(host, "--font-serif", FALLBACK_SERIF),
  };
}

/**
 * Resolves a colour option. It can be a token name ("terracotta"), a var(--token), a --token,
 * or any plain CSS colour.
 */
export function resolveColour(host, colour) {
  const text = String(colour || "").trim();
  if (!text) {
    return FALLBACK_COLOUR;
  }
  const variable = /^var\((--[\w-]+)\)$/.exec(text);
  if (variable) {
    return readToken(host, variable[1], FALLBACK_COLOUR);
  }
  if (/^--[\w-]+$/.test(text)) {
    return readToken(host, text, FALLBACK_COLOUR);
  }
  if (/^[a-z][a-z-]*$/i.test(text)) {
    return readToken(host, `--${text}`, text);
  }
  return text;
}

/** Colours for a list of series, resolved in order. */
export function seriesColours(host, seriesList) {
  return seriesList.map((item) => resolveColour(host, item.color));
}

/** The width of the host in px. It is used as the viewBox width, so text keeps its real size. */
export function measureWidth(host) {
  const width = host.clientWidth;
  if (width <= 0) {
    return FALLBACK_WIDTH;
  }
  return Math.max(width, MIN_WIDTH);
}

/** The accessible name: the ariaLabel option, else the host's aria-label, else the title. */
export function labelFor(host, options) {
  return options.ariaLabel || host.getAttribute("aria-label") || options.title || "Chart";
}

/** Creates the root svg. It fills the host width, and its height follows the viewBox. The CSS class does the sizing. */
export function createSvg(width, height, label) {
  return svgElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": label,
    class: "chart-svg",
  });
}

/** Attributes for tick labels: sans, 12px, muted ink. */
export function tickStyle(theme) {
  return { "font-family": theme.sans, "font-size": 12, fill: theme.inkMute };
}

/** The swatch for one legend item: a short dashed line for a dashed series, else a square (faded if repeat). */
function legendSwatch(item, x, baseline) {
  if (item.dashed) {
    return svgElement("line", {
      x1: x, x2: x + 10, y1: baseline - 5, y2: baseline - 5,
      stroke: item.colour, "stroke-width": 2, "stroke-dasharray": DASH_PATTERN,
    });
  }
  return svgElement("rect", {
    x, y: baseline - 10, width: 10, height: 10, rx: 2, fill: item.colour,
    "fill-opacity": item.faded ? FADED_OPACITY : 1,
  });
}

/** Draws one row of swatch and name pairs. Returns the y position below the row. */
function drawLegend(svg, theme, legend, top) {
  const baseline = top + 14;
  let x = 0;
  for (const item of legend) {
    const name = String(item.name || "");
    svg.appendChild(legendSwatch(item, x, baseline));
    svg.appendChild(svgText(name, {
      x: x + 16, y: baseline, "font-family": theme.sans, "font-size": 13, fill: theme.inkSoft,
    }));
    x += 16 + name.length * LEGEND_CHAR_WIDTH + 20;
  }
  return baseline + 8;
}

/** Splits a title into lines that fit the width, breaking at spaces. SVG text cannot wrap by itself. */
export function wrapTitle(title, width) {
  const maxChars = Math.max(MIN_TITLE_CHARS, Math.floor(width / TITLE_CHAR_WIDTH));
  const lines = [];
  let line = "";
  for (const word of String(title).split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}

/** Draws the title, on as many lines as it needs, and the legend row. Returns the y just below them. */
function drawHeader(svg, theme, title, legend, width) {
  let bottom = 0;
  if (title) {
    const lines = wrapTitle(title, width);
    lines.forEach((text, index) => {
      svg.appendChild(svgText(text, {
        x: 0, y: 18 + index * TITLE_LINE_HEIGHT, "font-family": theme.serif, "font-size": 18, fill: theme.ink,
      }));
    });
    bottom = 26 + (lines.length - 1) * TITLE_LINE_HEIGHT;
  }
  if (legend.length > 0) {
    bottom = drawLegend(svg, theme, legend, bottom);
  }
  return bottom;
}

/** Legend items for a chart: one per series, but only when there are two or more. */
export function legendFor(seriesList, colours) {
  if (seriesList.length < 2) {
    return [];
  }
  return seriesList.map((item, index) => ({
    name: item.name, colour: colours[index], dashed: item.dashed === true, faded: item.faded === true,
  }));
}

/**
 * Makes the svg frame for a chart with axes: the header (title and legend), then the plot box
 * where the chart body is drawn.
 */
export function startFrame(host, layout) {
  const width = measureWidth(host);
  const narrow = width < NARROW_WIDTH;
  const theme = readTheme(host);
  const svg = createSvg(width, layout.height, layout.label);
  const headerBottom = drawHeader(svg, theme, layout.title, layout.legend, width);
  // The left margin leaves room for the value labels (34px narrow, 40px wide), plus 20px more when
  // a rotated y-axis title is shown.
  const left = (layout.yTitle ? 28 : 8) + (narrow ? 34 : 40);
  const top = headerBottom + 8;
  // The bottom 48px hold the x-axis labels and the x-axis title. The right margin is 16px.
  const bottom = layout.height - 48;
  const plot = {
    left, right: width - 16, top, bottom, width: width - 16 - left, height: bottom - top,
  };
  return { svg, theme, narrow, plot, height: layout.height };
}

/** Draws horizontal gridlines with their value labels on the left. */
export function drawValueAxis(frame, ticks, yScale) {
  const { svg, theme, plot } = frame;
  for (const tick of ticks) {
    const y = yScale(tick);
    svg.appendChild(svgElement("line", {
      x1: plot.left, x2: plot.right, y1: y, y2: y, stroke: theme.rule, "stroke-width": 0.5,
    }));
    svg.appendChild(svgText(formatTick(tick), {
      x: plot.left - 8, y: y + 4, "text-anchor": "end", ...tickStyle(theme),
    }));
  }
}

/** Draws the solid line along the bottom of the plot. */
export function drawBaseline(frame) {
  const { svg, theme, plot } = frame;
  svg.appendChild(svgElement("line", {
    x1: plot.left, x2: plot.right, y1: plot.bottom, y2: plot.bottom, stroke: theme.edge, "stroke-width": 1,
  }));
}

/** Draws category labels under the plot. Labels are thinned out when there is no room for all of them. */
export function drawXLabels(frame, xs, labels) {
  const { svg, theme, plot } = frame;
  const longest = labels.reduce((most, label) => Math.max(most, String(label).length), 0);
  const spacing = Math.max(TICK_LABEL_SPACING, longest * TICK_CHAR_WIDTH);
  const maxLabels = Math.max(2, Math.floor(plot.width / spacing));
  const every = Math.ceil(xs.length / maxLabels);
  xs.forEach((x, index) => {
    if (index % every !== 0) {
      return;
    }
    svg.appendChild(svgText(labels[index] ?? "", {
      x, y: plot.bottom + 18, "text-anchor": "middle", ...tickStyle(theme),
    }));
  });
}

/** Draws an axis title in small capitals. The capitals are typed here, since SVG has no text-transform. */
export function drawAxisTitles(frame, xTitle, yTitle) {
  const { svg, theme, plot, height } = frame;
  const titleStyle = { "font-family": theme.sans, "font-size": 13, "letter-spacing": 1, fill: theme.inkSoft };
  if (xTitle) {
    svg.appendChild(svgText(String(xTitle).toUpperCase(), {
      ...titleStyle, x: plot.left + plot.width / 2, y: height - 8, "text-anchor": "middle",
    }));
  }
  if (yTitle) {
    const centreY = plot.top + plot.height / 2;
    svg.appendChild(svgText(String(yTitle).toUpperCase(), {
      ...titleStyle, x: 14, y: centreY, "text-anchor": "middle", transform: `rotate(-90 14 ${centreY})`,
    }));
  }
}

/** Draws the chart from the numbers. reveal goes from 0 to 1 while a line draws in. */
function paintChart(host, spec, options, numbers, reveal) {
  host.replaceChildren(spec.build(host, options, numbers, reveal));
}

/** The tween that runs on the first draw: lines draw in, bars grow, the rest appear. */
function startEnterTween(state, spec, target, enterMs) {
  // "dash": the numbers are final from the start and a 0 to 1 reveal value is tweened instead.
  // Any other value of spec.enter (the scatter uses "none") just shows the target at once.
  if (spec.enter === "dash") {
    state.shown = target;
    return tweenNumbers([0], [1], enterMs, ([progress]) => state.paint(target, progress), state.finish);
  }
  if (spec.enter === "grow") {
    const zeros = new Array(target.length).fill(0);
    return tweenNumbers(zeros, target, enterMs, state.show, state.finish);
  }
  state.show(target);
  return null;
}

/**
 * Shared wiring for every chart. It keeps the numbers on screen, tweens them when the options change
 * and rebuilds the svg on each frame. spec.build(host, options, numbers, reveal) returns the svg.
 * Returns { update(nextOptions), destroy() }.
 */
/** Stops the running tween, if there is one. */
function stopTween(state) {
  if (state.cancel) {
    state.cancel();
    state.cancel = null;
  }
}

/** Applies new options. The numbers tween from what is on screen to the new values. */
function updateChart(state, nextOptions) {
  if (state.destroyed) {
    return;
  }
  stopTween(state);
  state.options = nextOptions;
  const target = state.spec.toNumbers(state.options);
  if (state.shown === null) {
    state.cancel = startEnterTween(state, state.spec, target, state.enterMs);
  } else {
    state.cancel = tweenNumbers(state.shown, target, state.updateMs, state.show, state.finish);
  }
}

/** Redraws at the new width, so text keeps its size. */
function redrawChart(state) {
  if (!state.destroyed && state.shown !== null) {
    state.paint(state.shown, 1);
  }
}

/** Stops any animation, removes the resize listener and empties the host. */
function destroyChart(state, onResize) {
  state.destroyed = true;
  stopTween(state);
  globalThis.removeEventListener("resize", onResize);
  state.host.replaceChildren();
}

/** Makes the shared state for one chart: the host, its spec, the current options and the timings. */
function makeChartState(host, spec, options) {
  const state = {
    host,
    spec,
    options,
    shown: null,
    cancel: null,
    destroyed: false,
    enterMs: readDuration(host, "--dur-slow", FALLBACK_ENTER_MS),
    updateMs: readDuration(host, "--dur-base", FALLBACK_UPDATE_MS),
  };
  /** Draws the chart from the given numbers, with the current options. */
  state.paint = (numbers, reveal) => paintChart(host, spec, state.options, numbers, reveal);
  /** Shows a set of numbers as the settled chart. */
  state.show = (numbers) => {
    state.shown = numbers;
    state.paint(numbers, 1);
  };
  /** Forgets the running tween once it has finished. */
  state.finish = () => {
    state.cancel = null;
  };
  return state;
}

// Entry point used by every chart module. It builds the shared state, redraws on window resize, and
// starts the first draw through update(). See the comment above stopTween for what spec must provide.
export function createChart(host, spec, initialOptions) {
  const state = makeChartState(host, spec, initialOptions);
  const onResize = () => redrawChart(state);
  globalThis.addEventListener("resize", onResize);
  const update = (nextOptions) => updateChart(state, nextOptions);
  update(initialOptions);
  return { update, destroy: () => destroyChart(state, onResize) };
}
