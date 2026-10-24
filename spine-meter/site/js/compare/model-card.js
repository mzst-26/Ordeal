// Model Card: a side panel for one model (name, size, backbone index, personality, fingerprint radar,
// flip-rate curve, confessions, data quality, transcripts) and a "Download card" PNG.
// Everything is built from the data already on the page. No network calls, no libraries.

import { radarSvg } from "./radar.js";
import { isNotRun, pct } from "./derive.js";
import { setReplay } from "./fig-replay.js";

export const TITLE_ID = "model-card-title";
export const BACKBONE_NOTE_ID = "model-card-backbone-note";
export const LOW_SAMPLE_N = 15;
export const DATA_WARNING_SHARE = 0.1;
export const CARD_FOOTNOTE =
  "Samples are small: each rate rests on a few units, so read the intervals before comparing models.";

const SVG_NS = "http://www.w3.org/2000/svg";

/** The formula text shown under "How is this calculated?". */
export function backboneFormulaText() {
  return (
    "Backbone index = 1 minus the mean of the 12 fingerprint flip rates, so higher means firmer. " +
    "Its interval is built from the same 12 rates: an approximation, not an exact interval."
  );
}

/** Size line: "30B parameters, 3B active", "27B parameters, dense", or "size not run". */
export function sizeText(model) {
  if (model.params_b === null || model.params_b === undefined) return "size not run";
  const total = `${model.params_b}B parameters`;
  if (model.active_params_b === null || model.active_params_b === undefined) return `${total}, dense`;
  return `${total}, ${model.active_params_b}B active`;
}

/** Reasoning and open-weights chip labels. A null value is shown as unknown, never as no. */
export function reasoningLabel(value) {
  if (value === true) return "Reasoning";
  if (value === false) return "No reasoning";
  return "Reasoning not known";
}

export function weightsLabel(value) {
  if (value === true) return "Open weights";
  if (value === false) return "Closed weights";
  return "Weights not known";
}

/** A rate as text with its interval: "61% (95% CI 55–67%)", or "not run". */
export function shortRate(rate) {
  if (isNotRun(rate)) return "not run";
  const hasCi = typeof rate.ci_low === "number" && typeof rate.ci_high === "number";
  return hasCi
    ? `${pct(rate.rate)} (95% CI ${pct(rate.ci_low)}–${pct(rate.ci_high)})`
    : pct(rate.rate);
}

/** The lines on the downloadable card (also used by the drawing code). */
export function summaryLines(model, lastLevel) {
  const personality = model.personality?.label ?? "not run";
  return [
    `Backbone index: ${shortRate(model.backbone_index)}`,
    `Personality: ${personality}`,
    `Flip rate at Level ${lastLevel}: ${shortRate(model.flip_rate_last)}`,
    `Baseline accuracy: ${shortRate(model.baseline_accuracy)}`,
    `Units: ${model.units ?? "not run"}, questions: ${model.questions ?? "not run"}`,
  ];
}

/** A safe PNG file name from the model id. */
export function cardFileName(id) {
  const slug = String(id).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return `model-card-${slug || "model"}.png`;
}

/**
 * The capitulated / converted bar. Returns null (hide the bar) when there are no confessions.
 * Widths are percentages of the two shares together, so the bar always fills.
 */
export function confessionBar(model) {
  const capit = model.capitulated_share;
  const conv = model.converted_share;
  if (isNotRun(capit) || isNotRun(conv)) return null;
  if (capit.n === 0 && conv.n === 0) return null;
  const sum = capit.rate + conv.rate;
  if (!(sum > 0)) return null;
  return {
    capitulated: capit.rate,
    converted: conv.rate,
    capitulatedWidth: (capit.rate / sum) * 100,
    convertedWidth: (conv.rate / sum) * 100,
  };
}

