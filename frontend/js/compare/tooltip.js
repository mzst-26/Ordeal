// One shared tooltip for the comparison page: a div with role="tooltip" in the document body.
// showTooltip(node, anchorRect): node is a DOM node built by the caller with textContent. Strings are refused,
// so model text can never reach innerHTML. hideTooltip() hides it. The position is set through element.style,
// which the CSP allows.

const TOOLTIP_ID = "compare-tooltip";
// GAP is the space in px between the anchor and the tooltip. EDGE is the least space in px kept
// between the tooltip and the viewport edge.
const GAP = 8;
const EDGE = 8;

// The single tooltip element, shared by every caller. It is null until the first showTooltip call.
let tip = null;

/** The tooltip element, created on first use. */
function tooltipNode() {
  if (tip === null) {
    tip = document.createElement("div");
    tip.id = TOOLTIP_ID;
    tip.className = "compare-tooltip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

/** Places the tooltip below the anchor, or above it when there is no room, and keeps it on screen. */
function place(node, anchorRect) {
  const width = node.offsetWidth;
  // The tooltip must already be visible (not hidden) here, or offsetWidth and offsetHeight would read 0.
  const height = node.offsetHeight;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  // With no anchor, fall back to the top-left corner of the viewport.
  if (!anchorRect) {
    node.style.left = `${EDGE}px`;
    node.style.top = `${EDGE}px`;
    return;
  }
  let top = anchorRect.bottom + GAP;
  if (top + height > viewportHeight - EDGE) {
    top = Math.max(EDGE, anchorRect.top - height - GAP);
  }
  // Centre on the anchor horizontally, then clamp so the tooltip stays inside the viewport.
  const centred = anchorRect.left + anchorRect.width / 2 - width / 2;
  const left = Math.min(Math.max(EDGE, centred), Math.max(EDGE, viewportWidth - width - EDGE));
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

/**
 * Shows the tooltip with a DOM node as its content, next to the anchor rectangle (from getBoundingClientRect).
 * A string is refused with a TypeError: content must be a node built with textContent, never markup.
 */
export function showTooltip(content, anchorRect) {
  if (typeof content === "string") {
    throw new TypeError("showTooltip takes a DOM node built with textContent, not a string");
  }
  const node = tooltipNode();
  node.replaceChildren();
  if (content) {
    node.append(content);
  }
  node.hidden = false;
  place(node, anchorRect);
}

/** Hides the tooltip and clears its content. */
export function hideTooltip() {
  if (tip === null) {
    return;
  }
  tip.hidden = true;
  tip.replaceChildren();
}
