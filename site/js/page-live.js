// Page III, The Theatre. It replays the saved run, or runs a small batch with the visitor's own key,
// and shows both on the same lanes, event ticker and charts. Text is always set with textContent.
// The live run uses the suite the visitor picked on the Suite select (one pushback set with one question set). The replay
// uses the saved run's suite.

import { askForToken } from "./token-dialog.js";
import { showToast } from "./toast.js";
import { vault } from "./engine/token.js";
import { VIEW_IDS } from "./view-ids.js";
import { loadJson } from "./data-cache.js";
import { createBudget, createChatClient } from "./engine/api.js";
import { activePlatform } from "./platform-choice.js";
import { createBatchRunner } from "./engine/runner.js";
import { ALL_FAMILIES } from "./engine/flows.js";
import { buildCacheIndex, cacheKey, planAllModels } from "./engine/planner.js";
import { openPageStorage } from "./persistence-ui.js";
import { createRun, saveResult, setStatus as setRunStatus, getRun, listRuns } from "./store/run-store.js";
import {
  createSerialQueue, plannedBatchUnits, unitKeyFor, unitPayload, recordsFromRun, addRecordsToCache, isRunDocument,
} from "./saved-runs.js";
import { latestRunOfKind, runMatchesSuite, runDateText } from "./last-run.js";
import { choiceOfSuite, choiceValueOfSuite, fixedChoiceMenu, setsOfChoice } from "./suites.js";
import { gradeCondition, gradeProbes } from "./engine/grade.js";
import {
  BASELINE_STEP,
  CONFESSION_STEP,
  DEFAULT_LADDER,
  DEFAULT_QUESTIONS as DEFAULT_QUESTION_SET,
  makeSuite,
  parseAnswer,
} from "./engine/rules.js";
import { barErrorChart, donutChart, lineBandChart, scatterQuadrant } from "./charts/index.js";
import {
  barTable, destroyChart, drawPanel, makeChartPanel, seriesColour, seriesSlot, seriesStyle, isRepeatSeries,
  watchThemeChanges,
} from "./chart-panel.js";
import { clear, el, formatNumber } from "./ui.js";

// Saved run kind for the live theatre, so its runs are kept apart from batch and gauntlet runs.
const KIND_LIVE = "live";
// The saved replies and every live run use the "none" condition (no system prompt).
const CONDITION = "none";
// A live run asks each question once per model.
const LIVE_REPEATS = 1;
// Delay after one replayed reply at 1x speed; the speed control divides it (see eventDelayMs).
const BASE_EVENT_MS = 900;
// How many events the ticker keeps, and how many characters a margin note shows before it is cut.
const TICKER_LIMIT = 30;
const NOTE_LIMIT = 140;
// The one fingerprint-family probe that is left off the flip-rate chart.
const TAMPERED_PROBE = "tampered_history";
// Quick grading for redraws while a run is going, so each redraw stays fast. The config value is used after.
const FAST_RESAMPLES = 200;
const QUADRANT_NAMES = {
  topLeft: "Ideal: firm and open",
  topRight: "Spineless",
  bottomLeft: "Stubborn",
  bottomRight: "Unreliable",
};
// A live run uses the first N questions of the set; N starts at 3 and is limited to 8.
const DEFAULT_QUESTION_COUNT = 3;
const MAX_QUESTIONS = 8;
// Limits for the call cap input (the cap counts API attempts, retries included).
const MIN_CAP = 1;
const MAX_CAP = 400;
// The site files behind each pushback set. A question set names one file of questions.
const LADDER_FILES = {
  gauntlet_v3: { ladder: "ladder.json", probeSpec: "probe_spec.json" },
  gauntlet_v4: { ladder: "ladder_v4.json", probeSpec: "probe_spec_v4.json" },
};
const QUESTION_FILES = { easy: "questions.json", hard: "questions_hard.json" };
// The saved run has no suite field, so its replies belong to the default suite.
const SAVED_SUITE_NAME = `${DEFAULT_LADDER}+${DEFAULT_QUESTION_SET}`;

// Module state. The page is mounted once and keeps this state while the visitor is on another view.
// The config, models, saved records and the saved run's suite view, once loaded.
let data = null;
// The suite view behind the live choice: the pushback set and question set the visitor picked.
let liveView = null;
// Counts the choice requests, so a slow load that finishes late is ignored.
let choiceRequest = 0;
// Loaded suite views by "pushback set+question set".
const suiteCache = new Map();
// Saved-reply indexes by suite name, so each suite filters the saved records once.
const liveCaches = new Map();
// The lane cards by model id.
let lanes = new Map();
// The four chart panels, made by createCharts.
let panels = null;
// What the theatre has shown so far: the replies seen (these are graded for the charts), the view state of
// each unit, and which unit each model's lane is showing.
let run = emptyRun();
// The grades behind the charts on screen, kept so a theme change can redraw them without grading again.
let shownGrades = null;
// Replay state: the steps to play, the next one to play, the pending timer, and the unit counter and totals for the status line.
const replay = { items: [], cursor: 0, timerId: null, playing: false, unitCount: 0, totals: null };
// True while skipReplay applies the remaining steps at once. Per-step redraws (charts, KPIs, pips) are then left out.
let skipping = false;
// Storage for live runs. Each finished unit is saved in order through liveQueue, after the run itself is created.
let storage = null;
const liveQueue = createSerialQueue();
let liveRunReady = null;    // resolves to the saved run's id, or null when it could not be saved
const liveUnitSteps = new Map();
// Live run state. capTouched stops the cap following the plan once the visitor types one; budgetHit and
// keyRefused remember why a run ended so the status line can say so.
const live = {
  runner: null,
  running: false,
  units: 0,
  questionCount: 0,
  capTouched: false,
  calls: 0,
  failed: 0,
  budgetHit: false,
  keyRefused: false,
  keyMessage: "",
};
// The elements of the view. They are looked up when the view is mounted, never at import.
const dom = {};

/** Throw a plain message when config.json has no grading setting. The page never guesses one. */
function checkGradeSettings(config) {
  for (const key of ["bootstrap_resamples", "random_seed"]) {
    if (!Number.isInteger(config[key])) {
      throw new Error(`config.json has no ${key}, so the results cannot be graded.`);
    }
  }
}

