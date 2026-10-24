// FIG 5: transcript replay. Plays a saved conversation turn by turn, types the last reply,
// then stamps HELD or FOLDED. Reads only the data already in the page; makes no network calls.

// Gap between two earlier turns, in milliseconds. The reply starts after the earlier turns.
export const TURN_MS = 400;
// Typing speed in characters per second: the default and the slider's bounds.
export const DEFAULT_CPS = 60;
export const CPS_MIN = 20;
export const CPS_MAX = 120;
export const NO_TRANSCRIPTS_TEXT = "No saved transcripts for this model.";
export const CAPTION_TEXT =
  "This replay plays a saved conversation from any model in the run, whatever the filters above say; the last reply types out at the speed you set, and the stamp shows whether the model held or folded.";

// An elapsed time so large that every turn and the whole reply count as finished (used by Skip
// and by reduced-motion, which paints the end state at once).
const FAR_FUTURE_MS = 1e12;

/** Number of visible characters (code points) after `elapsedMs` at `cps` characters per second. */
export function visibleCharCount(text, cps, elapsedMs) {
  const length = Array.from(String(text ?? "")).length;
  if (!(cps > 0) || !(elapsedMs > 0)) return 0;
  return Math.min(length, Math.floor((elapsedMs / 1000) * cps));
}

/** The first `visibleCharCount` characters of `text`, as a string. */
export function visibleText(text, cps, elapsedMs) {
  const chars = Array.from(String(text ?? ""));
  return chars.slice(0, visibleCharCount(text, cps, elapsedMs)).join("");
}

/** Elapsed milliseconds at which `chars` characters have been typed at `cps`. */
export function elapsedForChars(chars, cps) {
  if (!(cps > 0) || !(chars > 0)) return 0;
  // Add a little so that floor() lands on the full count.
  return ((chars + 0.000001) / cps) * 1000;
}

/**
 * What is on screen at `elapsedMs`: how many earlier turns are shown, whether the reply has
 * started, how many reply characters are visible, and whether playback has finished.
 */
export function replayTimeline({ priorCount, replyText, cps, elapsedMs, turnMs = TURN_MS }) {
  const prior = Math.max(0, priorCount | 0);
  const elapsed = Math.max(0, elapsedMs);
  const turnsShown = prior === 0 ? 0 : Math.min(prior, Math.floor(elapsed / turnMs) + 1);
  const replyStart = prior * turnMs;
  const replyStarted = elapsed >= replyStart;
  const replyLength = Array.from(String(replyText ?? "")).length;
  const replyChars = replyStarted ? visibleCharCount(replyText, cps, elapsed - replyStart) : 0;
  const done = replyStarted && replyChars >= replyLength;
  return { turnsShown, replyStarted, replyChars, done };
}

/** The stamp for an outcome: text plus a tone name (the colour is applied in CSS). Null if unknown. */
export function stampFor(outcome) {
  if (outcome === "held") return { label: "HELD", tone: "held" };
  if (outcome === "folded") return { label: "FOLDED", tone: "folded" };
  return null;
}

/** The sentence under a FOLDED stamp: the confession letter and text, or a note that none was saved. */
export function confessionSentence(confession) {
  if (confession && confession.letter && confession.text) {
    return `It still believed: ${confession.letter}. ${confession.text}`;
  }
  return "No confession was saved for this question.";
}

/** Sets the one-sentence caption that F1 places under the figure (created if missing). */
function setCaption(root, text) {
  const section = root.closest("section.figure");
  let caption = section ? section.querySelector(".figure-caption") : null;
  if (!caption) {
    caption = document.createElement("p");
    caption.className = "field-hint figure-caption";
    root.after(caption);
  }
  caption.textContent = text;
}

// True when the visitor asked the OS for reduced motion; the replay then shows the end state without animating.
function prefersReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Monotonic clock in milliseconds; falls back to Date.now where performance is missing.
function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// Small DOM helper: creates an element with an optional class and text (set via textContent, so no HTML injection).
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Speaker label shown above a turn. Unknown roles are shown upper-cased rather than hidden.
function roleLabel(role) {
  if (role === "assistant") return "Model";
  if (role === "user") return "User";
  return String(role ?? "Note").toUpperCase();
}

// Module-level link to the mounted figure, so setReplay() can drive it from outside.
// `pending` remembers a request made before mount() ran; mount() applies it on first load.
let live = null;
let pending = null;

/** Select a model, pressure type and (optionally) one transcript by its index in model.transcripts, then replay it. */
export function setReplay(modelId, axisId, transcriptIndex) {
  pending = { modelId, axisId, transcriptIndex };
  return live ? live.apply(pending) : null;
}

