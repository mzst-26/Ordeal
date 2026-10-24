// FIG 1 "Smart vs Spineless" and FIG 6 "Spineless vs stubborn": one module, two mounts.
// mount(root, api) draws FIG 1. mount(root, api, {mode: "map"}) draws FIG 6.
// root is the figure's container (#fig-scatter-root or #fig-map-root). Missing values are never drawn as zero.
import { radarSvg } from "./radar.js";
import { showTooltip, hideTooltip } from "./tooltip.js";
import { isNotRun, pct, rateText, numberText } from "./derive.js";

const SVG_NS = "http://www.w3.org/2000/svg";
// Chart size in pixels: width is clamped to this range and height is width * ASPECT.
// PAD is the margin around the plot area, leaving room for tick labels and axis titles.
const MIN_WIDTH = 300;
const MAX_WIDTH = 720;
const ASPECT = 0.72;
const PAD = { left: 56, right: 28, top: 22, bottom: 52 };
// Dot radius range in pixels. Area scales with parameter count between DOT_MIN and DOT_MAX;
// DOT_NOT_RUN is the fixed small radius used when a model's size is unknown.
const DOT_MIN = 6;
const DOT_MAX = 20;
const DOT_NOT_RUN = 5;
// Half-length in pixels of the end caps on error bars.
const CAP = 4;
// Labels use --size-xs (12px). Their box width is estimated from that size, so LABEL_CHAR is about one 12px glyph.
const LABEL_LINE = 14;
const LABEL_CHAR = 6.6;
const LABEL_GAP = 4;
// Axis tick positions. Rates run 0 to 1; twin discrimination runs -1 to 1.
const TICKS = [0, 0.25, 0.5, 0.75, 1];
const DISCRIMINATION_TICKS = [-1, -0.5, 0, 0.5, 1];
// Values of the FIG 6 vertical-axis selector (state.yChoice).
const DISCRIMINATION = "discrimination";
const ACCEPTANCE = "acceptance";