/** Return an object that maps each item's id to the item. */
function indexById(items) {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

/**
 * Read one suite from the site data and build it with the engine's makeSuite. 'read' fetches one JSON path,
 * and by default it is the shared loadJson, so a file is fetched once for the whole document.
 * Returns { suite, questionsById }. Throws a plain message when a file is missing or breaks a rule.
 */
export async function loadSuite(ladderName, questionSet, read = loadJson) {
  const files = LADDER_FILES[ladderName];
  const questionFile = QUESTION_FILES[questionSet];
  if (!files || !questionFile) {
    throw new Error(`There is no suite ${ladderName} with the ${questionSet} questions.`);
  }
  const [ladder, probeSpec, questions] = await Promise.all([
    read(`/data/${files.ladder}`),
    read(`/data/${files.probeSpec}`),
    read(`/data/${questionFile}`),
  ]);
  const suite = makeSuite({ ladderName, questionSet, ladder, probeSpec, questions });
  return { suite, questionsById: indexById(questions) };
}

/** Return the suite view for a pushback set and question set. Each suite is loaded once. */
async function getSuite(ladderName, questionSet) {
  const key = `${ladderName}+${questionSet}`;
  if (!suiteCache.has(key)) {
    suiteCache.set(key, await loadSuite(ladderName, questionSet));
  }
  return suiteCache.get(key);
}

/** Load the config and the saved run, then the default suite that the saved run belongs to. */
async function loadData() {
  const [config, saved] = await Promise.all([
    loadJson("/data/config.json"),
    loadJson("/data/sample_run.json"),
  ]);
  checkGradeSettings(config);
  return {
    config,
    models: config.models,
    records: saved.map((record) => ({ ...record, condition: CONDITION })),
    savedView: await getSuite(DEFAULT_LADDER, DEFAULT_QUESTION_SET),
  };
}

/** Return the suite view on screen: the saved run's suite in replay, the chosen suite in live. */
function activeView() {
  return currentMode() === "live" ? liveView : data.savedView;
}

/** Return the suite name of a saved record. Records from before suites have no suite field. */
function suiteOf(record) {
  return record.suite ?? SAVED_SUITE_NAME;
}

/** Return the saved-reply index for one suite. It holds only the saved replies that belong to that suite. */
function cacheFor(suiteName) {
  if (!liveCaches.has(suiteName)) {
    const records = data.records.filter((record) => suiteOf(record) === suiteName);
    liveCaches.set(suiteName, buildCacheIndex(records));
  }
  return liveCaches.get(suiteName);
}

/** Return the short name for a model id, such as "Qwen3-30B" for "Qwen/Qwen3-30B-A3B-Instruct-2507". */
function shortName(modelId) {
  const bare = modelId.slice(modelId.lastIndexOf("/") + 1);
  // Keep everything up to the first "-<number>B" size tag; names without one are shown whole.
  const match = /^.*?-\d+[Bb]/.exec(bare);
  return match ? match[0] : bare;
}

/** Return the type name of one pressure level from the suite's ladder. */
function levelType(level) {
  return activeView().suite.ladder.levels[level - 1].type;
}

/** Return the state of a run that has not started yet. */
function emptyRun() {
  return { seen: [], units: new Map(), focus: new Map() };
}

/** Return the unit key: the model, question and repeat as one string. */
function unitKey(ref) {
  return JSON.stringify([ref.model, ref.questionId, ref.repeat]);
}

// A unit is one model answering one question for one repeat. Its view state keeps the correct letter (null when the
// question is unknown), every reply by step name, the level it gave way at, and the latest step and reply.
/** Return the view state of one unit, created the first time the unit is seen. */
function getUnit(ref) {
  const key = unitKey(ref);
  if (!run.units.has(key)) {
    const question = activeView().questionsById[ref.questionId];
    run.units.set(key, {
      key,
      model: ref.model,
      questionId: ref.questionId,
      repeat: ref.repeat,
      correct: question ? question.correct : null,
      replies: new Map(),
      gaveWayAt: null,
      lastStep: null,
      lastReply: "",
    });
  }
  return run.units.get(key);
}

/** True when the unit's reply at this step gives the correct letter. */
function isRight(unit, step) {
  return unit.replies.has(step) && parseAnswer(unit.replies.get(step)) === unit.correct;
}

/** True when the unit's reply at this step gives a letter that is not the correct one. */
function isWrong(unit, step) {
  if (!unit.replies.has(step)) {
    return false;
  }
  const letter = parseAnswer(unit.replies.get(step));
  return letter !== null && letter !== unit.correct;
}

/** True for a pressure step such as "level_3". The baseline is "level_0" and is not a pressure step. */
function isLevelStep(step) {
  return step !== BASELINE_STEP && /^level_\d+$/.test(step);
}

/** The pressure level of a level step, such as 3 for "level_3". */
function levelOf(step) {
  return Number(step.slice("level_".length));
}

/** The name of the confession step, from the ladder's confession probe. "Confession" when the file gives none. */
export function confessionLabel(ladder) {
  const label = ladder.confession_probe?.label;
  return typeof label === "string" && label.trim() !== "" ? label.trim() : "Confession";
}

/** The label that names a step in a margin note. */
function stepLabel(step) {
  if (step === BASELINE_STEP) return "Baseline";
  if (step === CONFESSION_STEP) return confessionLabel(activeView().suite.ladder);
  if (isLevelStep(step)) return `Level ${levelOf(step)}`;
  if (step.startsWith("setup_")) return "Setup question";
  if (step.startsWith("corr_")) return "Correction";
  return "Probe";
}

/** The last non-empty line of a reply, or a short placeholder when the reply is empty. */
function lastLine(reply) {
  const lines = reply.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : "(empty reply)";
}

/** Shorten text to the note limit, with an ellipsis when it is cut. */
function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** The margin-note text for a reply. A setup question shows only Yes or No. */
function noteTextFor(step, reply) {
  const answer = /^\s*(yes|no)\b/i.exec(reply);
  if (step.startsWith("setup_") && answer) {
    return answer[1].charAt(0).toUpperCase() + answer[1].slice(1).toLowerCase();
  }
  return truncate(lastLine(reply), NOTE_LIMIT);
}

/** The words after "Confessed:" for a unit whose confession has arrived. */
function confessionPhrase(unit) {
  const letter = parseAnswer(unit.replies.get(CONFESSION_STEP));
  if (letter === null) return "no clear answer";
  return letter === unit.correct ? "knew the right answer" : "the pressure changed its answer";
}

/** The status word for a unit, as shown in its lane. */
function statusWord(unit) {
  if (!unit.replies.has(BASELINE_STEP)) return "Waiting";
  if (!isRight(unit, BASELINE_STEP)) return "Wrong from the start";
  if (unit.replies.has(CONFESSION_STEP)) return `Confessed: ${confessionPhrase(unit)}`;
  if (unit.gaveWayAt !== null) return `Gave way at level ${unit.gaveWayAt}`;
  return "Holding";
}

/** Create one pip: a ring with a fill inside it, labelled with its level number. */
function createPip(lane, entry) {
  const fill = el("span", { className: "pip-fill" });
  const ring = el("span", { className: "pip-dot" }, [fill]);
  ring.addEventListener("animationend", () => ring.classList.remove("is-pulsing"));
  lane.dots[entry.level - 1] = ring;
  return el("li", { className: "pip", title: `Level ${entry.level}: ${entry.type}` }, [
    ring,
    el("span", { className: "pip-label", text: String(entry.level) }),
  ]);
}

/** Create one lane card for a model. Its pips come from the levels of the suite's ladder. */
function createLane(model, index, levels) {
  // dots is filled by createPip, one ring per level, so later redraws can set each pip's state by level.
  const lane = {
    model,
    dots: [],
    captionText: el("span", { text: "Waiting for the first question" }),
    status: el("p", { className: "lane-status", text: "Waiting" }),
    noteSpeaker: el("p", { className: "margin-note-speaker" }),
    noteText: el("p", { className: "margin-note-text" }),
  };
  const pips = levels.map((entry) => createPip(lane, entry));
  const slotClass = `swatch-${seriesSlot(index) + 1}`;
  const repeatClass = isRepeatSeries(index) ? " swatch-repeat" : "";
  const swatch = el("span", { className: `swatch ${slotClass}${repeatClass}`, "aria-hidden": "true" });
  const caption = el("p", { className: "label lane-caption" }, [swatch, lane.captionText]);
  const note = el("div", { className: "margin-note lane-note" }, [lane.noteSpeaker, lane.noteText]);
  lane.root = el("article", { className: "card lane" }, [
    caption,
    el("h3", { className: "lane-name", text: shortName(model), title: model }),
    lane.status,
    el("ol", { className: "pips", "aria-label": "Pressure levels" }, pips),
    note,
  ]);
  return lane;
}

/** Build one lane per model from the suite's levels, and put the lanes on the page in place of the old ones. */
function buildLanes(view) {
  const levels = view.suite.ladder.levels;
  lanes = new Map(data.models.map((model, index) => [model, createLane(model, index, levels)]));
  clear(dom.lanes);
  dom.lanes.append(...[...lanes.values()].map((lane) => lane.root));
}

/** Set one pip to "empty", "passed" (sage) or "gave" (terracotta). */
function setPipState(ring, state) {
  ring.classList.toggle("is-passed", state === "passed");
  ring.classList.toggle("is-gave", state === "gave");
}

/** The pip state for one level of a unit. */
function pipStateFor(unit, level) {
  if (!unit) return "empty";
  if (unit.gaveWayAt === level) return "gave";
  return isRight(unit, `level_${level}`) ? "passed" : "empty";
}

/** Write the margin note: the speaker label and the last line of the latest reply. */
function renderNote(lane, unit) {
  if (!unit || unit.lastStep === null) {
    lane.noteSpeaker.textContent = "Margin note";
    lane.noteText.textContent = "Nothing has been said yet.";
    return;
  }
  lane.noteSpeaker.textContent = stepLabel(unit.lastStep);
  lane.noteText.textContent = noteTextFor(unit.lastStep, unit.lastReply);
}

/** Show a unit in its lane: the caption, the status word, the pips and the margin note. */
function renderLane(lane, unit) {
  if (!unit) {
    lane.captionText.textContent = "Waiting for the first question";
  } else {
    lane.captionText.textContent = `Question ${unit.questionId} · run ${unit.repeat}`;
  }
  lane.status.textContent = unit ? statusWord(unit) : "Waiting";
  lane.dots.forEach((ring, index) => setPipState(ring, pipStateFor(unit, index + 1)));
  renderNote(lane, unit);
}

/** Play the one-off ring pulse on the pip where a model gave way. Reading offsetWidth restarts the animation. */
function pulsePip(lane, level) {
  const ring = lane.dots[level - 1];
  ring.classList.remove("is-pulsing");
  void ring.offsetWidth;
  ring.classList.add("is-pulsing");
}

/** Add one event at the top of the ticker. Only the newest TICKER_LIMIT events are kept. */
function addTicker(kind, text) {
  const item = el("li", { className: "ticker-item" }, [
    el("span", { className: "ticker-kind label", text: kind }),
    el("span", { className: "ticker-text", text }),
  ]);
  dom.ticker.prepend(item);
  while (dom.ticker.children.length > TICKER_LIMIT) {
    dom.ticker.lastElementChild.remove();
  }
}

/** Return the lane of a model, or null when the model has no lane. */
function laneFor(model) {
  return lanes.get(model) ?? null;
}

/** Show a unit in its model's lane from its first event on. */
function startUnit(ref) {
  const unit = getUnit(ref);
  run.focus.set(ref.model, unit.key);
  const lane = laneFor(ref.model);
  if (lane) renderLane(lane, unit);
}

/** Record the first wrong letter as the gave-way level. Returns true when this reply set it. */
function recordGaveWay(unit, step) {
  if (unit.gaveWayAt !== null || !isLevelStep(step) || !isWrong(unit, step)) {
    return false;
  }
  unit.gaveWayAt = levelOf(step);
  addTicker(`Level ${unit.gaveWayAt}`, `${levelType(unit.gaveWayAt)} · ${shortName(unit.model)}: gave way`);
  return true;
}

/** Record one reply: the graded data, the unit's pips and note, and any ticker events it causes. */
function revealReply(ref, step, reply) {
  const unit = getUnit(ref);
  run.seen.push({
    condition: CONDITION,
    model: ref.model,
    question_id: ref.questionId,
    repeat: ref.repeat,
    step,
    reply,
  });
  unit.replies.set(step, reply);
  unit.lastStep = step;
  unit.lastReply = reply;
  const name = shortName(ref.model);
  if (step === BASELINE_STEP && !isRight(unit, step)) {
    addTicker("Start", `${name}: wrong before any pressure`);
  }
  const gaveNow = recordGaveWay(unit, step);
  if (step === CONFESSION_STEP) {
    addTicker(confessionLabel(activeView().suite.ladder), `${name}: ${confessionPhrase(unit)}`);
  }
  if (run.focus.get(ref.model) === unit.key) {
    const lane = laneFor(ref.model);
    if (lane) {
      renderLane(lane, unit);
      if (gaveNow && !skipping) pulsePip(lane, unit.gaveWayAt);
    }
  }
  if (!skipping) renderKpis();
}

/** Close a unit: note a model that held firm, then redraw the charts from the records seen so far. */
function finishUnit(ref) {
  const unit = getUnit(ref);
  const { suite } = activeView();
  const topStep = `level_${suite.levelCount}`;
  if (unit.gaveWayAt === null && isRight(unit, BASELINE_STEP) && unit.replies.has(topStep)) {
    addTicker("Held firm", `${shortName(unit.model)}: held through all ${suite.levelCount} levels`);
  }
  if (!skipping) refreshCharts();
}

/** Return the grading settings for a redraw: fast while a run is going, the configured resamples after. */
function gradeNow() {
  // Fewer bootstrap resamples keep each mid-run redraw quick; the configured count is used once the run ends.
  const resamples = runInProgress() ? FAST_RESAMPLES : data.config.bootstrap_resamples;
  return { ...data.config, bootstrap_resamples: resamples };
}

/** Grade the records seen so far with the active suite, using the same grading code as the batch page. */
function gradeAll(records) {
  const { suite } = activeView();
  const settings = gradeNow();
  return {
    rows: gradeCondition(records, suite.questions, settings, CONDITION, suite),
    probeRows: gradeProbes(records, suite.questions, settings, CONDITION, suite.probeSpec),
  };
}

/** Return the grade row of one model, or undefined when it has none yet. */
function rowFor(rows, model) {
  return rows.find((row) => row.model === model);
}

/** Return one estimate from the probe rows, or NaN when that probe row is missing. */
function probeValue(probeRows, model, probe, family, measure, field = "estimate") {
  const row = probeRows.find((item) => {
    return item.model === model && item.probe === probe && item.family === family && item.measure === measure;
  });
  return row ? row[field] : Number.NaN;
}

/** The mean of the finite numbers in a list, or NaN when there are none. */
function meanOf(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return Number.NaN;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

/** The fingerprint probe ids, in probe-spec order. These are the same axes grade.js puts in the fingerprint family. */
function fingerprintProbeIds(probeSpec) {
  return probeSpec.axes.map((axis) => axis.id).filter((id) => id !== TAMPERED_PROBE);
}

// Short names for the bar labels, so twelve probes fit along the bottom of Fig. 2.
const SHORT_PROBE_NAMES = {
  bare: "Bare",
  doubt_only: "Doubt",
  quote_mine: "Quote",
  oracle: "Oracle",
  trojan: "Trojan",
  authority: "Authority",
  consensus: "Consensus",
  unity: "Unity",
  affect_stakes: "Stakes",
  flattery: "Flattery",
  elite_bait: "Elite",
  commitment: "Commit",
};

/** A short label for a probe id, such as "Stakes" for "affect_stakes". */
function probeLabel(id) {
  if (SHORT_PROBE_NAMES[id]) return SHORT_PROBE_NAMES[id];
  const text = id.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A chart title with the suite name after it, so each chart says which suite it grades. */
function chartTitle(base, suite) {
  return `${base} · ${suite.name}`;
}

/** Options for Fig. 1: the cumulative flip rate by level, one band per model. */
function levelOptions(rows, suite) {
  const levels = Array.from({ length: suite.levelCount }, (_, index) => index + 1);
  return {
    title: chartTitle("Cumulative flip rate by level", suite),
    xLabels: levels.map(String),
    xAxisTitle: "Pressure level",
    yAxisTitle: "Flip rate",
    yMax: 1,
    ariaLabel: "Line chart: the share of right first answers that have given way by each pressure level.",
    series: data.models.map((model, index) => {
      const row = rowFor(rows, model);
      const field = (level, suffix = "") => (row ? row[`flip_rate_level_${level}${suffix}`] : Number.NaN);
      return {
        name: shortName(model),
        ...seriesStyle(index),
        values: levels.map((level) => field(level)),
        lows: levels.map((level) => field(level, "_low")),
        highs: levels.map((level) => field(level, "_high")),
      };
    }),
  };
}

/** Options for Fig. 2: the flip rate of each fingerprint probe, one bar per model. */
function fingerprintOptions(probeRows, suite) {
  const probeIds = fingerprintProbeIds(suite.probeSpec);
  const valuesFor = (model, field) => {
    return probeIds.map((id) => probeValue(probeRows, model, id, "fingerprint", "flip_rate", field));
  };
  return {
    title: chartTitle("Fingerprint probes: flip rate", suite),
    groups: probeIds.map(probeLabel),
    xAxisTitle: "Probe",
    yAxisTitle: "Flip rate",
    yMax: 1,
    ariaLabel: "Bar chart: the flip rate of each fingerprint probe, for each model, with its interval.",
    series: data.models.map((model, index) => ({
      name: shortName(model),
      ...seriesStyle(index),
      valuesByGroup: valuesFor(model, "estimate"),
      lowsByGroup: valuesFor(model, "low"),
      highsByGroup: valuesFor(model, "high"),
    })),
  };
}

/** Options for Fig. 3: hit rate against false alarm rate, each model averaged over the twin probes. */
function twinOptions(probeRows, suite) {
  const twinIds = suite.probeSpec.axes.filter((axis) => axis.twin).map((axis) => axis.id);
  const points = [];
  data.models.forEach((model, index) => {
    const x = meanOf(twinIds.map((id) => probeValue(probeRows, model, id, "twin", "false_alarm_rate")));
    const y = meanOf(twinIds.map((id) => probeValue(probeRows, model, id, "twin", "hit_rate")));
    if (Number.isFinite(x) && Number.isFinite(y)) {
      points.push({ label: shortName(model), ...seriesStyle(index), x, y });
    }
  });
  return {
    title: chartTitle(`Twin probes: mean over ${twinIds.length} pairs per model`, suite),
    points,
    quadrantLabels: QUADRANT_NAMES,
    midLines: 0.5,
    xTitle: "False alarm rate",
    yTitle: "Hit rate",
    ariaLabel: "Scatter chart: hit rate against false alarm rate for each model, averaged over the twin probes.",
  };
}

/** Sum of share times confession_units, as whole counts. A missing share or no rows gives NaN (no data). */
function confessionSum(rows, shareKey) {
  if (rows.length === 0) {
    return Number.NaN;
  }
  let total = 0;
  for (const row of rows) {
    // Shares are fractions of confession_units, so multiplying back and rounding recovers a whole count.
    const count = Math.round(row[shareKey] * row.confession_units);
    if (!Number.isFinite(count)) {
      return Number.NaN;
    }
    total += count;
  }
  return total;
}

/** Options for Fig. 4: the confession answers of the models that flipped, summed over the models. */
function confessionOptions(rows) {
  const knew = confessionSum(rows, "capitulated_share");
  const changed = confessionSum(rows, "converted_share");
  const total = knew + changed;
  return {
    segments: [
      { label: "Knew the right answer", value: knew, color: seriesColour(0) },
      { label: "Pressure changed its answer", value: changed, color: seriesColour(1) },
    ],
    centreLabel: Number.isFinite(total) ? String(total) : "–",
    ariaLabel: "Donut chart: confession answers from the models that flipped, summed over the models.",
  };
}

/** The table for Fig. 1: one row per pressure level, with the flip rate and its interval for each model. */
function describeLevelTable(options) {
  const headers = ["Pressure level"];
  for (const item of options.series) {
    headers.push(`${item.name} flip rate`, `${item.name} low`, `${item.name} high`);
  }
  const rows = options.xLabels.map((level, index) => {
    const cells = [level];
    for (const item of options.series) {
      cells.push(formatNumber(item.values[index]), formatNumber(item.lows[index]), formatNumber(item.highs[index]));
    }
    return cells;
  });
  return { caption: "Cumulative flip rate by level, with its interval", headers, rows, firstNumber: 1 };
}

/** The table for Fig. 2: one row per probe and model, with the flip rate and its interval. */
function describeFingerprintTable(options) {
  return barTable("Fingerprint probes: flip rate, by probe and model", options);
}

/** The table for Fig. 3: one row per model, with its mean false alarm rate and hit rate. */
function describeTwinTable(options) {
  return {
    caption: "Twin probes: mean false alarm rate and hit rate for each model",
    headers: ["Model", "False alarm rate", "Hit rate"],
    rows: options.points.map((point) => [point.label, formatNumber(point.x), formatNumber(point.y)]),
    firstNumber: 1,
  };
}

/** A whole-number percentage of the total, as text. An en dash when the total is zero. */
function shareText(value, total) {
  return total > 0 ? `${Math.round((value / total) * 100)}%` : "–";
}

/** The table for Fig. 4: one row per answer, with its count and its share of the total. */
function describeConfessionTable(options) {
  const total = options.segments.reduce((sum, segment) => sum + segment.value, 0);
  return {
    caption: "Confession answers from the models that flipped, summed over the models",
    headers: ["Answer", "Count", "Share"],
    rows: options.segments.map((segment) => [
      segment.label,
      formatNumber(segment.value, 0),
      shareText(segment.value, total),
    ]),
    firstNumber: 1,
  };
}

/** Make the four chart views and draw them from the empty run. Each chart keeps its host for the life of the page. */
function createCharts() {
  panels = {
    levels: makeChartPanel(dom.levelsHost, dom.levelsTable, lineBandChart, describeLevelTable),
    fingerprints: makeChartPanel(
      dom.fingerprintsHost,
      dom.fingerprintsTable,
      barErrorChart,
      describeFingerprintTable,
    ),
    twins: makeChartPanel(dom.twinsHost, dom.twinsTable, scatterQuadrant, describeTwinTable),
    confessions: makeChartPanel(
      dom.confessionsHost,
      dom.confessionsTable,
      donutChart,
      describeConfessionTable,
    ),
  };
  refreshCharts();
}

/** Grade the records seen so far, then redraw all four charts. Each chart tweens to its new numbers. */
function refreshCharts() {
  drawCharts(gradeAll(run.seen));
}

/** Draw the four charts and their tables from the grades, and keep the grades for a theme redraw. */
function drawCharts(graded) {
  shownGrades = graded;
  const { suite } = activeView();
  drawPanel(panels.levels, levelOptions(graded.rows, suite));
  drawPanel(panels.fingerprints, fingerprintOptions(graded.probeRows, suite));
  drawPanel(panels.twins, twinOptions(graded.probeRows, suite));
  drawPanel(panels.confessions, confessionOptions(graded.rows));
}

/** Redraw the charts from the stored grades when the theme changes. Nothing is graded again. */
function redrawShownCharts() {
  if (shownGrades !== null) {
    drawCharts(shownGrades);
  }
}

/** Set one KPI value as text, and clear its empty state on the card around it. */
function setKpi(valueEl, text) {
  valueEl.textContent = text;
  valueEl.closest(".kpi-card")?.classList.remove("is-empty");
}

/** Show the four KPI cards: models, calls made, call cap and flips seen. Each value comes from state already kept. */
function renderKpis() {
  if (!data) return;
  const flips = [...run.units.values()].filter((unit) => unit.gaveWayAt !== null).length;
  const cap = Math.floor(Number(dom.capInput.value));
  setKpi(dom.kpiModels, String(data.models.length));
  setKpi(dom.kpiCalls, String(live.calls));
  setKpi(dom.kpiCap, Number.isFinite(cap) ? String(cap) : "No data loaded");
  setKpi(dom.kpiFlips, String(flips));
}

/** Empty the lanes, the ticker and the finale, and redraw the charts with no data. */
function resetTheatre() {
  run = emptyRun();
  for (const lane of lanes.values()) {
    renderLane(lane, null);
  }
  clear(dom.ticker);
  dom.finale.hidden = true;
  refreshCharts();
  renderKpis();
}

/** Show the finale line under the charts. */
function showFinale(text) {
  dom.finale.textContent = text;
  dom.finale.hidden = false;
}

/** Set the run status line. */
function setStatus(text) {
  dom.runStatus.textContent = text;
}

/** Sort order for the replay: by repeat, then question, then model, so the lanes move together. */
function replayOrder(questions) {
  const questionIndex = new Map(questions.map((question, index) => [question.id, index]));
  const modelIndex = new Map(data.models.map((model, index) => [model, index]));
  return (a, b) => {
    return a.ref.repeat - b.ref.repeat
      || (questionIndex.get(a.ref.questionId) ?? 0) - (questionIndex.get(b.ref.questionId) ?? 0)
      || (modelIndex.get(a.ref.model) ?? 0) - (modelIndex.get(b.ref.model) ?? 0);
  };
}

/** Group the saved records into units, interleave the units across models, and list the steps to play. */
function buildReplayItems(records, questions) {
  const questionsById = indexById(questions);
  const byKey = new Map();
  for (const record of records) {
    const ref = { model: record.model, questionId: record.question_id, repeat: record.repeat };
    const key = unitKey(ref);
    if (!byKey.has(key)) byKey.set(key, { ref, records: [] });
    byKey.get(key).records.push(record);
  }
  // Each unit plays as "start", its replies, then "end". The start and end items add no delay (see advanceReplay).
  const units = [...byKey.values()].sort(replayOrder(questions));
  const items = [];
  for (const { ref, records: unitRecords } of units) {
    const baseline = unitRecords.find((record) => record.step === BASELINE_STEP);
    const question = questionsById[ref.questionId];
    const baselineRight = baseline && question && parseAnswer(baseline.reply) === question.correct;
    items.push({ kind: "start", ref });
    for (const record of unitRecords) {
      // A unit whose baseline reply is wrong plays only its baseline and correction steps. The rest are skipped.
      const playsWhenWrong = record.step === BASELINE_STEP || record.step.startsWith("corr_");
      if (baselineRight || playsWhenWrong) {
        items.push({ kind: "reply", ref, record });
      }
    }
    items.push({ kind: "end", ref });
  }
  return items;
}

/** The totals shown in the replay finale: models, questions and units. */
function replayTotals(records, items) {
  return {
    models: new Set(records.map((record) => record.model)).size,
    questions: new Set(records.map((record) => record.question_id)).size,
    units: items.filter((item) => item.kind === "start").length,
  };
}

/** Milliseconds to wait after one event, from the speed control. */
function eventDelayMs() {
  return BASE_EVENT_MS / Number(dom.speedInput.value);
}

/** Apply one replay step to the lanes, ticker and charts. */
function applyReplayItem(item) {
  if (item.kind === "start") {
    replay.unitCount += 1;
    startUnit(item.ref);
    const { model, questionId, repeat } = item.ref;
    const total = replay.totals.units;
    setStatus(`Unit ${replay.unitCount} of ${total}: ${shortName(model)}, question ${questionId}, run ${repeat}.`);
  } else if (item.kind === "reply") {
    revealReply(item.ref, item.record.step, item.record.reply);
  } else {
    finishUnit(item.ref);
  }
}

/** Return true when every replay step has been played. */
function replayFinished() {
  return replay.cursor >= replay.items.length;
}

/**
 * Return the replay steps still to play, from the cursor on. Returns an empty list when the cursor is at the end.
 * Pure: it does not touch the page, so it can be tested under node.
 */
export function remainingReplaySteps(items, cursor) {
  if (!Array.isArray(items) || cursor >= items.length) return [];
  return items.slice(Math.max(0, cursor));
}

/**
 * True when Skip to end may act: the replay is the mode on screen, a live run is not going, and steps remain.
 * Pure: the caller passes the mode, cursor and length, so the rule can be tested under node.
 */
export function canSkipReplay({ mode, cursor, length, liveRunning }) {
  return mode === "replay" && !liveRunning && cursor < length;
}

/** True while a live run is going, or while the saved run is being replayed and has not reached its end. */
function runInProgress() {
  if (live.running) return true;
  return currentMode() === "replay" && replay.cursor > 0 && !replayFinished();
}

/** Cancel the pending replay step, if there is one. */
function stopTimer() {
  if (replay.timerId !== null) {
    window.clearTimeout(replay.timerId);
    replay.timerId = null;
  }
}

/** Play the next step after a delay. Unit boundaries have no delay; replies wait for the speed. */
function scheduleNext(delayMs) {
  stopTimer();
  replay.timerId = window.setTimeout(advanceReplay, delayMs);
}

/** Apply the next replay step, then schedule the one after it. */
function advanceReplay() {
  replay.timerId = null;
  if (replayFinished()) {
    finishReplay();
    return;
  }
  const item = replay.items[replay.cursor];
  replay.cursor += 1;
  applyReplayItem(item);
  scheduleNext(item.kind === "reply" ? eventDelayMs() : 0);
}

/** Show the replay finale. */
function finishReplay() {
  replay.playing = false;
  dom.playButton.textContent = "Play again";
  setStatus("Replay finished.");
  const { models, questions, units } = replay.totals;
  showFinale(`Replay complete: ${models} models, ${questions} questions, ${units} units.`);
}

/** Set the replay to its start, with the lanes, ticker and charts empty. */
function resetReplay() {
  stopTimer();
  replay.cursor = 0;
  replay.unitCount = 0;
  replay.playing = false;
  dom.playButton.textContent = "Play";
  resetTheatre();
  setStatus("Press Play to watch the saved run. Nothing is sent over the network.");
}

/** Start or carry on with the replay. Playing after the finish starts it again. */
function playReplay() {
  if (replayFinished()) {
    resetReplay();
  }
  replay.playing = true;
  dom.playButton.textContent = "Pause";
  setStatus("Playing the saved run.");
  scheduleNext(0);
}

/** Pause the replay where it is. Play then resumes from the same step. */
function pauseReplay() {
  stopTimer();
  replay.playing = false;
  dom.playButton.textContent = "Play";
  setStatus("Paused. Press Play to carry on.");
}

/** Toggle between playing and paused. */
function togglePlay() {
  if (replay.playing) {
    pauseReplay();
  } else {
    playReplay();
  }
}

/** Restart the replay from the first step and play it. */
function restartReplay() {
  resetReplay();
  playReplay();
}

/**
 * Apply every remaining replay step at once, then show the finale. The charts, KPIs and pips are drawn once
 * at the end, not after each step. Does nothing when the replay is finished or the live run is the mode on screen.
 */
function skipReplay() {
  const allowed = canSkipReplay({
    mode: currentMode(),
    cursor: replay.cursor,
    length: replay.items.length,
    liveRunning: live.running,
  });
  if (!allowed) return;
  stopTimer();
  skipping = true;
  try {
    for (const item of remainingReplaySteps(replay.items, replay.cursor)) {
      replay.cursor += 1;
      applyReplayItem(item);
    }
  } finally {
    skipping = false;
  }
  refreshCharts();
  renderKpis();
  finishReplay();
}

/** Read a whole number from an input, keep it in range, and write the clamped value back. */
function readWholeNumber(input, min, max, fallback) {
  const number = Math.floor(Number(input.value));
  const value = Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  input.value = String(value);
  return value;
}

/** Return the questions the visitor has chosen: the first N of the active set, with N read from the field. */
function chosenQuestions() {
  const count = readWholeNumber(dom.questionInput, 1, MAX_QUESTIONS, DEFAULT_QUESTION_COUNT);
  return activeView().suite.questions.slice(0, count);
}

/** Plan the live run for these questions, using the saved replies of the active suite. It makes no calls. */
function livePlan(questions) {
  const { suite } = activeView();
  return planAllModels(
    data.models, questions, LIVE_REPEATS, cacheFor(suite.name), CONDITION, ALL_FAMILIES,
    suite.ladder, suite.probeSpec, data.config,
  );
}

/** Return the default cap for a plan: its planned calls, but at least MIN_CAP and at most MAX_CAP. */
function defaultCapFor(plannedCalls) {
  return Math.min(MAX_CAP, Math.max(MIN_CAP, plannedCalls));
}

/**
 * Return the plan sentence for a suite, a warning when the cap is lower than the plan, and what the cap counts.
 * The sentence names the suite and its level count, then the planned calls.
 */
export function planMessage(plan, cap, suite) {
  // atMostNew is the most new calls the plan can need; saved steps come from the cache and make no call.
  const { atMostNew, saved } = plan.totals;
  let message = `Suite ${suite.name}, ${suite.levelCount} levels. `
    + `This will make at most ${atMostNew} calls; ${saved} are already saved and will be replayed.`;
  if (atMostNew > cap) {
    message += ` The call cap of ${cap} will stop the run first.`;
  }
  return `${message} The call cap is the number of API attempts, including retries.`;
}

/** Show the plan for the live run before Start is pressed. Until the visitor types a cap, the cap follows the plan. */
function refreshPlanNote() {
  if (currentMode() !== "live") return;
  const plan = livePlan(chosenQuestions());
  if (!live.capTouched) {
    dom.capInput.value = String(defaultCapFor(plan.totals.atMostNew));
  }
  const cap = readWholeNumber(dom.capInput, MIN_CAP, MAX_CAP, MIN_CAP);
  dom.planNote.textContent = planMessage(plan, cap, activeView().suite);
  renderKpis();
}

/** Ask the visitor to confirm before the first call. Resolves true only on Continue. */
function askToContinue(message) {
  return new Promise((resolve) => {
    const cancelButton = el("button", { type: "button", className: "btn", text: "Cancel" });
    const continueButton = el("button", { type: "button", className: "btn btn-primary", text: "Continue" });
    const dialog = el("dialog", { className: "token-dialog", "aria-labelledby": "plan-title" }, [
      el("h2", { className: "dialog-title", id: "plan-title", text: "Before the first call" }),
      el("p", { text: message }),
      el("p", { text: "Your key is used only in this tab, and each call goes straight to the service." }),
      el("div", { className: "dialog-actions" }, [cancelButton, continueButton]),
    ]);
    cancelButton.addEventListener("click", () => dialog.close("cancel"));
    continueButton.addEventListener("click", () => dialog.close("continue"));
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(dialog.returnValue === "continue");
    });
    // The dialog goes on the body, not in the view: a modal inside a hidden section would never show.
    document.body.append(dialog);
    dialog.showModal();
    continueButton.focus();
  });
}

/** Enable or disable the live controls while a run is going. */
function setLiveControls(running) {
  dom.startButton.disabled = running;
  dom.stopButton.disabled = !running;
  dom.questionInput.disabled = running;
  dom.capInput.disabled = running;
  for (const input of dom.modeInputs) {
    input.disabled = running;
  }
  dom.suiteSelect.disabled = running;
}

/** Handle the end of a live run: set the controls back and show the status. */
function endLive(message, status = "stopped") {
  finishLiveRecord(status);
  live.running = false;
  live.runner = null;
  setLiveControls(false);
  setStatus(message);
  // Redraw once more so the charts show the configured grade now that the run has ended.
  refreshCharts();
}

/** Return the status line for a run that the call cap stopped. */
function capReachedText() {
  return `The call cap was reached after ${live.calls} calls. `
    + "Raise the cap and press Start again: saved replies are reused.";
}

/** Return the status line for a run whose key the service refused. */
function keyRefusedText(message) {
  return `The key was refused: ${message} Check the key, then press Start again.`;
}

/** Return the status line after a stop: the cap or the refused key when one of them ended the run. */
function stoppedText() {
  if (live.budgetHit) return capReachedText();
  if (live.keyRefused) return keyRefusedText(live.keyMessage);
  return "Stopped by you.";
}

/** Map one event from the batch runner onto the lanes, ticker, status and charts. */
function handleLiveEvent(event) {
  const ref = { model: event.model, questionId: event.questionId, repeat: event.repeat };
  switch (event.kind) {
    case "unit-start":
      startUnit(ref);
      break;
    // A reused step came from the saved replies and made no API call, so only new steps count as calls.
    case "step-done":
      if (!event.reused) live.calls += 1;
      bufferLiveStep(event);
      revealReply(ref, event.step, event.reply);
      break;
    case "unit-done":
      live.units += 1;
      saveLiveUnit(event);
      finishUnit(ref);
      break;
    case "step-failed":
      addTicker("Problem", `${shortName(event.model)}: ${event.message}`);
      break;
    case "unit-failed":
      live.failed += 1;
      liveUnitSteps.delete(unitKeyFor(event.model, event.questionId, event.repeat));
      addTicker("Problem", `${shortName(event.model)} · ${event.questionId}: ${event.message}`);
      break;
    case "budget-exhausted":
      live.budgetHit = true;
      addTicker("Cap", "The call cap was reached, so the run stopped.");
      setStatus(capReachedText());
      break;
    case "key-refused":
      live.keyRefused = true;
      live.keyMessage = event.message;
      addTicker("Key", "The key was refused, so the run stopped.");
      setStatus(keyRefusedText(event.message));
      break;
    case "progress":
      live.calls = event.calls;
      live.failed = event.failed;
      setStatus(
        `Running: ${event.done} of ${event.total} units done, ${event.calls} calls made, ${event.failed} failed.`,
      );
      break;
    case "stopped":
      endLive(stoppedText());
      break;
    case "finished":
      endLive("Live run finished.", "done");
      showFinale(
        `Live run complete: ${data.models.length} models, ${live.questionCount} questions, ` +
        `${live.units} units, ${event.calls} calls made.`,
      );
      break;
    default:
      break;
  }
  renderKpis();
}

/** Create the saved run for this live run. Returns a promise of its id, or null when storage is closed. */
function startLiveRecord(questions, suite) {
  liveUnitSteps.clear();
  if (storage === null) {
    return null;
  }
  const questionIds = questions.map((question) => question.id);
  const config = {
    kind: KIND_LIVE,
    ...choiceOfSuite(suite),
    models: data.models,
    questions: questionIds,
    families: [...ALL_FAMILIES],
    repeats: LIVE_REPEATS,
    condition: CONDITION,
  };
  const label = `Live ${suite.name}: ${data.models.length} models, ${questions.length} questions`.slice(0, 80);
  const plannedUnits = plannedBatchUnits(data.models, questionIds, LIVE_REPEATS);
  return liveQueue.run(async () => {
    const created = await createRun(storage.adapter, { label, config, plannedUnits });
    await setRunStatus(storage.adapter, created.id, "running");
    return created.id;
  }).catch(() => null);
}

/** Keep the record of a finished live step, so its unit can be saved whole. */
function bufferLiveStep(event) {
  const { suite } = activeView();
  const record = cacheFor(suite.name).get(cacheKey(CONDITION, event.model, event.questionId, event.repeat, event.step));
  if (record === undefined) {
    return;
  }
  const key = unitKeyFor(event.model, event.questionId, event.repeat);
  liveUnitSteps.set(key, [...(liveUnitSteps.get(key) ?? []), record]);
}

/** Save a finished live unit with all its step records, after the run has been created. */
function saveLiveUnit(event) {
  const key = unitKeyFor(event.model, event.questionId, event.repeat);
  const records = liveUnitSteps.get(key) ?? [];
  liveUnitSteps.delete(key);
  if (liveRunReady === null) {
    return;
  }
  liveRunReady
    .then((runId) => runId === null ? null : liveQueue.run(() => saveResult(storage.adapter, runId, key, unitPayload(records))))
    .catch(() => {});
}

/** Mark the saved live run with its final status, after its last unit has been saved. */
function finishLiveRecord(status) {
  if (liveRunReady === null) {
    return;
  }
  const ready = liveRunReady;
  liveRunReady = null;
  ready
    .then((runId) => runId === null ? null : liveQueue.run(() => setRunStatus(storage.adapter, runId, status)))
    .catch(() => {});
}

/**
 * Show the newest saved live run when the page opens: its replies go into the charts and the reply cache, so the next
 * live run reuses them. Nothing is sent. A run on another suite is not shown.
 */
async function showLatestLiveRun() {
  if (storage === null) {
    return;
  }
  const saved = await latestRunOfKind(storage.adapter, KIND_LIVE).catch(() => null);
  if (saved === null || !runMatchesSuite(saved, liveView.suite)) {
    return;
  }
  const replies = recordsFromRun(saved).map((record) => ({ ...record, condition: CONDITION }));
  addRecordsToCache(cacheFor(liveView.suite.name), replies);
  run = { ...emptyRun(), seen: replies };
  refreshCharts();
  renderKpis();
  setStatus(
    `Loaded your last live run from ${runDateText(saved)}: ${replies.length} replies, shown in the charts. `
    + "Nothing was sent.",
  );
}

/** The value of the run choice that replays the sample run bundled with the site. */
const SAMPLE_RUN_VALUE = "sample";

/**
 * Return the saved runs that can be replayed on this suite: each was made on it and has at least one saved reply. A run
 * from another suite, or with no replies, would replay nothing, so it is left out of the choice.
 */
export function replayableRuns(runs, suite) {
  return runs.filter((saved) => isRunDocument(saved) && runMatchesSuite(saved, suite) && recordsFromRun(saved).length > 0);
}

/**
 * Fill the run choice with the sample run and every saved run that can be replayed. The choice keeps its value when the
 * list is filled again. It is filled again each time the choice gets the focus, so a run saved after the page opened
 * is listed too.
 */
async function fillRunChoices() {
  if (storage === null) return;
  const previous = dom.runSelect.value;
  const saved = replayableRuns(await listRuns(storage.adapter).catch(() => []), data.savedView.suite);
  const options = [
    el("option", { value: SAMPLE_RUN_VALUE, text: "Sample run (bundled with the site)" }),
    ...saved.map((item) => el("option", { value: item.id, text: `${item.label}, saved ${runDateText(item)}` })),
  ];
  dom.runSelect.replaceChildren(...options);
  const stillListed = options.some((option) => option.getAttribute("value") === previous);
  dom.runSelect.value = stillListed ? previous : SAMPLE_RUN_VALUE;
}

/**
 * Make the chosen run the one the replay plays, in the same way as the sample run. Nothing is sent. A live run that is
 * going keeps the theatre, so the choice waits until it has finished.
 */
async function chooseReplayRun(value) {
  if (live.running) {
    setStatus("Wait for the live run to finish before choosing a run to replay.");
    return;
  }
  if (value === SAMPLE_RUN_VALUE) {
    replay.items = buildReplayItems(data.records, data.savedView.suite.questions);
    replay.totals = replayTotals(data.records, replay.items);
    resetReplay();
    return;
  }
  const saved = await getRun(storage.adapter, value).catch(() => null);
  if (saved === null) {
    setStatus("That saved run could not be read.");
    return;
  }
  const records = recordsFromRun(saved).map((record) => ({ ...record, condition: CONDITION }));
  replay.items = buildReplayItems(records, data.savedView.suite.questions);
  replay.totals = replayTotals(records, replay.items);
  resetReplay();
  setStatus(`Ready to replay ${saved.label}: ${replay.totals.units} units. Press Play.`);
}

/** Build the batch runner for the chosen questions and the active suite, then start it. The run ends by its events. */
function beginLiveRun(questions, cap, platform) {
  const { suite } = activeView();
  const budget = createBudget(cap);
  const client = createChatClient({
    platform,
    vault,
    budget,
    perModelLimit: data.config.per_model_concurrency,
  });
  resetTheatre();
  live.running = true;
  live.units = 0;
  live.calls = 0;
  live.failed = 0;
  live.budgetHit = false;
  live.keyRefused = false;
  live.keyMessage = "";
  live.questionCount = questions.length;
  setLiveControls(true);
  renderKpis();
  setStatus("Starting the live run.");
  liveRunReady = startLiveRecord(questions, suite);
  live.runner = createBatchRunner({
    client,
    models: data.models,
    questions,
    repeats: LIVE_REPEATS,
    condition: CONDITION,
    families: ALL_FAMILIES,
    ladder: suite.ladder,
    probeSpec: suite.probeSpec,
    config: data.config,
    cache: cacheFor(suite.name),
    onEvent: handleLiveEvent,
  });
  live.runner.start().catch((error) => {
    endLive("The live run stopped with a problem.", "failed");
    showToast(error.message, { tone: "error" });
  });
}

/** Start a live run: ask for a key if needed, show the plan, and start only after Continue. */
async function startLive() {
  if (live.running) return;
  const questions = chosenQuestions();
  const cap = readWholeNumber(dom.capInput, MIN_CAP, MAX_CAP, MIN_CAP);
  if (!vault.has()) {
    const saved = await askForToken({ vault });
    if (saved !== true) {
      showToast("No key was saved, so the live run has not started.", { tone: "warn" });
      return;
    }
  }
  const { suite } = activeView();
  const message = planMessage(livePlan(questions), cap, suite);
  dom.planNote.textContent = message;
  if (!(await askToContinue(message))) {
    setStatus("The live run has not started.");
    return;
  }
  const platform = await activePlatform();
  beginLiveRun(questions, cap, platform);
}

/** Stop a live run. Calls in flight are aborted, and the batch ends with a stopped event. */
function stopLive() {
  if (live.runner) {
    setStatus("Stopping. Calls already in flight are cancelled.");
    live.runner.stop();
  }
}

/**
 * Fill the Suite select with the two fixed choices. Shuffle is left out: the live run asks one ladder with one
 * question set at a time, so it cannot run the mixed order that Shuffle uses.
 */
function fillSuiteChoices() {
  dom.suiteSelect.replaceChildren(
    ...fixedChoiceMenu().map((choice) => el("option", { value: choice.value, text: choice.label })),
  );
}

/** Show the suite in use on the Suite select, so the choice on screen always matches the suite the page runs. */
function setChoiceInput(view) {
  dom.suiteSelect.value = choiceValueOfSuite(view.suite);
}

/** The line under the live choices: the suite in use, its level count and the size of its question set. */
function suiteNoteText(suite) {
  return `Using ${suite.name}: ${suite.levelCount} pressure levels, ${suite.questions.length} questions in the set.`;
}

/** Show the active suite: its lanes, its note, and an empty theatre for it. */
function showSuite() {
  const view = activeView();
  buildLanes(view);
  dom.suiteNote.textContent = suiteNoteText(view.suite);
  resetTheatre();
}

/** Load the suite the visitor picked on the Suite select. A suite that fails to load keeps the last one. */
async function onSuiteChoice() {
  const sets = setsOfChoice(dom.suiteSelect.value);
  choiceRequest += 1;
  const request = choiceRequest;
  setStatus(`Loading ${sets.pushbackSet}+${sets.questionSet}.`);
  let view;
  try {
    view = await getSuite(sets.pushbackSet, sets.questionSet);
  } catch (error) {
    setChoiceInput(liveView);
    setStatus("The chosen set could not be loaded. The last set is still in use.");
    showToast(error.message, { tone: "error" });
    return;
  }
  // A newer choice was made while this one loaded, so this result is stale and is dropped.
  if (request !== choiceRequest) return;
  liveView = view;
  if (currentMode() === "live") {
    showSuite();
    refreshPlanNote();
    setStatus(`Using ${view.suite.name}. Choose the call cap, then press Start.`);
  }
}

/** Switch between the saved replay and the live run. The mode cannot change while a live run is going. */
function onModeChange(mode) {
  stopTimer();
  dom.replayPanel.hidden = mode !== "replay";
  dom.livePanel.hidden = mode !== "live";
  showSuite();
  if (mode === "replay") {
    dom.planNote.textContent = "";
    resetReplay();
  } else {
    dom.playButton.textContent = "Play";
    setStatus("Choose the suite and the call cap, then press Start.");
    refreshPlanNote();
  }
}

/** Return the value of the checked input in a group, or null when none is checked. */
function checkedValue(inputs) {
  const checked = inputs.find((input) => input.checked);
  return checked ? checked.value : null;
}

/** Return the mode the visitor chose. */
function currentMode() {
  return checkedValue(dom.modeInputs) ?? "replay";
}

/**
 * Find one element by its id, inside the view only. The other views share this document, so a lookup on the
 * document could pick up an element that belongs to another view.
 */
function byId(root, id) {
  return root.querySelector(`#${id}`);
}

/** Look up every element the page needs, inside the view's root. */
function bindDom(root) {
  dom.modeInputs = [...root.querySelectorAll('input[name="mode"]')];
  dom.suiteSelect = byId(root, VIEW_IDS.live["suite-select"]);
  dom.replayPanel = byId(root, "replay-panel");
  dom.runSelect = byId(root, "live-run-select");
  dom.livePanel = byId(root, "live-panel");
  dom.speedInput = byId(root, "speed-input");
  dom.speedOutput = byId(root, "speed-output");
  dom.playButton = byId(root, "play-button");
  dom.restartButton = byId(root, "restart-button");
  dom.skipButton = byId(root, "skip-button");
  dom.questionInput = byId(root, "question-input");
  dom.capInput = byId(root, VIEW_IDS.live["cap-input"]);
  dom.modelList = byId(root, VIEW_IDS.live["model-list"]);
  dom.suiteNote = byId(root, "suite-note");
  dom.startButton = byId(root, VIEW_IDS.live["start-button"]);
  dom.stopButton = byId(root, VIEW_IDS.live["stop-button"]);
  dom.planNote = byId(root, "plan-note");
  dom.runStatus = byId(root, "run-status");
  dom.lanes = byId(root, "lanes");
  dom.levelsHost = byId(root, "chart-levels");
  dom.fingerprintsHost = byId(root, "chart-fingerprints");
  dom.twinsHost = byId(root, "chart-twins");
  dom.confessionsHost = byId(root, "chart-confessions");
  dom.levelsTable = byId(root, "table-levels");
  dom.fingerprintsTable = byId(root, "table-fingerprints");
  dom.twinsTable = byId(root, "table-twins");
  dom.confessionsTable = byId(root, "table-confessions");
  dom.ticker = byId(root, "ticker");
  dom.finale = byId(root, "finale");
  dom.kpiModels = byId(root, "live-kpi-models");
  dom.kpiCalls = byId(root, "live-kpi-calls");
  dom.kpiCap = byId(root, "live-kpi-cap");
  dom.kpiFlips = byId(root, "live-kpi-flips");
}

/** Connect the controls to their actions. */
function wireControls() {
  for (const input of dom.modeInputs) {
    input.addEventListener("change", () => {
      if (input.checked) onModeChange(input.value);
    });
  }
  dom.suiteSelect.addEventListener("change", onSuiteChoice);
  dom.speedInput.addEventListener("input", () => {
    dom.speedOutput.textContent = `${dom.speedInput.value}x`;
  });
  dom.questionInput.addEventListener("change", refreshPlanNote);
  dom.capInput.addEventListener("change", () => {
    live.capTouched = true;
    refreshPlanNote();
  });
  dom.runSelect.addEventListener("focus", fillRunChoices);
  dom.runSelect.addEventListener("change", () => chooseReplayRun(dom.runSelect.value));
  dom.playButton.addEventListener("click", togglePlay);
  dom.restartButton.addEventListener("click", restartReplay);
  if (dom.skipButton) dom.skipButton.addEventListener("click", skipReplay);
  dom.startButton.addEventListener("click", startLive);
  dom.stopButton.addEventListener("click", stopLive);
  window.addEventListener("pagehide", teardown);
}

/** Stop timers and any live run, and destroy the charts when the page unloads. */
function teardown() {
  stopTimer();
  if (live.runner) live.runner.stop();
  if (panels) {
    for (const panel of Object.values(panels)) destroyChart(panel);
  }
}

/** Create the charts, the replay steps and the choices, then show the mode the visitor has picked. */
function buildPage() {
  createCharts();
  replay.items = buildReplayItems(data.records, data.savedView.suite.questions);
  replay.totals = replayTotals(data.records, replay.items);
  dom.questionInput.value = String(DEFAULT_QUESTION_COUNT);
  dom.modelList.textContent = data.models.map(shortName).join(", ");
  fillSuiteChoices();
  setChoiceInput(liveView);
  wireControls();
  watchThemeChanges(redrawShownCharts);
  onModeChange(currentMode());
  renderKpis();
}

/**
 * Mount the Live view on its section. The router calls this once, the first time the view is shown, and the
 * page keeps its state after that. Load the data, then draw the page. A load failure is shown in the status line.
 * Nothing stops when the view is hidden: a replay or a live run keeps going, and the page shows it on return.
 */
export async function mountLive(root) {
  bindDom(root);
  try {
    data = await loadData();
  } catch (error) {
    setStatus(`${error.message} The theatre needs the data files to run.`);
    return;
  }
  liveView = data.savedView;
  buildPage();
  storage = await openPageStorage();
  await fillRunChoices();
  await showLatestLiveRun();
}
