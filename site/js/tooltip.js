// A hover note for any element with a data-tip attribute. The note appears at once, unlike the browser's own
// tooltip, and it also opens when the element takes keyboard focus. One bubble is shared by the whole page.

let bubble = null;
let current = null;
let started = false;

/** Return the shared bubble, made on first use and kept in the page body. */
function bubbleNode() {
  if (bubble === null) {
    bubble = document.createElement("div");
    bubble.className = "tip";
    bubble.setAttribute("role", "tooltip");
    bubble.hidden = true;
    document.body.append(bubble);
  }
  return bubble;
}

/** Show the note of one element, placed under it, or above it when there is no room below. Kept on screen. */
function show(target) {
  const text = target.getAttribute("data-tip");
  if (!text) return;
  const node = bubbleNode();
  node.textContent = text;
  node.hidden = false;
  const box = target.getBoundingClientRect();
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  const left = Math.min(Math.max(8, box.left + box.width / 2 - width / 2), window.innerWidth - width - 8);
  const below = box.bottom + 8;
  const top = below + height > window.innerHeight ? box.top - height - 8 : below;
  node.style.left = `${left}px`;
  node.style.top = `${Math.max(8, top)}px`;
  current = target;
}

/** Hide the note. */
function hide() {
  if (bubble !== null) bubble.hidden = true;
  current = null;
}

/** Start the notes for the whole page. Calling it again does nothing. */
export function initTooltips() {
  if (started) return;
  started = true;
  document.addEventListener("pointerover", (event) => {
    const target = event.target.closest?.("[data-tip]");
    if (target && target !== current) show(target);
  });
  document.addEventListener("pointerout", (event) => {
    if (current && !current.contains(event.relatedTarget)) hide();
  });
  document.addEventListener("focusin", (event) => {
    const target = event.target.closest?.("[data-tip]");
    if (target) show(target);
  });
  document.addEventListener("focusout", hide);
  window.addEventListener("scroll", hide, { passive: true });
}