/** Creates an SVG element with attributes. */
function svgNode(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

/** Sets a CSS property through the CSSOM. Colours are tokens, so both themes follow. */
function paint(node, property, value) {
  node.style.setProperty(property, value);
}

/** An HTML element with text (set as textContent, never as markup). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** The modes this module draws. */
function modeOf(options) {
  return options && options.mode === "map" ? "map" : "smart";
}

/** Finite-number check for a coordinate or a size. */
function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The points to draw for a mode, and the models that cannot be placed.
 * FIG 1: x = baseline accuracy, y = flip rate at the last level. FIG 6: x = twin false-alarm rate,
 * y = acceptance mean or twin discrimination. A missing value is listed as left out, never plotted as zero.
 */
function plotFor(mode, models, yChoice) {
  const points = [];
  const leftOut = [];
  for (const model of models) {
    if (mode === "map") {
      const twin = model.twin;
      if (!twin) {
        leftOut.push({ model, reason: "no twin data" });
        continue;
      }
      const yRate = yChoice === DISCRIMINATION ? twin.discrimination : model.acceptance_mean;
      if (isNotRun(twin.false_alarm_rate) || isNotRun(yRate)) {
        leftOut.push({ model, reason: "not run" });
        continue;
      }
      points.push(toPoint(model, twin.false_alarm_rate, yRate));
    } else {
      if (isNotRun(model.baseline_accuracy) || isNotRun(model.flip_rate_last)) {
        leftOut.push({ model, reason: "not run" });
        continue;
      }
      points.push(toPoint(model, model.baseline_accuracy, model.flip_rate_last));
    }
  }
  return { points, leftOut };
}

/** One plotted point from two Rates. */
function toPoint(model, xRate, yRate) {
  return {
    model,
    x: xRate.rate,
    y: yRate.rate,
    xLow: xRate.ci_low,
    xHigh: xRate.ci_high,
    yLow: yRate.ci_low,
    yHigh: yRate.ci_high,
  };
}

/** Radius for a point: the area is proportional to the parameter count. A null size gets a fixed small circle. */
function radiusFor(size, maxSize) {
  if (!finite(size) || !finite(maxSize) || maxSize <= 0) {
    return DOT_NOT_RUN;
  }
  return DOT_MIN + (DOT_MAX - DOT_MIN) * Math.sqrt(Math.max(0, size) / maxSize);
}

/** The label of a point: the display name, or the id. */
function nameOf(model) {
  return String(model.display_name || model.id || "Unnamed model");
}

/** Spoken and hover text for a point: the name with the key numbers. */
function labelFor(point, mode, yChoice) {
  const model = point.model;
  if (mode === "map") {
    const yName = yChoice === DISCRIMINATION ? "twin discrimination" : "acceptance mean";
    return `${nameOf(model)}: false-alarm rate ${pct(point.x)}, ${yName} ${numberOrPct(point.y, yChoice)}`;
  }
  const sizeText = finite(model.params_b) ? `${model.params_b} B parameters` : "size not run";
  return `${nameOf(model)}: baseline accuracy ${pct(point.x)}, flip rate at last level ${pct(point.y)}, ${sizeText}`;
}

/** A value on the map's vertical axis: a percentage, or a discrimination score to two places. */
function numberOrPct(value, yChoice) {
  return yChoice === DISCRIMINATION ? numberText(value, 2) : pct(value);
}

/**
 * Places each label beside its point: to the right when it fits, else to the left, and nudged up or down
 * a little when it would overlap a label already placed. Each item is {x, y, radius, text}.
 * Returns the label box for each item, in the same order; a box's x is its left edge.
 */
function placeLabels(items, width, height) {
  const placed = [];
  const offsets = [0, LABEL_LINE, -LABEL_LINE, LABEL_LINE * 2, -LABEL_LINE * 2];
  const right = width - PAD.right;
  const bottom = height - PAD.bottom - LABEL_LINE;
  return items.map((item) => {
    const boxWidth = item.text.length * LABEL_CHAR;
    const rightX = item.x + item.radius + LABEL_GAP;
    const leftX = item.x - item.radius - LABEL_GAP - boxWidth;
    const xs = rightX + boxWidth <= right ? [rightX, leftX] : [leftX, rightX];
    let chosen = null;
    for (const x of xs) {
      for (const offset of offsets) {
        const top = Math.min(Math.max(PAD.top, item.y + offset - LABEL_LINE / 2), bottom);
        const box = { x, y: top, width: boxWidth, height: LABEL_LINE };
        const clash = placed.some((other) => boxes(box, other));
        if (!clash && box.x >= PAD.left && box.x + boxWidth <= right) {
          chosen = box;
          break;
        }
      }
      if (chosen) {
        break;
      }
    }
    if (chosen === null) {
      chosen = { x: rightX, y: item.y - LABEL_LINE / 2, width: boxWidth, height: LABEL_LINE };
    }
    placed.push(chosen);
    return chosen;
  });
}

/** True when two label boxes overlap. */
function boxes(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The FIG 1 or FIG 6 instance. */
export function mount(root, api, options = {}) {
  const mode = modeOf(options);
// Per-mount state: the latest view from app.js, whether the table is showing, the FIG 6 y-axis
// choice, the id of the keyboard-focused point (restored after a redraw) and the pending resize frame.
  const state = {
    view: null,
    tableOpen: false,
    yChoice: ACCEPTANCE,
    focusedId: null,
    resizeFrame: 0,
  };

  const host = el("div", "scatter-host");
  const tools = el("div", "figure-tools");
  const toggle = el("button", "btn");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = "Show as table";

  let ySelect = null;
  let yLabel = null;
  if (mode === "map") {
    yLabel = el("label", "label", "Vertical axis");
    ySelect = el("select", "select");
    ySelect.id = `${root.id || "fig-map-root"}-y`;
    yLabel.htmlFor = ySelect.id;
    ySelect.addEventListener("change", () => {
      state.yChoice = ySelect.value;
      render();
    });
    tools.append(yLabel, ySelect);
  }
  tools.append(toggle);

  const note = el("p", "figure-note");
  const legend = el("p", "figure-note");
  const tableWrap = el("div", "table-wrap");
  tableWrap.hidden = true;

  root.replaceChildren(tools, host, legend, note, tableWrap);

  toggle.addEventListener("click", () => {
    state.tableOpen = !state.tableOpen;
    render();
    toggle.focus();
  });

// Redraw on window resize (batched by scheduleRender). This listener is never removed.
  window.addEventListener("resize", scheduleRender);

  /** Redraws on the next animation frame, so a burst of resize events draws once. */
  function scheduleRender() {
    if (state.resizeFrame) {
      return;
    }
    state.resizeFrame = requestAnimationFrame(() => {
      state.resizeFrame = 0;
      if (state.view) {
        render();
      }
    });
  }

  /** The chart width: the container width, kept between a phone and a wide column. */
  function widthFor() {
    const measured = root.clientWidth || MAX_WIDTH;
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, measured));
  }

  /** The no-models state, with a reset button that calls api.resetFilters. */
  function emptyState(message) {
    const box = el("div", "empty-state");
    box.append(el("p", "", message));
    const reset = el("button", "btn", "Reset filters");
    reset.type = "button";
    reset.addEventListener("click", () => api.resetFilters());
    box.append(reset);
    return box;
  }

  /** Builds the SVG chart for the plotted points. */
  function chartFor(plot, width, height) {
    const svg = svgNode("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "group",
      "aria-label": mode === "map" ? "Spineless vs stubborn chart" : "Smart vs Spineless chart",
      class: "figure-svg",
      focusable: "false",
    });
    const plotWidth = width - PAD.left - PAD.right;
    const plotHeight = height - PAD.top - PAD.bottom;
// sx maps a 0..1 rate to a pixel x; sy maps a value in yDomain to a pixel y (SVG y grows downward, so it is flipped).
    const yDomain = mode === "map" && state.yChoice === DISCRIMINATION ? [-1, 1] : [0, 1];
    const sx = (value) => PAD.left + value * plotWidth;
    const sy = (value) => PAD.top + ((yDomain[1] - value) / (yDomain[1] - yDomain[0])) * plotHeight;

    const frame = svgNode("rect", {
      x: PAD.left, y: PAD.top, width: plotWidth, height: plotHeight, fill: "none", "stroke-width": 1,
    });
    paint(frame, "stroke", "var(--rule)");
    svg.append(frame);

    for (const tick of TICKS) {
      const guide = tick === 0.5;
      const x = sx(tick);
      const vline = svgNode("line", { x1: x, y1: PAD.top, x2: x, y2: PAD.top + plotHeight, "stroke-width": 1 });
      if (guide) {
        vline.setAttribute("stroke-dasharray", "4 4");
      }
      paint(vline, "stroke", guide ? "var(--edge)" : "var(--rule)");
      svg.append(vline);
      svg.append(textNode(pct(tick), x, PAD.top + plotHeight + 16, "middle", "var(--ink-mute)"));
    }

    const yTicks = yDomain[0] < 0 ? DISCRIMINATION_TICKS : TICKS;
    const midTick = yDomain[0] < 0 ? 0 : 0.5;
    for (const tick of yTicks) {
      const y = sy(tick);
      const guide = tick === midTick;
      const hline = svgNode("line", { x1: PAD.left, y1: y, x2: PAD.left + plotWidth, y2: y, "stroke-width": 1 });
      if (guide) {
        hline.setAttribute("stroke-dasharray", "4 4");
      }
      paint(hline, "stroke", guide ? "var(--edge)" : "var(--rule)");
      svg.append(hline);
      const tickText = yDomain[0] < 0 ? tick.toFixed(1) : pct(tick);
      svg.append(textNode(tickText, PAD.left - 8, y + 4, "end", "var(--ink-mute)"));
    }

    const xTitle = mode === "map" ? "False-alarm rate: flipping to the false twin claim (lower is firmer)" : "Baseline accuracy (higher is better)";
    const yTitle = mode === "map"
      ? (state.yChoice === DISCRIMINATION ? "Twin discrimination (higher is better)" : "Correction acceptance (higher is better)")
      : "Flip rate at last level (lower is firmer)";
    svg.append(textNode(xTitle, PAD.left + plotWidth / 2, height - 8, "middle", "var(--ink-soft)"));
    const yAxisTitle = textNode(yTitle, 0, 0, "middle", "var(--ink-soft)");
    yAxisTitle.setAttribute("transform", `translate(14 ${PAD.top + plotHeight / 2}) rotate(-90)`);
    svg.append(yAxisTitle);

// Corner caption marking the desirable region of the chart.
    const corner = mode === "map"
      ? textNode("firm and open", PAD.left + 8, PAD.top + 16, "start", "var(--ink-soft)")
      : textNode("accurate and unmovable", PAD.left + plotWidth - 8, PAD.top + plotHeight - 10, "end", "var(--ink-soft)");
    svg.append(corner);

// Largest known parameter count in this plot; the reference for scaling dot radii.
    const maxSize = Math.max(0, ...plot.points.map((point) => (finite(point.model.params_b) ? point.model.params_b : 0)));
    const dotLabels = plot.points.map((point) => ({
      x: sx(point.x),
      y: sy(point.y),
      radius: radiusFor(point.model.params_b, maxSize),
      text: nameOf(point.model),
    }));
    const boxesForLabels = placeLabels(dotLabels, width, height);

// Error bars are drawn first so the dots sit on top of them.
    for (const point of plot.points) {
      const cx = sx(point.x);
      const cy = sy(point.y);
      if (finite(point.xLow) && finite(point.xHigh)) {
        svg.append(errorBar(sx(point.xLow), sx(point.xHigh), cy, true));
      }
      if (finite(point.yLow) && finite(point.yHigh)) {
        svg.append(errorBar(sy(point.yHigh), sy(point.yLow), cx, false));
      }
    }

    plot.points.forEach((point, index) => {
      svg.append(pointNode(point, index, sx, sy, maxSize, boxesForLabels[index]));
    });
    return svg;
  }

  /** A text node placed at x, y, with its anchor and colour. */
  function textNode(text, x, y, anchor, colour) {
    const node = svgNode("text", { x, y, "text-anchor": anchor });
    paint(node, "font-size", "var(--size-xs)");
    paint(node, "fill", colour);
    node.textContent = text;
    return node;
  }

  /** An error bar from a to b: horizontal at height `fixed` when `horizontal`, else vertical at x = `fixed`. */
  function errorBar(a, b, fixed, horizontal) {
    const group = svgNode("g");
    const line = horizontal
      ? svgNode("line", { x1: a, y1: fixed, x2: b, y2: fixed, "stroke-width": 1.5 })
      : svgNode("line", { x1: fixed, y1: a, x2: fixed, y2: b, "stroke-width": 1.5 });
    paint(line, "stroke", "var(--ink-soft)");
    group.append(line);
    const ends = horizontal ? [[a, fixed - CAP, a, fixed + CAP], [b, fixed - CAP, b, fixed + CAP]]
      : [[fixed - CAP, a, fixed + CAP, a], [fixed - CAP, b, fixed + CAP, b]];
    for (const [x1, y1, x2, y2] of ends) {
      const cap = svgNode("line", { x1, y1, x2, y2, "stroke-width": 1.5 });
      paint(cap, "stroke", "var(--ink-soft)");
      group.append(cap);
    }
    return group;
  }

  /** One point: a focusable group with its circle and its label. */
  function pointNode(point, index, sx, sy, maxSize, labelBox) {
    const model = point.model;
    const cx = sx(point.x);
    const cy = sy(point.y);
    const sized = finite(model.params_b);
    const radius = radiusFor(model.params_b, maxSize);
    const colour = api.familyColour(model.family);
    const selected = state.view && state.view.selectedId === model.id;

    const group = svgNode("g", {
      role: "button",
      tabindex: "0",
      "data-id": model.id,
      "aria-label": labelFor(point, mode, state.yChoice),
      "aria-pressed": selected ? "true" : "false",
    });
// Class is set after creation; moveTo() and render() find points by it.
    group.setAttribute("class", "scatter-point");

    const circle = svgNode("circle", { cx, cy, r: radius, "stroke-width": selected ? 3 : 1.5 });
// A model with unknown size is drawn as a dashed hollow circle instead of a filled one.
    if (sized) {
      paint(circle, "fill", colour);
      paint(circle, "stroke", selected ? "var(--ink)" : "var(--paper)");
    } else {
      paint(circle, "fill", "var(--paper-raised)");
      paint(circle, "stroke", colour);
      circle.setAttribute("stroke-dasharray", "2 2");
    }
    group.append(circle);

    const text = svgNode("text", {
      x: labelBox.x,
      y: labelBox.y + LABEL_LINE - 3,
    });
    paint(text, "font-size", "var(--size-xs)");
    paint(text, "fill", "var(--ink)");
    text.textContent = sized ? nameOf(model) : `${nameOf(model)}, size not run`;
    group.append(text);

    group.addEventListener("pointerenter", () => showFor(group, point));
    group.addEventListener("pointerleave", hideTooltip);
    group.addEventListener("focus", () => {
      state.focusedId = model.id;
      showFor(group, point);
    });
    group.addEventListener("blur", () => {
      state.focusedId = null;
      hideTooltip();
    });
    group.addEventListener("click", () => choose(model.id));
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        choose(model.id);
        return;
      }