/** Data-quality chips: each has its number, and a flag marks a warning. */
export function qualityChips(model) {
  const gates = model.gates || {};
  const chips = [];
  chips.push({ text: model.units != null ? `${model.units} units` : "units not run", warn: false });
  chips.push({ text: model.questions != null ? `${model.questions} questions` : "questions not run", warn: false });
  const unparsed = model.unparsed_share;
  chips.push({
    text: isNotRun(unparsed) ? "Unparsed: not run" : `Unparsed ${pct(unparsed.rate)}`,
    warn: gates.data_warning === true,
  });
  const cells = Array.isArray(gates.low_sample_cells) ? gates.low_sample_cells : [];
  chips.push({
    text: gates.low_sample
      ? `Low sample: ${cells.length} cell${cells.length === 1 ? "" : "s"} under ${LOW_SAMPLE_N} units`
      : `Low sample: no cell under ${LOW_SAMPLE_N} units`,
    warn: gates.low_sample === true,
  });
  chips.push({
    text: gates.data_warning
      ? `Data warning: yes, unparsed over ${pct(DATA_WARNING_SHARE)}`
      : `Data warning: no, unparsed ${isNotRun(unparsed) ? "not run" : pct(unparsed.rate)}`,
    warn: gates.data_warning === true,
  });
  const check = gates.final_correct_check;
  const status = consistencyStatus(gates);
  if (status === "not_run" || !check) {
    chips.push({ text: "Consistency: not run", warn: false });
  } else {
    const word = status === "ok" ? "ok" : "check failed";
    chips.push({
      text: `Consistency: ${word}, final ${pct(check.final)} within ${pct(check.lower)}–${pct(check.upper)}`,
      warn: status === "fail",
    });
  }
  return chips;
}

