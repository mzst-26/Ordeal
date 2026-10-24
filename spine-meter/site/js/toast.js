// Non-blocking one-line messages at the bottom of the screen.

import { el } from "./ui.js";

const TONE_LABELS = { info: "Note", warn: "Check", error: "Problem" };
const DEFAULT_TONE = "info";
// How long a message stays on screen, in milliseconds, when the caller does not give a duration.
const DEFAULT_TOAST_MS = 4000;

let region = null;

/** Return the polite live region, creating it the first time it is needed. */
function getRegion() {
  if (region === null) {
    region = el("div", { className: "toast-region", "aria-live": "polite" });
    document.body.append(region);
  }
  return region;
}

/** Show a message that leaves the screen after `duration` milliseconds. The message is set as text. */
export function showToast(message, { tone = DEFAULT_TONE, duration = DEFAULT_TOAST_MS } = {}) {
  const safeTone = TONE_LABELS[tone] ? tone : DEFAULT_TONE;
  const toast = el("div", { className: `toast toast-${safeTone}` }, [
    el("span", { className: "toast-label", text: TONE_LABELS[safeTone] }),
    el("span", { className: "toast-message", text: message }),
  ]);
  getRegion().append(toast);
  window.setTimeout(() => toast.remove(), duration);
  return toast;
}