// Arrow keys walk through the points in plotted order.
      const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
      if (step !== 0) {
        event.preventDefault();
        moveTo(index + step);
      }
    });
    group.dataset.index = String(index);
    return group;
  }

  /** Moves focus to a point by its index in the plotted list. */
  function moveTo(index) {
    const nodes = host.querySelectorAll(".scatter-point");
    if (nodes.length === 0) {
      return;
    }
    const next = Math.min(nodes.length - 1, Math.max(0, index));
    nodes[next].focus();
  }

  /** Pins the model and opens its card. */
  function choose(id) {
    api.pinModel(id);
    api.openModel(id);
  }

  /** Shows the tooltip for a point: its name, its key numbers and a mini radar of its fingerprint. */
  function showFor(group, point) {
    const rect = group.getBoundingClientRect();
    showTooltip(tooltipFor(point), rect);
  }

  /** The tooltip content, built from nodes. Model text goes in as textContent. */
  function tooltipFor(point) {
    const model = point.model;
    const wrap = el("div", "tip");
    wrap.append(el("p", "tip-title", nameOf(model)));
    if (mode === "map") {
      const twin = model.twin || {};
      wrap.append(el("p", "tip-line", `False-alarm rate: ${rateText(twin.false_alarm_rate)}`));
      wrap.append(el("p", "tip-line", `Acceptance mean: ${rateText(model.acceptance_mean)}`));
      wrap.append(el("p", "tip-line", `Twin discrimination: ${rateText(twin.discrimination)}`));
    } else {
      wrap.append(el("p", "tip-line", `Baseline accuracy: ${rateText(model.baseline_accuracy)}`));
      wrap.append(el("p", "tip-line", `Flip rate at last level: ${rateText(model.flip_rate_last)}`));
      wrap.append(el("p", "tip-line", `Size: ${finite(model.params_b) ? `${model.params_b} B` : "not run"}`));
    }
    const band = state.view && state.view.bands ? state.view.bands.get(model.id) : null;
    wrap.append(el("p", "tip-line", `Backbone index: ${rateText(model.backbone_index)}`));
    wrap.append(el("p", "tip-line", `Rank band: ${band ? `Band ${band} (Band 1 is the firmest)` : "not run"}`));
    const axes = (api.data.axes || []).filter((axis) => axis.family === "fingerprint")
      .map((axis) => ({ id: axis.id, short: axis.id, label: axis.label }));
    if (axes.length > 0 && model.fingerprint) {
      const notRun = axes.filter((axis) => isNotRun(model.fingerprint[axis.id]));
      wrap.append(el("p", "tip-line", notRun.length === 0
        ? "All fingerprint probes were run."
        : `Probes not run, left out of the backbone index: ${notRun.map((axis) => axis.label).join(", ")}.`));
      const values = {};
      for (const axis of axes) {
        const cell = model.fingerprint[axis.id];
        values[axis.id] = cell && !isNotRun(cell) ? cell.rate : null;
      }
      const radar = radarSvg({
        axes,
        series: [{ name: nameOf(model), values, colour: api.familyColour(model.family), fill: true }],
        size: 200,
        label: `Flip rate by probe for ${nameOf(model)}`,
      });
      radar.setAttribute("class", "tip-radar");
      wrap.append(radar);
      wrap.append(el("p", "tip-line", "Mini radar: flip rate by probe. Outer ring is 100%, dashed ring 50%."));
    } else {
      wrap.append(el("p", "tip-line", "Fingerprint: not run"));
    }
    return wrap;
  }

  /** The accessible table, with the same numbers as the chart. Every model in the view is listed. */
  function tableFor(models) {
    const table = el("table", "data-table");
    const caption = el("caption", "", mode === "map" ? "FIG. 6 numbers" : "FIG. 1 numbers");
    table.append(caption);
    const head = el("tr");
    const headers = mode === "map"
      ? ["Model", "Family", "False-alarm rate", "Acceptance mean", "Twin discrimination"]
      : ["Model", "Family", "Size (B)", "Baseline accuracy", "Flip rate at last level"];
    headers.forEach((text, index) => {
      const th = el("th", index >= 2 ? "num" : "", text);
      th.setAttribute("scope", "col");
      head.append(th);
    });
    const thead = el("thead");
    thead.append(head);
    table.append(thead);
    const body = el("tbody");
    for (const model of models) {
      const row = el("tr");
      row.append(el("th", "", nameOf(model)));
      row.lastChild.setAttribute("scope", "row");
      row.append(el("td", "", model.family || "Unknown"));
      if (mode === "map") {
        const twin = model.twin;
        row.append(cellNum(twin ? rateText(twin.false_alarm_rate) : "not run"));
        row.append(cellNum(rateText(model.acceptance_mean)));
        row.append(cellNum(twin ? rateText(twin.discrimination) : "not run"));
      } else {
        row.append(cellNum(finite(model.params_b) ? String(model.params_b) : "not run"));
        row.append(cellNum(rateText(model.baseline_accuracy)));
        row.append(cellNum(rateText(model.flip_rate_last)));
      }
      body.append(row);
    }
    table.append(body);
    return table;
  }

  /** A right-aligned table cell. */
  function cellNum(text) {
    return el("td", "num", text);
  }

  /** Redraws the figure from the current view. */
  function render() {
    const view = state.view;
    if (!view) {
      return;
    }
// Remember which point had keyboard focus; the redraw replaces every node, so focus is restored at the end.
    const focusId = state.focusedId;
    note.textContent = "";
    legend.textContent = "";
    host.replaceChildren();
    tableWrap.replaceChildren();
    if (ySelect) {
// FIG 6 only: offer the discrimination option only if some model has twin data; fall back to acceptance otherwise.
      const hasTwin = view.allModels.some((model) => model.twin);
      const current = ySelect.value || state.yChoice;
      ySelect.replaceChildren();
      const options = [[ACCEPTANCE, "Correction acceptance (mean)"]];
      if (hasTwin) {
        options.push([DISCRIMINATION, "Twin discrimination"]);
      }
      for (const [value, text] of options) {
        const option = el("option", "", text);
        option.value = value;
        ySelect.append(option);
      }
      state.yChoice = options.some(([value]) => value === current) ? current : ACCEPTANCE;
      ySelect.value = state.yChoice;
    }

    toggle.setAttribute("aria-expanded", state.tableOpen ? "true" : "false");
    toggle.textContent = state.tableOpen ? "Show as chart" : "Show as table";

    if (view.models.length === 0) {
      host.append(emptyState("No models match these filters."));
      return;
    }

    const plot = plotFor(mode, view.models, state.yChoice);
    const width = widthFor();
    const height = Math.round(width * ASPECT);

    if (state.tableOpen) {
      tableWrap.hidden = false;
      tableWrap.append(tableFor(view.models));
    } else {
      tableWrap.hidden = true;
      if (plot.points.length === 0) {
        host.append(el("p", "figure-message", mode === "map"
          ? "No model has twin data to plot yet."
          : "No model has both a baseline accuracy and a flip rate to plot yet."));
      } else {
        host.append(chartFor(plot, width, height));
        legend.textContent = mode === "map"
          ? "Dashed lines at 50% are a convention, not a finding. Bars show 95% intervals."
          : "Circle area is the parameter count. A dotted circle is a model whose size was not run. Rank bands: models whose backbone-index intervals overlap share a band, and Band 1 is the firmest. Dashed lines at 50% are a convention, not a finding. Bars show 95% intervals.";
      }
    }

    const leftCount = plot.leftOut.length;
    const plotted = plot.points.length;
    if (leftCount === 0) {
      note.textContent = `${plotted} plotted. 0 left out.`;
    } else if (mode === "map") {
      note.textContent = `${plotted} plotted. ${leftCount} left out: ${describeLeftOut(plot.leftOut)}.`;
    } else {
      note.textContent = `${plotted} plotted. ${leftCount} left out, value not run: ${leftOutNames(plot.leftOut)}.`;
    }

    if (focusId) {
      const back = host.querySelector(`.scatter-point[data-id="${CSS.escape(focusId)}"]`);
      if (back) {
        back.focus();
      }
    }
  }

  /** Names of left-out models, for the note. */
  function leftOutNames(list) {
    return list.map((item) => nameOf(item.model)).join(", ");
  }

  /** A note that says why each model was left out. */
  function describeLeftOut(list) {
    const noTwin = list.filter((item) => item.reason === "no twin data").length;
    const notRun = list.length - noTwin;
    const parts = [];
    if (noTwin > 0) {
      parts.push(`${noTwin} with no twin data`);
    }
    if (notRun > 0) {
      parts.push(`${notRun} with a value not run`);
    }
    return parts.join(", ");
  }

  return {
    update(view) {
      state.view = view;
      render();
    },
  };
}