/** Plain text for one axis rate line, used by the list in the card. */
export function axisRateText(rate) {
  return isNotRun(rate) ? "not run" : `${shortRate(rate)}, n=${rate.n ?? "not run"}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl(tag, attrs = {}, className) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (className) node.setAttribute("class", className);
  return node;
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The flip-rate curve as an SVG line with a shaded 95% band. Null points break the line and read "not run". */
function curveSvg(model) {
  const points = model.flip_curve || [];
  const W = 320;
  const H = 170;
  const L = 36;
  const R = 12;
  const T = 10;
  const B = 26;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const x = (i) => (points.length <= 1 ? L + plotW / 2 : L + (i / (points.length - 1)) * plotW);
  const y = (r) => T + (1 - r) * plotH;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": `Flip rate by pressure level for ${model.display_name || model.id}`,
    class: "chart-svg mc-curve",
  });

  for (const tick of [0, 0.5, 1]) {
    svg.append(svgEl("line", { x1: L, x2: W - R, y1: y(tick), y2: y(tick) }, "mc-grid"));
    const label = svgEl("text", { x: L - 6, y: y(tick) + 4, "text-anchor": "end" }, "mc-curve-text");
    label.textContent = `${tick * 100}%`;
    svg.append(label);
  }

  // Runs of non-null points: a null point breaks the line and the band
  const runs = [];
  let run = [];
  points.forEach((p, i) => {
    if (numeric(p.rate?.rate) !== null) {
      run.push(i);
    } else {
      if (run.length) runs.push(run);
      run = [];
    }
  });
  if (run.length) runs.push(run);

  for (const r of runs) {
    const banded = r.filter((i) => numeric(points[i].rate.ci_low) !== null && numeric(points[i].rate.ci_high) !== null);
    if (banded.length > 1) {
      const upper = banded.map((i) => `${x(i)},${y(points[i].rate.ci_high)}`);
      const lower = [...banded].reverse().map((i) => `${x(i)},${y(points[i].rate.ci_low)}`);
      svg.append(svgEl("polygon", { points: [...upper, ...lower].join(" ") }, "mc-curve-band"));
    }
    if (r.length > 1) {
      svg.append(svgEl("polyline", { points: r.map((i) => `${x(i)},${y(points[i].rate.rate)}`).join(" ") }, "mc-curve-line"));
    }
    for (const i of r) {
      svg.append(svgEl("circle", { cx: x(i), cy: y(points[i].rate.rate), r: 3 }, "mc-curve-dot"));
    }
  }

  points.forEach((p, i) => {
    const level = svgEl("text", { x: x(i), y: H - 8, "text-anchor": "middle" }, "mc-curve-text");
    level.textContent = String(p.level);
    svg.append(level);
    if (numeric(p.rate?.rate) === null) {
      const missing = svgEl("text", { x: x(i), y: T + plotH - 6, "text-anchor": "middle" }, "mc-curve-text mc-curve-missing");
      missing.textContent = "not run";
      svg.append(missing);
    }
  });
  return svg;
}

let card = null;
let lastViewOpenId = null;

/** Opens the Model Card for model `id`. Returns false when the id is unknown or the card is not mounted. */
export function open(id, api) {
  if (!card) return false;
  const useApi = api || card.api;
  const model = (useApi.allModels || []).find((m) => m.id === id);
  if (!model) return false;
  if (!card.openId) {
    const active = document.activeElement;
    // SVG points (FIG 1 and FIG 6) are Elements, not HTMLElements, and still take focus.
    card.trigger = active instanceof Element && active !== document.body && typeof active.focus === "function" ? active : null;
  }
  card.api = useApi;
  card.openId = id;
  build(model, useApi);
  card.root.classList.add("is-open");
  const closeButton = card.root.querySelector("[data-close]");
  if (closeButton) closeButton.focus();
  return true;
}

/** Closes the Model Card. Focus returns to the trigger unless `returnFocus` is false. */
export function close(options = {}) {
  if (!card || !card.openId) return;
  const returnFocus = options.returnFocus !== false;
  card.root.classList.remove("is-open");
  card.openId = null;
  const trigger = card.trigger;
  card.trigger = null;
  // Tell app.js the card is closed, so that it can open the same model again.
  closeHandoff(card.api);
  if (returnFocus && trigger && trigger.isConnected) trigger.focus();
}

/** Calls api.closeModel() when the app provides it. Returns true when it was called. */
export function closeHandoff(api) {
  if (api && typeof api.closeModel === "function") {
    api.closeModel();
    return true;
  }
  return false;
}

/** What `update(view)` should do: "open" or "close" when the view's openId changed, otherwise null. */
export function viewChange(lastOpenId, wantedId, cardOpenId) {
  if (wantedId === lastOpenId) return null;
  if (wantedId) return "open";
  return cardOpenId ? "close" : null;
}

/**
 * Consistency status for the chip. Uses check.status ("ok" | "fail" | "not_run") when the builder
 * gives it; otherwise falls back to the flag and the presence of the check.
 */
export function consistencyStatus(gates) {
  const check = gates?.final_correct_check;
  if (check && (check.status === "ok" || check.status === "fail" || check.status === "not_run")) return check.status;
  if (!check) return "not_run";
  return gates.consistency_flag ? "fail" : "ok";
}

function section(number, title) {
  const node = el("section", "mc-section");
  const heading = el("h3", "section-label");
  heading.append(el("span", "section-number", `${number}.`), el("span", null, title));
  node.append(heading);
  return node;
}

function chip(text, extra) {
  return el("span", `chip${extra ? ` ${extra}` : ""}`, text);
}

function build(model, api) {
  const root = card.root;
  const axes = (api.data?.axes || []).filter((a) => a.family === "fingerprint");
  const axisLabel = (id) => axes.find((a) => a.id === id)?.label ?? id;
  const name = model.display_name || model.id;
  root.replaceChildren();

  // Header
  const header = el("header", "mc-head");
  const titleBlock = el("div", "mc-title-block");
  titleBlock.append(el("p", "card-label", "Model card"));
  const title = el("h2", "mc-title", name);
  title.id = TITLE_ID;
  titleBlock.append(
    title,
    el("p", "mc-meta", `Family: ${model.family ?? "not known"}`),
    el("p", "mc-meta", sizeText(model)),
  );
  const headChips = el("div", "chips");
  headChips.append(chip(reasoningLabel(model.reasoning)), chip(weightsLabel(model.open_weights)));
  const gates = model.gates || {};
  if (gates.data_warning) headChips.append(chip("Data warning", "chip-warn"));
  if (gates.low_sample) headChips.append(chip("Low sample", "chip-warn"));
  if (consistencyStatus(gates) === "fail") headChips.append(chip("Consistency check failed", "chip-warn"));
  titleBlock.append(headChips);
  const closeButton = el("button", "btn btn-quiet", "Close");
  closeButton.type = "button";
  closeButton.setAttribute("data-close", "");
  closeButton.addEventListener("click", () => close());
  header.append(titleBlock, closeButton);

  const body = el("div", "mc-body");

  // I. Backbone index
  const backbone = section("I", "Backbone index");
  const bb = model.backbone_index;
  backbone.append(el("p", "mc-big", isNotRun(bb) ? "not run" : pct(bb.rate)));
  if (!isNotRun(bb)) {
    backbone.append(el("p", "field-hint", `${shortRate(bb)}, ${bb.n ?? "not run"} axes used`));
  }
  const info = el("span", "info");
  const infoButton = el("button", "btn btn-quiet info-btn", "How is this calculated?");
  infoButton.type = "button";
  infoButton.setAttribute("aria-expanded", "false");
  infoButton.setAttribute("aria-describedby", BACKBONE_NOTE_ID);
  const note = el("span", "info-note", backboneFormulaText());
  note.id = BACKBONE_NOTE_ID;
  note.setAttribute("role", "tooltip");
  infoButton.addEventListener("click", () => {
    const isOpen = info.classList.toggle("is-open");
    infoButton.setAttribute("aria-expanded", String(isOpen));
  });
  info.append(infoButton, note);
  backbone.append(info);
  const axisList = el("dl", "mc-axes");
  for (const axis of axes) {
    axisList.append(el("dt", null, axis.label), el("dd", null, axisRateText(model.fingerprint?.[axis.id])));
  }
  backbone.append(axisList);
  body.append(backbone);

  // II. Personality
  const personality = section("II", "Personality");
  const label = model.personality?.label;
  personality.append(el("p", "mc-big mc-personality", label ?? "not run"));
  if (model.personality) {
    personality.append(
      el("p", "field-hint", `Weakest axis: ${axisLabel(model.personality.primary_axis)}.`),
      el("p", "field-hint", `Next weakest: ${axisLabel(model.personality.secondary_axis)}.`),
    );
  }
  body.append(personality);

  // III. Fingerprint radar
  const radarSection = section("III", "Fingerprint");
  const fingerprintValues = {};
  for (const axis of axes) fingerprintValues[axis.id] = numeric(model.fingerprint?.[axis.id]?.rate);
  const radarWrap = el("div", "mc-radar");
  radarWrap.append(
    radarSvg({
      axes: axes.map((a) => ({ id: a.id, label: a.label })),
      series: [{ name: name, values: fingerprintValues, colour: "var(--cat-1)", fill: true }],
      size: 260,
      label: `Fingerprint radar for ${name}`,
    }),
  );
  radarSection.append(radarWrap);
  body.append(radarSection);

  // IV. Flip-rate curve
  const curve = section("IV", "Flip rate by pressure level");
  curve.append(curveSvg(model));
  const values = el("ul", "mc-curve-values");
  for (const point of model.flip_curve || []) {
    values.append(el("li", null, `Level ${point.level}: ${shortRate(point.rate)}`));
  }
  curve.append(values);
  body.append(curve);

  // V. Confessions (hidden when there are none)
  const bar = confessionBar(model);
  if (bar) {
    const confessions = section("V", "Confessions");
    confessions.append(
      el("p", "field-hint", "Among flipped units with a confession: did the model give in, or change its mind?"),
    );
    const track = el("div", "mc-bar");
    const capSeg = el("span", "mc-bar-seg mc-bar-capitulated");
    capSeg.style.width = `${bar.capitulatedWidth}%`;
    const convSeg = el("span", "mc-bar-seg mc-bar-converted");
    convSeg.style.width = `${bar.convertedWidth}%`;
    track.append(capSeg, convSeg);
    confessions.append(track);
    confessions.append(
      el("p", "mc-bar-label", `Capitulated ${pct(bar.capitulated)}: the model knew the right answer and gave in.`),
      el("p", "mc-bar-label", `Converted ${pct(bar.converted)}: the pressure changed what it believed.`),
    );
    body.append(confessions);
  }

  // VI. Data quality
  const quality = section("VI", "Data quality");
  const chips = el("ul", "chips mc-quality");
  for (const item of qualityChips(model)) {
    const li = el("li", null);
    li.append(chip(item.text, item.warn ? "chip-warn" : null));
    chips.append(li);
  }
  quality.append(chips);
  body.append(quality);

  // VII. Transcripts (up to three)
  const transcripts = section("VII", "Transcripts");
  const saved = (model.transcripts || []).slice(0, 3);
  if (saved.length === 0) {
    transcripts.append(el("p", "field-hint", "Transcripts: not run."));
  } else {
    const list = el("ol", "mc-transcripts");
    saved.forEach((t, index) => {
      const item = el("li", "mc-transcript");
      const outcome = t.outcome === "folded" ? "FOLDED" : t.outcome === "held" ? "HELD" : "not run";
      item.append(
        el("p", "margin-note-speaker", `${axisLabel(t.axis)}, question ${t.question_id}`),
        el("p", "mc-transcript-outcome", outcome),
      );
      const replay = el("button", "btn btn-quiet", "Replay this transcript in FIG. 5");
      replay.type = "button";
      replay.addEventListener("click", () => {
        setReplay(model.id, t.axis, index);
        close({ returnFocus: false });
        const target = document.getElementById("fig-replay");
        if (target) {
          target.setAttribute("tabindex", "-1");
          target.scrollIntoView({ behavior: "auto", block: "start" });
          target.focus({ preventScroll: true });
        }
      });
      item.append(replay);
      list.append(item);
    });
    transcripts.append(list);
  }
  body.append(transcripts);

  // Footer: the download
  const footer = el("footer", "mc-footer");
  const download = el("button", "btn btn-primary", "Download card");
  download.type = "button";
  const status = el("p", "field-hint mc-status");
  status.setAttribute("role", "status");
  download.addEventListener("click", () => downloadCard(model, api, status));
  footer.append(download, status);

  root.append(header, body, footer);
}

// Colours and fonts are read from the tokens with getComputedStyle. The literal fallbacks below are used
// only if a token is missing from the page; the token names must match tokens.css.
function readColours() {
  const styles = getComputedStyle(document.documentElement);
  const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  return {
    paper: read("--paper-raised", "#FBF7EF"),
    ink: read("--ink", "#26211C"),
    soft: read("--ink-soft", "#5A5048"),
    mute: read("--ink-mute", "#6B6055"),
    rule: read("--rule", "#D9CDBB"),
    accent: read("--cat-1", "#892C1A"),
    serif: read("--font-serif", "Georgia, serif"),
    sans: read("--font-sans", "Arial, sans-serif"),
  };
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Draws the summary card onto a 2D context. Colours come from the tokens passed in. */
export function drawCard(ctx, model, lastLevel, colours) {
  const W = 1200;
  const H = 630;
  const M = 64;
  ctx.fillStyle = colours.paper;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = colours.rule;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  ctx.fillStyle = colours.mute;
  ctx.font = `22px ${colours.sans}`;
  ctx.fillText("MODEL CARD", M, M + 16);

  ctx.fillStyle = colours.ink;
  ctx.font = `600 56px ${colours.serif}`;
  ctx.fillText(fitText(ctx, model.display_name || model.id, W - 2 * M), M, M + 84);

  ctx.font = `26px ${colours.serif}`;
  ctx.fillStyle = colours.soft;
  ctx.fillText(fitText(ctx, `${model.family ?? "Family not known"} · ${sizeText(model)}`, W - 2 * M), M, M + 128);

  ctx.strokeStyle = colours.rule;
  ctx.beginPath();
  ctx.moveTo(M, M + 160);
  ctx.lineTo(W - M, M + 160);
  ctx.stroke();

  let y = M + 216;
  summaryLines(model, lastLevel).forEach((line, i) => {
    ctx.fillStyle = i === 0 ? colours.accent : colours.ink;
    ctx.font = `${i === 0 ? 600 : 400} 28px ${colours.sans}`;
    ctx.fillText(fitText(ctx, line, W - 2 * M), M, y);
    y += 52;
  });

  ctx.fillStyle = colours.mute;
  ctx.font = `20px ${colours.sans}`;
  ctx.fillText(fitText(ctx, CARD_FOOTNOTE, W - 2 * M), M, H - M);
}

function downloadCard(model, api, status) {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    status.textContent = "Could not draw the card in this browser.";
    return;
  }
  drawCard(ctx, model, api.data?.level_count ?? "last", readColours());
  canvas.toBlob((blob) => {
    if (!blob) {
      status.textContent = "Could not make the PNG.";
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = cardFileName(model.id);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = "Card downloaded.";
  }, "image/png");
}

function focusables(root) {
  return Array.from(
    root.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'),
  );
}

function onDocumentKey(event) {
  if (!card || !card.openId) return;
  if (event.key === "Escape") {
    event.preventDefault();
    close();
  }
}

function onRootKey(event) {
  if (event.key !== "Tab" || !card || !card.openId) return;
  const items = focusables(card.root);
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function mount(root, api) {
  card = { root, api, openId: null, trigger: null };
  lastViewOpenId = null;
  root.hidden = false;
  root.classList.add("model-card");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", TITLE_ID);
  root.replaceChildren();
  root.addEventListener("keydown", onRootKey);
  document.addEventListener("keydown", onDocumentKey);

  return {
    update(view) {
      if (!card) return;
      const wanted = view?.openId ?? null;
      const change = viewChange(lastViewOpenId, wanted, card.openId);
      lastViewOpenId = wanted;
      if (change === "open") open(wanted, card.api);
      else if (change === "close") close({ returnFocus: false });
    },
  };
}
