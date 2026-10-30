// Tests for the chart kit: the pure maths in scale.js and labels.js, and what each chart draws.
// The charts draw into a host element, so the drawing tests run against a small fake DOM below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linearScale, niceTicks, pathFromPoints, bandPath, formatTick } from "../../frontend/js/charts/scale.js";
import * as chartKit from "../../frontend/js/charts/index.js";
import { seriesSlot, isRepeatSeries } from "../../frontend/js/results/chart-panel.js";
import { labelBox, placeDotLabels } from "../../frontend/js/charts/labels.js";

const { lineBandChart, chooseLabelSide, cornerBoxes } = chartKit;

/** A tiny stand-in for DOM nodes: the chart code only creates, sets, reads and appends them. */
class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = {};
    this.children = [];
    this.textContent = "";
    this.clientWidth = 0;
    // Like a browser, a style assignment would write a style attribute. The charts must never do this.
    this.style = new Proxy({}, {
      set: (_target, name, value) => {
        this.attributes.style = `${this.attributes.style || ""}${name}:${value};`;
        return true;
      },
    });
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...nodes) {
    this.children = nodes;
  }

  /** Every node below this one with the given tag name, in drawing order. */
  findAll(tagName) {
    const found = [];
    for (const child of this.children) {
      if (child.tagName === tagName) {
        found.push(child);
      }
      found.push(...child.findAll(tagName));
    }
    return found;
  }
}

// The charts ask the browser for these. Reduced motion makes every tween finish at once, so the
// drawing is complete as soon as a chart call returns.
globalThis.document = { createElementNS: (_namespace, tagName) => new FakeNode(tagName) };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
globalThis.matchMedia = () => ({ matches: true });
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

/** A host element of the given width, as a page would provide. */
function makeHost(width = 600) {
  const host = new FakeNode("div");
  host.clientWidth = width;
  return host;
}

/** The svg that a chart drew into the host. */
function drawn(host) {
  return host.children[0];
}

/** All attributes and text under a node, as one string. Used to check that NaN never reaches the markup. */
function markup(node) {
  return [JSON.stringify(node.attributes), node.textContent, ...node.children.map(markup)].join(" ");
}

/** The text of every svg text element, in drawing order. */
function textsOf(svg) {
  return svg.findAll("text").map((node) => node.textContent);
}

// Scale maths (scale.js): mapping values to pixels, picking round axis ticks, and building SVG path text.
test("linearScale maps the domain ends to the range ends", () => {
  const scale = linearScale(0, 10, 100, 200);
  assert.equal(scale(0), 100);
  assert.equal(scale(10), 200);
  assert.equal(scale(5), 150);
});

test("linearScale can flip the range, as a y axis does", () => {
  const scale = linearScale(0, 1, 300, 0);
  assert.equal(scale(0), 300);
  assert.equal(scale(1), 0);
});

test("linearScale with a zero-width domain returns the range start", () => {
  const scale = linearScale(4, 4, 10, 90);
  assert.equal(scale(4), 10);
});