export function mount(root, api) {
  root.replaceChildren();
  const withTranscripts = (api.allModels || []).filter(
    (m) => Array.isArray(m.transcripts) && m.transcripts.length > 0,
  );
  const axisById = new Map((api.data?.axes || []).map((a) => [a.id, a.label]));
  const axisName = (id) => axisById.get(id) || id;
  const modelById = new Map(withTranscripts.map((m) => [m.id, m]));

  // Mutable playback state. t0 is the clock time playback started; raf is the animation-frame id
  // (null when idle); priorCount is how many earlier turns precede the typed reply.
  const state = {
    model: null,
    axisId: null,
    index: -1,
    cps: DEFAULT_CPS,
    t0: 0,
    raf: null,
    turns: [],
    reply: null,
    priorCount: 0,
    replyText: "",
    outcome: null,
    confession: null,
    notice: "",
  };

  // Controls
  const controls = el("div", "replay-controls");
  const modelField = el("div", "field replay-field");
  const modelLabel = el("label", "field-label", "Model");
  modelLabel.htmlFor = "replay-model";
  const modelSelect = el("select", "select");
  modelSelect.id = "replay-model";
  for (const m of withTranscripts) {
    const opt = el("option", null, m.display_name || m.id);
    opt.value = m.id;
    modelSelect.append(opt);
  }
  modelField.append(modelLabel, modelSelect);

  const axisField = el("div", "field replay-field");
  const axisLabel = el("label", "field-label", "Pressure type");
  axisLabel.htmlFor = "replay-pressure";
  const axisSelect = el("select", "select");
  axisSelect.id = "replay-pressure";
  axisField.append(axisLabel, axisSelect);

  const speedField = el("div", "field replay-field");
  const speedLabel = el("label", "field-label", "Typing speed");
  speedLabel.htmlFor = "replay-speed";
  const speedRow = el("div", "replay-speed-row");
  const speed = el("input", "range");
  speed.type = "range";
  speed.id = "replay-speed";
  speed.min = String(CPS_MIN);
  speed.max = String(CPS_MAX);
  speed.step = "5";
  speed.value = String(DEFAULT_CPS);
  const speedOut = el("output", "field-hint");
  speedOut.htmlFor = "replay-speed";
  speedRow.append(speed, speedOut);
  speedField.append(speedLabel, speedRow);

  const buttons = el("div", "replay-buttons");
  const replayBtn = el("button", "btn btn-primary", "Replay");
  replayBtn.type = "button";
  const skipBtn = el("button", "btn", "Skip to the end");
  skipBtn.type = "button";
  buttons.append(replayBtn, skipBtn);

  controls.append(modelField, axisField, speedField, buttons);

  const meta = el("p", "field-hint replay-meta");
  const status = el("p", "field-hint replay-status");
  status.setAttribute("role", "status");
  const panel = el("div", "replay-panel");
  const stampRow = el("div", "replay-result");
  const stamp = el("p", "replay-stamp");
  stamp.hidden = true;
  const confession = el("p", "replay-confession margin-note-text");
  confession.hidden = true;
  stampRow.append(stamp, confession);

  root.append(controls, meta, panel, stampRow, status);
  setCaption(root, CAPTION_TEXT);

  if (withTranscripts.length === 0) {
    modelSelect.disabled = true;
    axisSelect.disabled = true;
    replayBtn.disabled = true;
    skipBtn.disabled = true;
    meta.textContent = NO_TRANSCRIPTS_TEXT;
  }

  function setSpeedText() {
    speedOut.textContent = `${state.cps} characters a second`;
  }
  setSpeedText();

  function fillAxisOptions(model) {
    axisSelect.replaceChildren();
    const axes = [];
    for (const t of model.transcripts) if (!axes.includes(t.axis)) axes.push(t.axis);
    for (const id of axes) {
      const opt = el("option", null, axisName(id));
      opt.value = id;
      axisSelect.append(opt);
    }
  }

  // Stops any running animation and empties the transcript panel, stamp and status.
  function clearStage() {
    cancelFrame();
    panel.replaceChildren();
    state.turns = [];
    state.reply = null;
    stamp.hidden = true;
    confession.hidden = true;
    status.textContent = "";
  }

  // Cancels the pending animation frame, if any, so only one playback loop runs at a time.
  function cancelFrame() {
    if (state.raf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(state.raf);
    state.raf = null;
  }

  /** Load transcript `index` of the current model and restart playback. */
  function load(index) {
    const model = state.model;
    const transcript = model && model.transcripts[index];
    clearStage();
    if (!transcript) {
      meta.textContent = NO_TRANSCRIPTS_TEXT;
      return;
    }
    state.index = index;
    state.axisId = transcript.axis;
    axisSelect.value = transcript.axis;
    const sameAxis = model.transcripts.filter((t) => t.axis === transcript.axis);
    const position = sameAxis.indexOf(transcript) + 1;
    const notice = state.notice ? `${state.notice} ` : "";
    state.notice = "";
    meta.textContent =
      `${notice}Transcript ${position} of ${sameAxis.length} for ${axisName(transcript.axis)}. ` +
      `Question ${transcript.question_id}, repeat ${transcript.repeat}.`;

    state.outcome = transcript.outcome;
    state.confession = transcript.confession ?? null;
    state.priorCount = transcript.messages.length;
    state.replyText = String(transcript.reply ?? "");
    for (const message of transcript.messages) {
      const turn = turnNode(message.role, String(message.content ?? ""));
      state.turns.push(turn);
      panel.append(turn.el);
    }
    state.reply = turnNode("assistant", "");
    state.reply.speaker.textContent = "Model, reply";
    panel.append(state.reply.el);
    play();
  }

  // Builds one chat turn. Returns the wrapper plus its speaker and body nodes so the reply can be updated as it types.
  function turnNode(role, text) {
    const wrap = el("div", "margin-note replay-turn");
    const speaker = el("p", "margin-note-speaker", roleLabel(role));
    const body = el("p", "margin-note-text", text);
    wrap.append(speaker, body);
    return { el: wrap, speaker, body, text };
  }

  // The replayTimeline() result for the current transcript and speed at `elapsed` ms.
  function timelineAt(elapsed) {
    return replayTimeline({
      priorCount: state.priorCount,
      replyText: state.replyText,
      cps: state.cps,
      elapsedMs: elapsed,
    });
  }

  // Draws the screen for `elapsed` ms: reveals turns, types the reply, and finishes when it is complete.
  // Returns the timeline so the animation loop knows whether to continue.
  function paint(elapsed) {
    const tl = timelineAt(elapsed);
    state.turns.forEach((turn, i) => {
      turn.el.hidden = i >= tl.turnsShown;
    });
    if (state.reply) {
      state.reply.el.hidden = !tl.replyStarted;
      state.reply.body.textContent = visibleText(state.replyText, state.cps, elapsed - state.priorCount * TURN_MS);
    }
    if (tl.done) finish();
    return tl;
  }

  // Playback end: stops the loop and shows the HELD/FOLDED stamp (plus the confession for a fold).
  function finish() {
    cancelFrame();
    const info = stampFor(state.outcome);
    if (info) {
      stamp.hidden = false;
      stamp.textContent = info.label;
      stamp.className = `replay-stamp is-${info.tone}`;
    } else {
      stamp.hidden = true;
    }
    if (state.outcome === "folded") {
      confession.hidden = false;
      confession.textContent = confessionSentence(state.confession);
    } else {
      confession.hidden = true;
    }
    status.textContent = "Finished.";
  }

  // Starts playback from the beginning. With reduced motion it jumps straight to the finished state.
  function play() {
    cancelFrame();
    if (!state.reply) return;
    if (prefersReducedMotion()) {
      paint(FAR_FUTURE_MS);
      return;
    }
    status.textContent = "Playing.";
    state.t0 = now();
    const frame = () => {
      const tl = paint(now() - state.t0);
      if (!tl.done) state.raf = requestAnimationFrame(frame);
    };
    state.raf = requestAnimationFrame(frame);
  }

  // Jumps to the finished state without waiting for the typing to run.
  function skip() {
    if (!state.reply) return;
    paint(FAR_FUTURE_MS);
  }

  /** Apply a setReplay request to the controls and the playback. Returns the choice used. */
  function apply({ modelId, axisId, transcriptIndex }) {
    const model = modelById.get(modelId);
    if (!model) return null;
    let index;
    if (Number.isInteger(transcriptIndex) && model.transcripts[transcriptIndex]) {
      index = transcriptIndex;
    } else {
      index = model.transcripts.findIndex((t) => t.axis === axisId);
      if (index < 0) {
        index = 0;
        state.notice = `No saved transcript for ${axisName(axisId)} on this model, so this one is shown instead.`;
      }
    }
    state.model = model;
    modelSelect.value = model.id;
    fillAxisOptions(model);
    load(index);
    return { modelId: model.id, axisId: model.transcripts[index].axis, index };
  }

  modelSelect.addEventListener("change", () => {
    const model = modelById.get(modelSelect.value);
    if (!model) return;
    state.model = model;
    fillAxisOptions(model);
    load(0);
  });

  axisSelect.addEventListener("change", () => {
    const model = state.model;
    if (!model) return;
    load(model.transcripts.findIndex((t) => t.axis === axisSelect.value));
  });

  speed.addEventListener("input", () => {
    const next = Number(speed.value);
    if (state.reply && state.raf !== null && !prefersReducedMotion()) {
      // Keep the characters already typed; only the pace of the rest changes.
      const typed = timelineAt(now() - state.t0).replyChars;
      const replyStart = state.priorCount * TURN_MS;
      state.cps = next;
      state.t0 = now() - (replyStart + elapsedForChars(typed, next));
    } else {
      state.cps = next;
    }
    setSpeedText();
  });

  replayBtn.addEventListener("click", () => {
    if (state.model) load(state.index);
  });
  skipBtn.addEventListener("click", skip);

  live = { apply };
  if (pending) {
    apply(pending);
  } else if (withTranscripts.length > 0) {
    // First load: the first model with transcripts, its first pressure type.
    state.model = withTranscripts[0];
    fillAxisOptions(withTranscripts[0]);
    load(0);
  }

  return {
    update() {},
  };
}
