// FIG 3, "Survivors": one dot per visible model, coloured by whether it still held at the chosen flip level.
// A slider (and a play button, which only steps under reduced motion) moves the level.
import { isNotRun, pct, rateText } from "./derive.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const HOLD_LIMIT = 0.5;
const FALLBACK_BEAT_MS = 240;
const CAPTION =
  "A filled green dot means the model held (flip rate at or below 50%), a filled red-brown dot means it flipped past half, " +
  "and a dotted dot was not run and is left out of the count.";

/** The state of one model at one level: "held" (at or below 50%), "flipped" (above 50%) or "not-run". */
export function survivorState(rate) {
  if (isNotRun(rate)) return "not-run";
  return rate.rate <= HOLD_LIMIT ? "held" : "flipped";
}

/** The flip-curve rate at a level, or null when that level is missing. */
export function levelRate(model, level) {
  const point = (model.flip_curve || []).find((entry) => entry.level === level);
  return point ? point.rate : null;
}

/**
 * Count the visible models at one level. Not-run models are left out of holding and flipped, and counted in notRun.
 * Returns { holding, flipped, notRun }.
 */
export function countSurvivors(models, level) {
  const counts = { holding: 0, flipped: 0, notRun: 0 };
  for (const model of models) {
    const state = survivorState(levelRate(model, level));
    if (state === "held") counts.holding += 1;
    else if (state === "flipped") counts.flipped += 1;
    else counts.notRun += 1;
  }
  return counts;
}

/** The live count sentence: "N of M still holding at level L". M excludes the not-run models. */
export function survivorSentence(counts, level) {
  const total = counts.holding + counts.flipped;
  if (total === 0) return `No model has a result at level ${level}.`;
  return `${counts.holding} of ${total} still holding at level ${level}`;
}

function shortName(model) {
  const name = model.display_name || model.id || "";
  return name.replace(/\s*\(.*\)\s*$/, "") || name;
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/** The step length in ms, read from the --dur-base token (0 under reduced motion, then the fallback is used). */
function beatMs() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--dur-base").trim();
  const value = parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : FALLBACK_BEAT_MS;
}

function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key === "hidden") node.hidden = Boolean(value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const kid of kids) {
    if (kid !== null && kid !== undefined && kid !== false) node.append(kid);
  }
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