test("niceTicks gives round ticks for a 0 to 1 domain, including 0 and 1", () => {
  assert.deepEqual(niceTicks(0, 1, 5), [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual(niceTicks(0, 1, 3), [0, 0.5, 1]);
});

test("niceTicks covers the whole range with round whole numbers", () => {
  assert.deepEqual(niceTicks(0, 87, 5), [0, 20, 40, 60, 80, 100]);
});

test("niceTicks handles an empty range and bad input", () => {
  assert.deepEqual(niceTicks(0, 0, 3), [0, 0.5, 1]);
  assert.deepEqual(niceTicks(Number.NaN, 1, 5), []);
});

test("pathFromPoints writes M then L commands with rounded coordinates", () => {
  assert.equal(pathFromPoints([{ x: 0, y: 1 }, { x: 2, y: 3 }]), "M 0 1 L 2 3");
  assert.equal(pathFromPoints([{ x: 1.234, y: 5.678 }]), "M 1.23 5.68");
  assert.equal(pathFromPoints([]), "");
});

test("bandPath is closed: it starts and ends at the same x and walks back along the low line", () => {
  const path = bandPath([0, 1, 2], [6, 4, 5], [10, 12, 11]);
  assert.equal(path, "M 0 10 L 1 12 L 2 11 L 2 5 L 1 4 L 0 6 Z");
  assert.ok(path.startsWith("M 0 "));
  assert.ok(path.endsWith("L 0 6 Z"));
});

test("bandPath returns an empty string when there is nothing to draw", () => {
  assert.equal(bandPath([], [], []), "");
});

test("formatTick writes short text without trailing zeros", () => {
  assert.equal(formatTick(0.5), "0.5");
  assert.equal(formatTick(0), "0");
  assert.equal(formatTick(-0), "0");
  assert.equal(formatTick(1), "1");
  assert.equal(formatTick(0.25), "0.25");
  assert.equal(formatTick(0.1234567), "0.123");
});

test("formatTick returns an empty string for values that are not numbers", () => {
  assert.equal(formatTick(Number.NaN), "");
  assert.equal(formatTick(Number.POSITIVE_INFINITY), "");
});

// Label placement: scatter labels must avoid the corner captions and each other, and stay inside the plot.
// PLOT is the plot rectangle in pixels; CORNER_NAMES are the four quadrant captions.
const PLOT = { left: 50, right: 500, top: 20, bottom: 300 };
const CORNER_NAMES = {
  topLeft: "Ideal: firm and open",
  topRight: "Spineless",
  bottomLeft: "Stubborn",
  bottomRight: "Unreliable",
};

/** True when two boxes overlap. Boxes that only touch at an edge do not count. */
function boxesCross(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

test("a label for a point near the top-left corner stays out of the Ideal corner label", () => {
  const corners = cornerBoxes(PLOT, CORNER_NAMES);
  const dot = { x: 70, y: 26, labelGoesLeft: false, label: "Claude" };
  const choice = chooseLabelSide(dot, dot.label, corners, PLOT);
  assert.ok(choice.side, "a side is chosen");
  assert.ok(corners.every((corner) => !boxesCross(choice.box, corner)));
});

test("two points at the same position get different label placements", () => {
  const corners = cornerBoxes(PLOT, CORNER_NAMES);
  const first = { x: 300, y: 150, labelGoesLeft: false, label: "Alpha" };
  const second = { x: 300, y: 150, labelGoesLeft: false, label: "Bravo" };
  const firstChoice = chooseLabelSide(first, first.label, corners, PLOT);
  const secondChoice = chooseLabelSide(second, second.label, [...corners, firstChoice.box], PLOT);
  assert.ok(!boxesCross(firstChoice.box, secondChoice.box));
  assert.notDeepEqual(
    { side: secondChoice.side, dx: secondChoice.dx, dy: secondChoice.dy },
    { side: firstChoice.side, dx: firstChoice.dx, dy: firstChoice.dy },
  );
});

test("a label always stays inside the plot box, even for dots in the plot corners", () => {
  const corners = cornerBoxes(PLOT, CORNER_NAMES);
  const cornerDots = [
    [PLOT.left, PLOT.top],
    [PLOT.right, PLOT.top],
    [PLOT.left, PLOT.bottom],
    [PLOT.right, PLOT.bottom],
  ];
  for (const [x, y] of cornerDots) {
    const dot = { x, y, labelGoesLeft: x === PLOT.right, label: "A long model name" };
    const { box } = chooseLabelSide(dot, dot.label, corners, PLOT);
    assert.ok(box.left >= PLOT.left && box.right <= PLOT.right, `x outside the plot for dot at ${x},${y}`);
    assert.ok(box.top >= PLOT.top && box.bottom <= PLOT.bottom, `y outside the plot for dot at ${x},${y}`);
  }
});

test("labelGoesLeft true puts the label on the left of its dot first", () => {
  const dot = { x: 300, y: 150, labelGoesLeft: true, label: "Alpha" };
  const choice = chooseLabelSide(dot, dot.label, [], PLOT);
  assert.equal(choice.side, "left");
});

// Public surface of the chart kit. The bar, scatter and donut charts were removed from the site, so they must not be
// exported any more. The line chart and the two label helpers remain.
test("index.js exports the line chart and the two label helpers, and no bar, scatter or donut chart", () => {
  assert.deepEqual(Object.keys(chartKit).sort(), ["chooseLabelSide", "cornerBoxes", "lineBandChart"]);
});

// Label collisions: several dots at one spot must get labels whose boxes do not overlap. This is the rule the Batch
// scatter relies on, so two models with the same score do not print on top of each other.
test("placeDotLabels gives labels for dots at one spot boxes that do not overlap", () => {
  const dots = [
    { x: 300, y: 150, labelGoesLeft: false, label: "Alpha" },
    { x: 300, y: 150, labelGoesLeft: false, label: "Bravo" },
    { x: 300, y: 150, labelGoesLeft: false, label: "Charlie" },
  ];
  placeDotLabels(dots, PLOT, []);
  // 7px is the label character width the labels module uses for point labels.
  const boxes = dots.map((dot) => labelBox(dot.label, dot.spot, 7));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      assert.ok(!boxesCross(boxes[i], boxes[j]), `${dots[i].label} and ${dots[j].label} overlap`);
    }
  }
});

// Drawing rules, run against the fake DOM: styling comes from CSS only, and a NaN value must never reach the markup.
// Each chart skips the bad point or bar and shows "no data" where that makes sense.
test("the chart svg gets a CSS class and no inline style attribute", () => {
  const host = makeHost();
  lineBandChart(host, { xLabels: ["a", "b"], series: [{ name: "One", color: "#b5523b", values: [1, 2] }] });
  assert.equal(drawn(host).attributes.class, "chart-svg");
  assert.equal(drawn(host).attributes.style, undefined);
});

test("a NaN value in a line series draws no marker for that point", () => {
  const host = makeHost();
  lineBandChart(host, {
    xLabels: ["a", "b", "c"],
    series: [{ name: "One", color: "#b5523b", values: [1, Number.NaN, 3] }],
  });
  assert.equal(drawn(host).findAll("circle").length, 2);
  assert.ok(!markup(drawn(host)).includes("NaN"));
});

// Series styling: three colour slots that repeat from the fourth series on, with repeats drawn dashed or faded
// so a repeated colour can still be told apart.
test("series 1 to 3 use the three colour slots, and series 4 and later cycle them", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(seriesSlot), [0, 1, 2, 0, 1, 2]);
});

test("a bad series index has no colour slot", () => {
  assert.equal(seriesSlot(-1), null);
});

test("only series 4 and later are repeats, so only they are drawn dashed or faded", () => {
  assert.deepEqual([0, 1, 2, 3].map(isRepeatSeries), [false, false, false, true]);
});

test("a dashed line series has a dash pattern, and a solid one has none", () => {
  const dashedHost = makeHost();
  lineBandChart(dashedHost, {
    xLabels: ["a", "b"],
    series: [{ name: "One", color: "#b5523b", values: [1, 2], dashed: true }],
  });
  assert.ok(drawn(dashedHost).findAll("polyline")[0].attributes["stroke-dasharray"]);
  const solidHost = makeHost();
  lineBandChart(solidHost, {
    xLabels: ["a", "b"],
    series: [{ name: "One", color: "#b5523b", values: [1, 2] }],
  });
  assert.equal(drawn(solidHost).findAll("polyline")[0].attributes["stroke-dasharray"], undefined);
});
