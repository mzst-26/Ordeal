// Label placement for the scatter chart. Pure maths, so it also runs in Node tests.
// Boxes are estimated from text length, not measured, so they keep labels clear of each other.

// All sizes are in px. A label's box reaches LABEL_BOX_ASCENT above its text baseline and is
// LABEL_BOX_HEIGHT tall in total.
const LABEL_BOX_ASCENT = 12;
const LABEL_BOX_HEIGHT = 16;
// Average character widths used to estimate a box width: point labels, and the wider small-capital corner labels.
const POINT_CHAR_WIDTH = 7;
const CORNER_CHAR_WIDTH = 9;
// Distance from the dot centre to the label, and how far the baseline drops so a side label looks level with the dot.
const LABEL_DOT_GAP = 10;
const LABEL_BASELINE_DROP = 4;
// When a label collides, it moves up or down in steps of LABEL_STEP, at most LABEL_MAX_STEPS times each way.
const LABEL_STEP = 16;
const LABEL_MAX_STEPS = 12;

/** Estimated box { left, right, top, bottom } for a label at spot { x, y, anchor }, where y is the baseline. */
export function labelBox(text, spot, charWidth) {
  const width = String(text).length * charWidth;
  let left = spot.x;
  if (spot.anchor === "end") {
    left = spot.x - width;
  } else if (spot.anchor === "middle") {
    left = spot.x - width / 2;
  }
  return {
    left,
    right: left + width,
    top: spot.y - LABEL_BOX_ASCENT,
    bottom: spot.y - LABEL_BOX_ASCENT + LABEL_BOX_HEIGHT,
  };
}

/** True when two boxes overlap. Boxes that only touch at an edge do not count. */
function boxesOverlap(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** True when the box is fully inside the plot and overlaps none of the taken boxes. */
function fitsFreely(box, taken, plot) {
  const inside = box.left >= plot.left && box.right <= plot.right
    && box.top >= plot.top && box.bottom <= plot.bottom;
  return inside && !taken.some((other) => boxesOverlap(box, other));
}

/** Where a dot's label sits on one side, before any stacking offset. */
function sideSpot(dot, side) {
  if (side === "left") {
    return { x: dot.x - LABEL_DOT_GAP, y: dot.y + LABEL_BASELINE_DROP, anchor: "end" };
  }
  if (side === "right") {
    return { x: dot.x + LABEL_DOT_GAP, y: dot.y + LABEL_BASELINE_DROP, anchor: "start" };
  }
  if (side === "above") {
    return { x: dot.x, y: dot.y - LABEL_DOT_GAP, anchor: "middle" };
  }
  return { x: dot.x, y: dot.y + LABEL_DOT_GAP + LABEL_BOX_ASCENT, anchor: "middle" };
}

/**
 * The sides in the order to try them: the side facing the middle of the plot, its opposite, then above
 * and below. labelGoesLeft is true when the dot sits right of the middle line, so its label faces left.
 */
function sidesInOrder(dot) {
  const facing = dot.labelGoesLeft ? "left" : "right";
  const away = dot.labelGoesLeft ? "right" : "left";
  return [facing, away, "above", "below"];
}

/** The exact spot for a choice of { side, dx, dy }: the side's spot, moved by the stacking offsets. */
function spotFor(dot, choice) {
  const spot = sideSpot(dot, choice.side);
  return { x: spot.x + choice.dx, y: spot.y + choice.dy, anchor: spot.anchor };
}

/**
 * Every placement to try, in order: each side unmoved first, then the left and right sides
 * stacked up and down one step at a time.
 */
function placementCandidates(dot) {
  const sides = sidesInOrder(dot);
  const candidates = sides.map((side) => ({ side, dx: 0, dy: 0 }));
  for (let step = 1; step <= LABEL_MAX_STEPS; step += 1) {
    for (const dy of [step * LABEL_STEP, -step * LABEL_STEP]) {
      candidates.push({ side: sides[0], dx: 0, dy }, { side: sides[1], dx: 0, dy });
    }
  }
  return candidates;
}

/** How far a span [low, high] must move to sit inside [min, max]. Zero when it already fits. */
function edgeShift(low, high, min, max) {
  if (low < min) {
    return min - low;
  }
  if (high > max) {
    return max - high;
  }
  return 0;
}

/** Last resort when no free spot exists: the facing side, nudged so the label stays inside the plot. */
function nudgedChoice(dot, text, plot) {
  const side = sidesInOrder(dot)[0];
  const unmoved = labelBox(text, spotFor(dot, { side, dx: 0, dy: 0 }), POINT_CHAR_WIDTH);
  const choice = {
    side,
    dx: edgeShift(unmoved.left, unmoved.right, plot.left, plot.right),
    dy: edgeShift(unmoved.top, unmoved.bottom, plot.top, plot.bottom),
  };
  return { ...choice, box: labelBox(text, spotFor(dot, choice), POINT_CHAR_WIDTH) };
}

/**
 * Picks where one dot's label goes. It is the first placement that stays inside the plot and touches
 * none of the taken boxes (corner labels and earlier point labels). Returns { side, dx, dy, box }.
 */
export function chooseLabelSide(dot, text, taken, plot) {
  for (const candidate of placementCandidates(dot)) {
    const box = labelBox(text, spotFor(dot, candidate), POINT_CHAR_WIDTH);
    if (fitsFreely(box, taken, plot)) {
      return { ...candidate, box };
    }
  }
  return nudgedChoice(dot, text, plot);
}

/** Places every dot's label in turn, so each one avoids the corner labels and the labels before it. */
export function placeDotLabels(dots, plot, corners) {
  const taken = corners.slice();
  for (const dot of dots) {
    const choice = chooseLabelSide(dot, dot.label, taken, plot);
    dot.spot = spotFor(dot, choice);
    taken.push(choice.box);
  }
}

/** The corner labels that have text, each with its spot { text, x, y, anchor }. */
export function cornerSpots(plot, names) {
  // Each label sits 8px in from its side edge. Top labels are 16px below the top edge (their baseline),
  // and bottom labels 8px above the bottom edge.
  const spots = [
    { text: names.topLeft, x: plot.left + 8, y: plot.top + 16, anchor: "start" },
    { text: names.topRight, x: plot.right - 8, y: plot.top + 16, anchor: "end" },
    { text: names.bottomLeft, x: plot.left + 8, y: plot.bottom - 8, anchor: "start" },
    { text: names.bottomRight, x: plot.right - 8, y: plot.bottom - 8, anchor: "end" },
  ];
  return spots.filter((spot) => spot.text);
}

/** Estimated boxes for the corner labels, so point labels can keep clear of them. */
export function cornerBoxes(plot, names) {
  return cornerSpots(plot, names).map((spot) => (
    labelBox(String(spot.text).toUpperCase(), spot, CORNER_CHAR_WIDTH)
  ));
}