export function mount(root, api) {
  const levelCount = Math.max(1, Number(api.data.level_count) || 1);
  const reduced = prefersReducedMotion();
  const sliderId = `${root.id}-level`;
  const state = {
    level: levelCount,
    playing: false,
    timer: null,
    view: { models: [] },
    renderedSig: null,
    items: new Map(),
  };

  const slider = h("input", {
    type: "range",
    class: "range sv-range",
    id: sliderId,
    min: "1",
    max: String(levelCount),
    step: "1",
    value: String(levelCount),
    oninput: () => {
      stopPlaying(false);
      setLevel(Number(slider.value), true);
    },
  });
  const levelOutput = h("output", { class: "sv-level", for: sliderId, text: `Level ${levelCount} of ${levelCount}` });
  const playButton = h("button", {
    type: "button",
    class: "btn",
    text: reduced ? "Next level" : "Play",
    onclick: () => togglePlay(),
  });
  const countEl = h("p", { class: "sv-count", "aria-live": "off" });
  const excludedEl = h("p", { class: "field-hint" });
  const stripBox = h("div", {
    class: "sv-chart",
    role: "region",
    "aria-label": "Survivors: one dot per visible model, coloured by whether it still held at the chosen level",
  });
  const detailTableBody = h("tbody");
  const detailTable = h(
    "table",
    { class: "fg-table" },
    h("caption", { class: "fg-table-caption", text: "Flip rate at the chosen level, with 95% intervals and units" }),
    h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Model" }), h("th", { scope: "col", text: "Flip rate" }))),
    detailTableBody,
  );
  const detailsBox = h(
    "details",
    { class: "sv-details" },
    h("summary", { text: "Show as table" }),
    h("div", { class: "fg-alt" }, detailTable),
  );

  root.replaceChildren(
    h(
      "div",
      { class: "sv-controls" },
      playButton,
      h("div", { class: "sv-range-wrap" }, h("label", { class: "field-label", for: sliderId, text: "Flip level" }), slider),
      levelOutput,
    ),
    countEl,
    excludedEl,
    stripBox,
    h("p", { class: "field-hint fg-caption", text: CAPTION }),
    detailsBox,
  );

  function setLevel(level, announce) {
    state.level = Math.min(levelCount, Math.max(1, Math.round(level) || 1));
    paint();
    if (announce) api.announce(countSentence());
  }

  function countSentence() {
    const models = state.view.models || [];
    return `${survivorSentence(countSurvivors(models, state.level), state.level)}.`;
  }

  function stopPlaying(announce) {
    if (state.timer !== null) clearInterval(state.timer);
    state.timer = null;
    state.playing = false;
    playButton.textContent = "Play";
    if (announce) api.announce(countSentence());
  }

  function startPlaying() {
    if (state.level >= levelCount) setLevel(1, false);
    state.playing = true;
    playButton.textContent = "Pause";
    state.timer = setInterval(() => {
      if (state.level >= levelCount) {
        stopPlaying(true);
        return;
      }
      setLevel(state.level + 1, false);
    }, beatMs());
  }

  function togglePlay() {
    if (reduced) {
      // Under reduced motion the button only steps one level, wrapping back to level 1 at the end.
      setLevel(state.level >= levelCount ? 1 : state.level + 1, true);
      return;
    }
    if (state.playing) stopPlaying(true);
    else startPlaying();
  }

  function buildStrip(models) {
    const list = h("ul", { class: "sv-strip" });
    state.items = new Map();
    for (const model of models) {
      const svg = svgEl("svg", { viewBox: "0 0 16 16", class: "sv-dot", "aria-hidden": "true", focusable: "false" });
      const title = svgEl("title");
      const circle = svgEl("circle", { cx: 8, cy: 8, r: 6.5 });
      svg.append(title, circle);
      const value = h("span", { class: "sv-value" });
      const button = h("button", {
        type: "button",
        class: "sv-item",
        onclick: () => api.openModel(model.id),
      }, svg, h("span", { class: "sv-label", text: shortName(model) }), value);
      state.items.set(model.id, { circle, title, value, button, model });
      list.append(h("li", {}, button));
    }
    return list;
  }

  function paint() {
    const models = state.view.models || [];
    const level = state.level;
    slider.value = String(level);
    levelOutput.textContent = `Level ${level} of ${levelCount}`;
    slider.setAttribute("aria-valuetext", `Level ${level} of ${levelCount}`);

    const counts = countSurvivors(models, level);
    countEl.textContent = `${survivorSentence(counts, level)}.`;
    excludedEl.textContent = `${counts.notRun} not run at this level, excluded from both counts.`;

    detailTableBody.replaceChildren(
      ...models.map((model) =>
        h("tr", {}, h("th", { scope: "row", text: model.display_name || model.id }), h("td", { text: rateText(levelRate(model, level)) })),
      ),
    );

    for (const model of models) {
      const item = state.items.get(model.id);
      if (!item) continue;
      const rate = levelRate(model, level);
      const survivor = survivorState(rate);
      const colour = survivor === "held" ? "var(--sage)" : survivor === "flipped" ? "var(--terracotta)" : "none";
      item.circle.style.fill = survivor === "not-run" ? "none" : colour;
      item.circle.style.stroke = survivor === "not-run" ? "var(--ink-mute)" : colour;
      item.circle.style.strokeDasharray = survivor === "not-run" ? "2 2" : "none";
      const text =
        survivor === "not-run" ? "not run" : `${pct(rate.rate)} · ${survivor === "held" ? "held" : "flipped"}`;
      item.value.textContent = text;
      const full = `${model.display_name || model.id}: ${text} at level ${level}`;
      item.title.textContent = full;
      item.button.setAttribute("aria-label", full);
    }
  }

  function render(models) {
    const sig = JSON.stringify(models.map((model) => model.id));
    if (sig === state.renderedSig) return;
    state.renderedSig = sig;
    if (models.length === 0) {
      stripBox.replaceChildren(
        h(
          "div",
          { class: "fg-empty" },
          h("p", { text: "No models match these filters." }),
          h("button", { type: "button", class: "btn", text: "Reset filters", onclick: () => api.resetFilters() }),
        ),
      );
      state.items = new Map();
    } else {
      stripBox.replaceChildren(buildStrip(models));
    }
  }

  return {
    update(view) {
      state.view = view;
      const models = view.models || [];
      render(models);
      if (models.length === 0) {
        countEl.textContent = "";
        excludedEl.textContent = "";
        detailTableBody.replaceChildren();
        return;
      }
      paint();
    },
  };
}
