// Page II, The Batch. Tick the models, questions and probe families, see the exact call plan, then run
// the batch in this browser with the key the user types. Each finished unit is saved in this browser, so a
// reload can resume an unfinished run without repeating the calls that are already saved.

import { loadJson } from "./data-cache.js";
import { askForToken } from "./token-dialog.js";
import { showToast } from "./toast.js";
import { vault } from "./engine/token.js";
import { VIEW_IDS } from "./view-ids.js";
import { createBudget, createChatClient, MAX_ATTEMPTS_PER_STEP } from "./engine/api.js";
import { csvCell } from "./engine/csv.js";
import { hostOfCustomUrl, modelNameProblem, validateCustomModel } from "./engine/custom-model.js";
import { createBatchRunner } from "./engine/runner.js";
import { buildCacheIndex, cacheKey, planAllModels } from "./engine/planner.js";
import { gradeCondition, gradeProbes } from "./engine/grade.js";
import { barErrorChart } from "./charts/index.js";
import {
  barTable, clearPanel, destroyChart, drawPanel, makeChartPanel, seriesStyle, watchThemeChanges,
} from "./chart-panel.js";
import { clear, el, formatNumber } from "./ui.js";
import { modelRowText, sortByRank } from "./model-details.js";
import { updateSelectionCount } from "./selection-count.js";
import { createRun, saveResult, setStatus as setRunStatus, resumeRun, pendingUnits } from "./store/run-store.js";
import { createPresetStore } from "./presets.js";
import {
  createSuiteLoader, suiteSummary, isSavedSuite, pushbackSetNames, questionSetNames, isPushbackSet,
  isQuestionSet, DEFAULT_PUSHBACK_SET, DEFAULT_QUESTION_SET,
} from "./suites.js";
import {
  createSerialQueue, KIND_BATCH, plannedBatchUnits, unitKeyFor, unitPayload, resumeState, addRecordsToCache,
} from "./saved-runs.js";
import {
  openPageStorage, storageText, buildPresetPanel, buildRunsList, buildResumeNotices, downloadText,
} from "./persistence-ui.js";

const DATA_PATHS = {
  config: "/data/config.json",
  records: "/data/sample_run.json",
};

// The saved replies were recorded with no system prompt, so they belong to the condition "none".
const SAVED_CONDITION = "none";
const CONDITION_LABELS = {
  none: "None",
  mitigation: "Mitigation",
  third_person: "Third person",
  control: "Control",
};
const FINGERPRINT_FAMILY = "fingerprint";
const FLIP_MEASURE = "flip_rate";
// Upper limits for the Repeats and Concurrency inputs; readChoices treats anything outside 1..max as invalid.
const MAX_REPEATS = 4;
const MAX_CONCURRENCY = 8;
// The most API attempts one batch may be given. It is the same limit as the live page's cap.
const MAX_BATCH_CALLS = 400;
// The default call cap is the planned attempt bound rounded up to a multiple of this.
const CAP_STEP = 10;
const MAX_LOG_ENTRIES = 200;
const RESULTS_INTERVAL_MS = 500;
const QUESTION_TEXT_LENGTH = 60;
const LABEL_LIMIT = 80;
// Quick grading for redraws while a run is going, so each redraw stays fast. The config value is used after.
const FAST_RESAMPLES = 200;
// Prices are typed per million tokens, so the cost estimate divides by this.
const PRICE_SCALE = 1000000;
// The progress bar uses one width class per step: progress-0, progress-5 ... progress-100 (see the CSS).
const PROGRESS_STEP = 5;
const PROGRESS_BASE_CLASS = "progress-fill";

const PLAN_EMPTY_TEXT = "Tick at least one model, one question and one probe family to see the plan.";
const LOADING_TEXT = "The data files are still loading, so the batch cannot start yet.";
const NO_DATA_TEXT = "No data loaded";
const NO_CHOICE_TEXT = "Tick at least one model and one question to see results.";
const NO_REPLIES_TEXT = "No replies yet for the ticked choices. Start a batch to make them.";
const NO_CHART_TEXT = "No fingerprint replies yet for the ticked models.";
const NO_MODEL_RESULT_TEXT = "No replies yet for this model under the chosen condition.";
const NOT_SAVED_TEXT = "This run is not saved in this window, so a reload would start it again.";
const SAVE_PROBLEM_TEXT = "Some results could not be saved, so a reload would repeat those calls.";
const RESUME_BLOCKED_TEXT = "Wait for the batch to finish or stop before you resume another run.";
const RUN_DONE_TEXT = "Every unit of this run is already saved, so the run is marked done.";
const PRESET_HINT = "Presets hold the sets, the models, the families, the limits and the system prompt.";

// The gauntlet measures in each model's table: label, field name in the grade row, decimal digits.
// The flip column names the last level, so it follows the pushback set.
/** Return the gauntlet measures for a pushback set with this many levels. */
function gauntletMeasures(levelCount) {
  return [
    ["Units (questions right at the start)", "units", 0],
    ["Baseline accuracy", "baseline_accuracy", 3],
    [`Flip at level ${levelCount}`, `flip_rate_level_${levelCount}`, 3],
    ["Mean Breaking Point", "mean_spine_score", 3],
    ["Final correct share", "final_correct_share", 3],
    ["Capitulated share", "capitulated_share", 3],
    ["Converted share", "converted_share", 3],
    ["Acceptance mean", "acceptance_mean", 3],
  ];
}

// Names used in this file, mapped to the ids in the batch section of index.html. These are only strings: the
// elements are looked up inside the section when mountBatch runs, never at import.
const IDS = {
  setupForm: "setup-form",
  kpiModels: "batch-kpi-models",
  kpiQuestions: "batch-kpi-questions",
  kpiFamilies: "batch-kpi-families",
  kpiSteps: "batch-kpi-steps",
  pushbackSelect: VIEW_IDS.batch["pushback-select"],
  questionSetSelect: VIEW_IDS.batch["question-set-select"],
  suiteSummary: VIEW_IDS.batch["suite-summary"],
  presetHost: VIEW_IDS.batch["preset-panel"],
  resumeNotices: VIEW_IDS.batch["resume-notices"],
  runsList: VIEW_IDS.batch["runs-list"],
  storageNote: VIEW_IDS.batch["storage-note"],
  fixedSettings: "fixed-settings",
  modelList: VIEW_IDS.batch["model-list"],
  modelCount: VIEW_IDS.batch["model-count"],
  modelSelectAll: "model-select-all",
  modelClear: "model-clear",
  customName: "custom-model-name",
  customAdd: "custom-model-add",
  customMessage: "custom-model-message",
  questionList: "question-list",
  questionCount: VIEW_IDS.batch["question-count"],
  tierFilter: "tier-filter",
  questionAll: "question-all",
  questionNone: "question-none",
  questionCorrection: "question-correction",
  questionWrapper: "question-wrapper",
  familyList: "family-list",
  familyCount: VIEW_IDS.batch["family-count"],
  condition: VIEW_IDS.batch["condition-select"],
  repeats: "repeats-input",
  concurrency: "concurrency-input",
  cap: VIEW_IDS.batch["cap-input"],
  price: "price-input",
  tokens: "tokens-input",
  planModels: "plan-models",
  planTotals: "plan-totals",
  planCost: "plan-cost",
  planProblem: "plan-problem",
  confirmPanel: "confirm-panel",
  confirmText: "confirm-text",
  confirmContinue: "confirm-continue",
  confirmCancel: "confirm-cancel",
  start: VIEW_IDS.batch["start-button"],
  pause: "pause-button",
  stop: VIEW_IDS.batch["stop-button"],
  progressFill: "progress-fill",
  progressTrack: "progress-track",
  progressLine: "progress-line",
  statusLine: VIEW_IDS.batch["status-line"],
  logList: "log-list",
  resultsMessage: "results-message",
  gauntletTables: "gauntlet-tables",
  chartMessage: "chart-message",
  chartHost: "fingerprint-chart",
  chartTable: "fingerprint-table",
  probeBody: "probe-table-body",
  exportGauntlet: "export-gauntlet",
  exportProbes: "export-probes",
  exportReplies: "export-replies",
};

// Everything the page needs at any moment. Controls are read from the page; this object holds the rest.
const page = {
  dom: null,                  // the elements named in IDS
  data: null,                 // config and the saved records, once loaded
  loadError: "",              // the message when a data file could not be loaded
  suite: null,                // the pushback set and question set on the form, with their questions and ladder
  loader: null,               // the suite loader, which keeps each suite once it is read
  caches: new Map(),          // the reply cache of each suite, by suite name (the runner reads and writes it)
  cache: new Map(),           // the reply cache of the suite on the form
  questionsById: new Map(),   // question objects by id, for the suite on the form
  allModels: [],              // config models, then names the user added; kept only in memory
  customModels: [],           // custom models from config.json that passed the checks in custom-model.js
  newRecords: [],             // replies made in this page session, for the JSON export
  phase: "idle",              // "idle", "running", "stopping", "stopped" or "finished"
  runner: null,               // the batch runner while a batch exists
  runCondition: SAVED_CONDITION,
  counts: { done: 0, total: 0, calls: 0, reused: 0, failed: 0 },
  budgetHit: false,           // true once the call cap has stopped a run
  keyRefused: false,          // true once the service refused the key during a run
  capTouched: false,          // true once the user types a cap, so the plan stops changing it
  confirming: false,          // true while the key dialog or the confirmation line is open
  exportRows: { gauntlet: [], probes: [] },
  chartPanel: null,           // the fingerprint chart with its table view, made at start-up
  chartKey: "",               // the models and probes the chart was drawn for
  shown: null,                // the models and probe rows of the last grading, redrawn on a theme change
  resultsTimer: null,         // the pending results redraw, or null
  lastResultsAt: 0,           // when the results were last drawn, in milliseconds
  storage: null,              // { adapter, fallback } from the run storage
  presets: null,              // the preset store
  panels: {},                 // the preset panel, the notices and the Saved runs list
  queue: createSerialQueue(), // run writes, one at a time
  runId: null,                // the saved run of the batch on screen, or null
  resumeRunId: null,          // the saved run the next Start continues, or null
  unitSteps: new Map(),       // the step records of each unit still running, by unit key
};

/**
 * Set the batch page up inside its section: find the controls, wire them, then load the data files. The router
 * calls this once, the first time the view is shown, so the page keeps its state when the visitor leaves it.
 */
export function mountBatch(root) {
  page.dom = findElements(root);
  page.chartPanel = makeChartPanel(
    page.dom.chartHost,
    page.dom.chartTable,
    barErrorChart,
    (options) => barTable("Fingerprint flip rates by probe and model", options),
  );
  wireControls();
  watchThemeChanges(redrawShownChart);
  loadData();
}

/**
 * Look up every element this page uses, by the names in IDS. The lookup is scoped to root, so it never reads
 * the controls of another view.
 */
function findElements(root) {
  return Object.fromEntries(Object.entries(IDS).map(([name, id]) => [name, root.querySelector(`#${id}`)]));
}

/** Attach the event listeners. Form edits go through one handler; buttons call their own functions. */
function wireControls() {
  const dom = page.dom;
  dom.setupForm.addEventListener("submit", (event) => event.preventDefault());
  dom.setupForm.addEventListener("change", onFormEdited);
  dom.setupForm.addEventListener("input", onFormEdited);
  dom.pushbackSelect.addEventListener("change", onSuiteChanged);
  dom.questionSetSelect.addEventListener("change", onSuiteChanged);
  dom.modelSelectAll.addEventListener("click", () => setChecks(dom.modelList, () => true));
  dom.modelClear.addEventListener("click", () => setChecks(dom.modelList, () => false));
  dom.questionAll.addEventListener("click", () => setChecks(dom.questionList, () => true));
  dom.questionNone.addEventListener("click", () => setChecks(dom.questionList, () => false));
  dom.questionCorrection.addEventListener("click", () => setChecks(dom.questionList, flaggedAs("correction_test")));
  dom.questionWrapper.addEventListener("click", () => setChecks(dom.questionList, flaggedAs("wrapper_test")));
  dom.customAdd.addEventListener("click", addCustomModel);
  dom.customName.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addCustomModel();
    }
  });
  dom.start.addEventListener("click", handleStart);
  dom.pause.addEventListener("click", togglePause);
  dom.stop.addEventListener("click", stopRun);
  dom.confirmContinue.addEventListener("click", confirmStart);
  dom.confirmCancel.addEventListener("click", cancelConfirmation);
  dom.exportGauntlet.addEventListener("click", exportGauntletCsv);
  dom.exportProbes.addEventListener("click", exportProbesCsv);
  dom.exportReplies.addEventListener("click", exportRepliesJson);
}

/**
 * Load one data file through the shared cache, so each file is fetched once per document. A failure names the
 * file and says what to check, in the same words the page has always used.
 */
async function loadDataFile(path) {
  try {
    return await loadJson(path);
  } catch {
    throw new Error(`Could not load ${path}. Check that the site is being served, then reload the page.`);
  }
}

/** Load the config and the saved records, then the default suite and the controls. A failure is shown on the page. */
async function loadData() {
  setStatus("Loading the data files.");
  try {
    const [config, records] = await Promise.all([loadDataFile(DATA_PATHS.config), loadDataFile(DATA_PATHS.records)]);
    requireGradeSettings(config);
    page.data = { config, savedRecords: records.map((record) => ({ ...record, condition: SAVED_CONDITION })) };
    page.loader = createSuiteLoader(loadDataFile);
    fillSuiteSelects();
    setupControls(config);
    await selectSuite(DEFAULT_PUSHBACK_SET, DEFAULT_QUESTION_SET);
    showPageStatus("Tick what to run. Nothing runs until you press Start.");
    onSelectionChanged();
  } catch (error) {
    page.loadError = errorText(error);
    showPageStatus(page.loadError);
    updateControls();
    updateCountLines();
  }
  if (page.data !== null) {
    await startStorage();
  }
}

/** Show a status line for the page, unless a run is going: then the run's own line is kept. */
function showPageStatus(text) {
  if (!isRunning()) {
    setStatus(text);
  }
}

// bootstrap_resamples and random_seed are copied from the project's config.json by scripts/export_site_data.py.
// If either is missing, the page stops with a message instead of guessing a value.
/** Throw a message that says what to fix when config.json lacks a grading setting. Returns nothing. */
function requireGradeSettings(config) {
  for (const key of ["bootstrap_resamples", "random_seed"]) {
    if (!Number.isInteger(config[key])) {
      throw new Error(
        `config.json has no ${key}, so the results cannot be graded. Re-export the site data, then reload the page.`,
      );
    }
  }
}

/** Open the run storage, build the presets panel, the notices and the Saved runs list, then draw them. */
async function startStorage() {
  page.storage = await openPageStorage();
  page.presets = createPresetStore(page.storage.adapter);
  page.dom.storageNote.textContent = storageText(page.storage.fallback);
  page.panels.presets = buildPresetPanel({
    idPrefix: "batch",
    page: "batch",
    store: page.presets,
    readSettings: readPresetSettings,
    applySettings: applyPresetSettings,
    hint: PRESET_HINT,
  });
  page.dom.presetHost.replaceChildren(page.panels.presets.root);
  const shared = {
    adapter: page.storage.adapter,
    kind: KIND_BATCH,
    queue: page.queue,
    unitWord: "units",
    onResume: resumeBatchRun,
    onChanged: onRunDeleted,
  };
  page.panels.notices = buildResumeNotices({ ...shared, activeRunId: () => page.runId });
  page.panels.list = buildRunsList(shared);
  page.dom.resumeNotices.replaceChildren(page.panels.notices.root);
  page.dom.runsList.replaceChildren(page.panels.list.root);
  await refreshRuns();
}

/** Redraw the notices and the Saved runs list from storage. A storage problem leaves the lists as they were. */
async function refreshRuns() {
  if (page.panels.list === undefined) {
    return;
  }
  try {
    await page.panels.notices.refresh();
    await page.panels.list.refresh();
  } catch {
    showPageStatus("The saved runs could not be read. The page still works.");
  }
}

/** After a saved run is deleted, the batch on screen is no longer saved, and both lists are drawn again. */
function onRunDeleted(runId) {
  if (runId === page.runId) {
    page.runId = null;
  }
  if (runId === page.resumeRunId) {
    page.resumeRunId = null;
  }
  refreshRuns();
}

/**
 * Return the model choices, one per catalog entry. Each has an id and a kind ("text" or "vision").
 * When the catalog is missing, fall back to the default models, with no kind.
 */
function modelChoices(config) {
  if (Array.isArray(config.catalog) && config.catalog.length > 0) {
    return config.catalog;
  }
  return config.models.map((id) => ({ id, kind: "" }));
}

/** Fill the pushback set and question set menus with the names this site has. */
function fillSuiteSelects() {
  fillOptions(page.dom.pushbackSelect, pushbackSetNames().map((name) => ({ value: name, label: name })));
  fillOptions(page.dom.questionSetSelect, questionSetNames().map((name) => ({ value: name, label: name })));
}

/** Fill the model, condition and number controls from the config. Built-in models are ticked by default. */
function setupControls(config) {
  // Setup order matters: the built-in rows come first, then the custom endpoints from config, so a custom
  // name can be checked against every built-in name before it is accepted.
  const choices = modelChoices(config);
  const defaults = new Set(config.models);
  // The rows are drawn in rank order, but allModels keeps the catalog order: the chart colours depend on it.
  page.allModels = choices.map((entry) => entry.id);
  page.dom.modelList.append(buildModelHeading());
  for (const entry of sortByRank(choices)) {
    page.dom.modelList.append(buildModelRow(entry, { checked: defaults.has(entry.id), note: entry.kind }));
  }
  page.customModels = checkedCustomModels(config, page.allModels);
  for (const entry of page.customModels) {
    page.allModels.push(entry.name);
    page.dom.modelList.append(buildModelRow({ id: entry.name }, { note: "custom endpoint" }));
  }
  fillConditionSelect(config.system_prompts);
  page.dom.repeats.value = String(config.repeats);
  page.dom.concurrency.value = String(config.concurrency);
  page.dom.fixedSettings.textContent = fixedSettingsText(config);
}

/** Return the note that says where temperature and max tokens come from. Presets keep them as they are. */
function fixedSettingsText(config) {
  return `Temperature ${config.temperature} and max tokens ${config.max_tokens} come from config.json. `
    + "Presets keep those two as they are.";
}

/**
 * Return the custom models from config.json that pass validateCustomModel, in order. A name that a built-in
 * model already uses is refused, so a key never goes to a custom endpoint for a built-in model.
 */
function checkedCustomModels(config, builtInIds) {
  const entries = Array.isArray(config.custom_models) ? config.custom_models : [];
  const takenNames = [...builtInIds];
  const accepted = [];
  for (const entry of entries) {
    if (validateCustomModel(entry, takenNames).ok) {
      accepted.push(entry);
      takenNames.push(entry.name);
    }
  }
  return accepted;
}

/** Return the sentence that names each ticked custom model and the host its calls go to. Empty when none is ticked. */
function customEndpointSentence(models) {
  const lines = page.customModels
    .filter((entry) => models.includes(entry.name))
    .map((entry) => `${entry.name} sends to ${hostOfCustomUrl(entry.base_url)}`);
  return lines.length === 0 ? "" : `Custom endpoint: ${lines.join("; ")}. `;
}

/** Fill the condition menu. "none" comes first; the other keys follow in the order of the config. */
function fillConditionSelect(systemPrompts) {
  const keys = Object.keys(systemPrompts);
  const ordered = keys.includes(SAVED_CONDITION)
    ? [SAVED_CONDITION, ...keys.filter((key) => key !== SAVED_CONDITION)]
    : keys;
  page.dom.condition.append(
    ...ordered.map((key) => el("option", { value: key, text: CONDITION_LABELS[key] ?? key })),
  );
}

/** Replace the options of a select with the given value and label pairs. */
function fillOptions(select, choices) {
  select.replaceChildren(...choices.map((choice) => el("option", { value: choice.value, text: choice.label })));
}

/** Return the reply cache of a suite. The saved replies belong to the suite gauntlet_v3 with the easy questions. */
function cacheFor(suite) {
  if (!page.caches.has(suite.name)) {
    // Any other suite starts with an empty cache, so none of its steps are treated as already answered.
    const records = isSavedSuite(suite) ? page.data.savedRecords : [];
    page.caches.set(suite.name, buildCacheIndex(records));
  }
  return page.caches.get(suite.name);
}

/**
 * Put a suite on the form: its name in the menus, its questions, its tiers and its reply cache. Questions that
 * were ticked stay ticked when the new suite has them too.
 */
async function selectSuite(pushbackSet, questionSet) {
  const suite = await page.loader.load(pushbackSet, questionSet);
  page.suite = suite;
  page.dom.pushbackSelect.value = pushbackSet;
  page.dom.questionSetSelect.value = questionSet;
  page.dom.suiteSummary.textContent = suiteSummary(suite);
  page.cache = cacheFor(suite);
  page.questionsById = new Map(suite.questions.map((question) => [question.id, question]));
  rebuildQuestionList(suite);
  fillTierFilter(suite.questions);
}

/** Choose a new suite from the menus, then refresh the plan. */
async function onSuiteChanged() {
  try {
    await selectSuite(page.dom.pushbackSelect.value, page.dom.questionSetSelect.value);
    showPageStatus("Tick what to run. Nothing runs until you press Start.");
  } catch (error) {
    showPageStatus(errorText(error));
  }
  onSelectionChanged();
}

/** Redraw the question tick boxes for a suite, keeping the ticks of questions the suite still has. */
function rebuildQuestionList(suite) {
  const kept = new Set(checkedValues(page.dom.questionList));
  page.dom.questionList.replaceChildren(
    ...suite.questions.map((question) => buildQuestionRow(question, kept.has(question.id))),
  );
}

/**
 * Build one tick box with its label. The label wraps the box, so the two are always linked. Extra nodes go
 * after the label text, inside the same label, so clicking them ticks the box too.
 */
function buildCheckbox(value, {
  text, title = null, checked = false, note = "", lead = [], extra = [], className = "check",
}) {
  const input = el("input", { type: "checkbox", className: "check-input", value });
  input.checked = checked;
  const box = el("span", { className: "check-box" });
  const children = [input, box, ...lead, el("span", { className: "check-text", text })];
  if (note) {
    children.push(el("span", { className: "check-kind", text: `(${note})` }));
  }
  children.push(...extra);
  return el("label", { className, title }, children);
}

/**
 * Build one model row from its catalog entry. The rank sits in a fixed-width column beside the name, and the
 * context, reasoning and price go on a line under the name. The kind, when there is one, is shown in brackets
 * after the name. The row's title is the source of the rank, so hovering shows where the rank came from.
 */
function buildModelRow(entry, { checked = false, note = "" } = {}) {
  const row = modelRowText(entry);
  const rank = el("span", { className: "model-rank", text: row.rank });
  const name = note ? `${shortName(row.name)} (${note})` : shortName(row.name);
  return buildCheckbox(row.name, {
    text: name, title: row.basis, checked, lead: [rank], extra: [buildModelFacts(row)],
    className: "check check-model",
  });
}

/**
 * Build the line of facts under a model's name: context, reasoning and price. Each one has a fixed-width slot,
 * the same slot as in the heading, so the figures line up from one row to the next.
 */
function buildModelFacts(row) {
  return el("span", { className: "model-facts" }, [
    el("span", { className: "model-context", text: row.context }),
    el("span", { className: "model-reasoning", text: row.reasoning }),
    el("span", { className: "model-price", text: row.price }),
  ]);
}

/**
 * Build the heading above the model rows, in the same columns as the rows. The price heading gives the unit
 * (per million tokens) once, so the rows do not repeat it.
 */
function buildModelHeading() {
  const facts = el("span", { className: "model-facts" }, [
    el("span", { className: "model-context", text: "Context" }),
    el("span", { className: "model-reasoning", text: "Reasoning" }),
    el("span", { className: "model-price", text: "Price per million tokens, in / out" }),
  ]);
  return el("div", { className: "model-head" }, [
    el("span", { className: "model-head-gap" }),
    el("span", { className: "model-rank", text: "Rank" }),
    el("span", { className: "check-text", text: "Model" }),
    facts,
  ]);
}

/** Build one question row: a tick box labelled with the id, tier and first words of the question. */
function buildQuestionRow(question, checked = false) {
  const label = buildCheckbox(question.id, { text: questionLabel(question), checked });
  return el("div", { className: "check-row", "data-tier": question.tier }, [label]);
}

/** Return the question's label: "m01 · tier · first 60 characters of the question". */
function questionLabel(question) {
  const text = question.question;
  const short = text.length > QUESTION_TEXT_LENGTH ? `${text.slice(0, QUESTION_TEXT_LENGTH)}…` : text;
  return `${question.id} · ${question.tier} · ${short}`;
}

/** Fill the tier menu with each tier in the order the questions list them. The tier is reset to all tiers. */
function fillTierFilter(questions) {
  const tiers = [...new Set(questions.map((question) => question.tier))];
  page.dom.tierFilter.replaceChildren(
    el("option", { value: "all", text: "All tiers" }),
    ...tiers.map((tier) => el("option", { value: tier, text: tier })),
  );
}

/** Return the part of a model name after the last slash, for short labels. */
function shortName(model) {
  return String(model).split("/").pop();
}

/** Format a count with thousands separators, in English. */
function formatCount(number) {
  return Number(number).toLocaleString("en-GB");
}

/** Return the text of an error. A value that is not an Error is turned into text. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Set the status line text. */
function setStatus(text) {
  page.dom.statusLine.textContent = text;
}

/** Return the checked values of the tick boxes in a container, in page order. */
function checkedValues(container) {
  return Array.from(container.querySelectorAll("input[type='checkbox']:checked"), (input) => input.value);
}

/** Return the question object for a tick box, or undefined. */
function questionFor(input) {
  return page.questionsById.get(input.value);
}

/** Return a test that is true for a tick box whose question has the given flag set. */
function flaggedAs(flagName) {
  return (input) => questionFor(input)?.[flagName] === true;
}

/** Set every tick box in a container from a test, then refresh the plan. */
function setChecks(container, isChecked) {
  for (const input of container.querySelectorAll("input[type='checkbox']")) {
    input.checked = isChecked(input);
  }
  onSelectionChanged();
}

/** Read a whole number from an input. Returns null when the text is not a whole number in range. */
function readWholeNumber(input, min, max) {
  const text = input.value.trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const number = Number(text);
  return number >= min && number <= max ? number : null;
}

/** Read an optional non-negative number. Returns null when the field is empty or not a number. */
function readOptionalNumber(input) {
  const text = input.value.trim();
  if (text === "") {
    return null;
  }
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Read every control into one plain object. A number that is not valid becomes null. */
function readChoices() {
  const dom = page.dom;
  return {
    models: checkedValues(dom.modelList),
    questions: checkedValues(dom.questionList),
    families: new Set(checkedValues(dom.familyList)),
    condition: dom.condition.value,
    repeats: readWholeNumber(dom.repeats, 1, MAX_REPEATS),
    concurrency: readWholeNumber(dom.concurrency, 1, MAX_CONCURRENCY),
    cap: readWholeNumber(dom.cap, 1, MAX_BATCH_CALLS),
    price: readOptionalNumber(dom.price),
    tokens: readOptionalNumber(dom.tokens),
  };
}

/** Say in plain words what stops the batch from starting, or return null when everything is ready. */
function findProblem(choices) {
  if (page.data === null || page.suite === null) {
    return page.loadError || LOADING_TEXT;
  }
  if (choices.models.length === 0) {
    return "Tick at least one model.";
  }
  if (choices.questions.length === 0) {
    return "Tick at least one question.";
  }
  if (choices.families.size === 0) {
    return "Tick at least one probe family.";
  }
  if (choices.repeats === null) {
    return `Repeats must be a whole number from 1 to ${MAX_REPEATS}.`;
  }
  if (choices.concurrency === null) {
    return `Concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}.`;
  }
  if (choices.cap === null) {
    return `The call cap must be a whole number from 1 to ${MAX_BATCH_CALLS}.`;
  }
  return null;
}

/** Return the questions whose ids are in the list, in data order. */
function selectedQuestions(ids) {
  const wanted = new Set(ids);
  return page.suite.questions.filter((question) => wanted.has(question.id));
}

/** Count the calls for the chosen models, questions, repeats and families. Null when the choices are incomplete. */
function planFor(choices) {
  if (page.data === null || page.suite === null || choices.repeats === null) {
    return null;
  }
  if (choices.models.length === 0 || choices.questions.length === 0 || choices.families.size === 0) {
    return null;
  }
  const { ladder, probeSpec } = page.suite;
  return planAllModels(
    choices.models, selectedQuestions(choices.questions), choices.repeats, page.cache,
    choices.condition, choices.families, ladder, probeSpec, page.data.config,
  );
}

/** Return the default cap for a number of plan steps: their attempt bound rounded up, from 1 to the maximum. */
function defaultCap(steps) {
  // Worst case every step is retried up to MAX_ATTEMPTS_PER_STEP times, so this is the largest cap a run could need.
  const attempts = steps * MAX_ATTEMPTS_PER_STEP;
  return Math.min(MAX_BATCH_CALLS, Math.max(1, Math.ceil(attempts / CAP_STEP) * CAP_STEP));
}

/** Return how many units the choices make: one per model, question and repeat. */
function unitCount(choices) {
  return choices.models.length * choices.questions.length * (choices.repeats ?? 0);
}

/** Handle a change in the setup form: a tier change re-filters the questions, then the plan is refreshed. */
function onFormEdited(event) {
  const target = event.target;
  // The preset panel and the suite menus have their own handlers, and the plan does not depend on them.
  if (page.dom.presetHost.contains(target) || target === page.dom.pushbackSelect
    || target === page.dom.questionSetSelect) {
    return;
  }
  // Editing the form means the next Start is a fresh run, not the continuation of a saved one.
  if (!page.confirming) {
    page.resumeRunId = null;
  }
  if (target === page.dom.tierFilter) {
    applyTierFilter();
  }
  if (target === page.dom.cap) {
    page.capTouched = true;
  }
  onSelectionChanged();
}

/** Hide the questions outside the chosen tier. Hidden questions stay ticked or unticked as they were. */
function applyTierFilter() {
  const tier = page.dom.tierFilter.value;
  for (const row of page.dom.questionList.querySelectorAll(".check-row")) {
    row.hidden = tier !== "all" && row.dataset.tier !== tier;
  }
}

/** Refresh everything that depends on the choices: the plan, the counts, the buttons and the results. */
function onSelectionChanged() {
  if (page.dom === null) {
    return;
  }
  const choices = readChoices();
  const plan = planFor(choices);
  // Until the user types a cap, keep the cap box in step with the plan.
  if (plan !== null && !page.capTouched) {
    choices.cap = defaultCap(plan.totals.atMostNew);
    page.dom.cap.value = String(choices.cap);
  }
  renderPlan(choices, plan);
  renderKpis(choices, plan);
  updateCountLines();
  if (page.phase === "idle") {
    resetCounts(unitCount(choices));
    renderProgress();
  }
  updateControls();
  scheduleSelectionResults();
}

/** Refresh the count line of each multi-select group: models, questions and probe families. */
function updateCountLines() {
  updateGroupCount(page.dom.modelCount, page.dom.modelList, "models");
  updateGroupCount(page.dom.questionCount, page.dom.questionList, "questions");
  updateGroupCount(page.dom.familyCount, page.dom.familyList, "families");
}

/** Write a group's count line, such as "3 of 29 models selected", from its tick boxes. */
function updateGroupCount(countElement, container, noun) {
  const total = container.querySelectorAll("input[type='checkbox']").length;
  updateSelectionCount(countElement, checkedValues(container).length, total, noun);
}

/** Fill the plan panel: one line per model, the totals, the cost estimate, and any problem to fix. */
function renderPlan(choices, plan) {
  const dom = page.dom;
  clear(dom.planModels);
  if (plan === null) {
    dom.planTotals.textContent = PLAN_EMPTY_TEXT;
  } else {
    dom.planModels.append(...plan.models.map(planItem));
    dom.planTotals.textContent = totalsSentence(plan.totals, choices);
  }
  dom.planCost.textContent = plan === null ? "" : costSentence(plan.totals.atMostNew, choices);
  dom.planProblem.textContent = findProblem(choices) ?? "";
}

/** Fill the four summary cards from the choices and the plan. With no data loaded, each card says so. */
function renderKpis(choices, plan) {
  const dom = page.dom;
  const loaded = page.data !== null;
  setKpi(dom.kpiModels, loaded ? formatCount(choices.models.length) : null);
  setKpi(dom.kpiQuestions, loaded ? formatCount(choices.questions.length) : null);
  setKpi(dom.kpiFamilies, loaded ? formatCount(choices.families.size) : null);
  const steps = plan === null ? 0 : plan.totals.atMostNew;
  setKpi(dom.kpiSteps, loaded ? formatCount(steps) : null);
}

/** Set one card's value. A null text marks the card empty and shows the "No data loaded" text instead. */
function setKpi(valueElement, text) {
  const empty = text === null;
  valueElement.textContent = empty ? NO_DATA_TEXT : text;
  valueElement.closest(".kpi-card").classList.toggle("is-empty", empty);
}

/** Return one plan line for a model: its saved replies and the most new calls it can need. */
function planItem(row) {
  const saved = formatCount(row.saved);
  const newSteps = formatCount(row.atMostNew);
  const text = `${shortName(row.model)}: ${saved} saved, at most ${newSteps} new steps`;
  return el("li", { text });
}

/** Return the totals sentence. It warns when the cap is below the most attempts the new steps can need. */
function totalsSentence(totals, choices) {
  let text = `This batch has at most ${formatCount(totals.atMostNew)} new steps; `
    + `${formatCount(totals.saved)} are already saved and will be reused.`;
  const maxAttempts = totals.atMostNew * MAX_ATTEMPTS_PER_STEP;
  if (choices.cap !== null && choices.cap < maxAttempts) {
    text += " The cap is lower than the most attempts the new steps can need, so the batch may stop at the cap.";
  }
  return text;
}

/** Return the cost sentence, or an empty text when either price or token field is empty. */
function costSentence(newCalls, choices) {
  if (choices.price === null || choices.tokens === null) {
    return "";
  }
  const cost = (newCalls * choices.tokens * choices.price) / PRICE_SCALE;
  return `Estimated cost: about ${formatNumber(cost, 2)} (an estimate from your own price and token numbers).`;
}

/** Set which controls can be used. Start needs a complete choice; Pause and Stop need a running batch. */
function updateControls() {
  const dom = page.dom;
  const running = isRunning();
  dom.start.disabled = running || page.confirming || findProblem(readChoices()) !== null;
  dom.pause.disabled = page.phase !== "running";
  dom.stop.disabled = page.phase !== "running";
  dom.pause.textContent = page.runner !== null && page.runner.isPaused() ? "Resume" : "Pause";
  setSelectionLocked(running || page.confirming);
}

/** Return true while a batch is running or stopping. */
function isRunning() {
  return page.phase === "running" || page.phase === "stopping";
}

/** Disable or enable every block of the setup form, so the choices cannot change during a run. */
function setSelectionLocked(locked) {
  for (const fieldset of page.dom.setupForm.querySelectorAll("fieldset")) {
    fieldset.disabled = locked;
  }
}

/** Add the typed model name to the list, ticked, if it is new and has no spaces. */
function addCustomModel() {
  const name = page.dom.customName.value.trim();
  const problem = customModelProblem(name);
  page.dom.customMessage.textContent = problem;
  if (problem !== "") {
    return;
  }
  page.allModels.push(name);
  page.dom.modelList.append(buildModelRow({ id: name }, { checked: true }));
  page.dom.customName.value = "";
  page.dom.customMessage.textContent = `Added ${shortName(name)}. It is ticked.`;
  onSelectionChanged();
}

/** Return why a typed model name cannot be added, or an empty text when it can. */
function customModelProblem(name) {
  if (name === "") {
    return "Type a model name first.";
  }
  const refused = modelNameProblem(name);
  if (refused !== null) {
    return refused;
  }
  if (/\s/.test(name)) {
    return "Model names have no spaces. Check the name and try again.";
  }
  if (page.allModels.includes(name)) {
    return "That model is already in the list.";
  }
  return "";
}

/** Start was pressed. Ask for the key when there is none, then show the confirmation line. */
async function handleStart() {
  if (page.confirming || isRunning() || findProblem(readChoices()) !== null) {
    return;
  }
  // confirming locks the form (see updateControls) while the key dialog and confirmation line are open.
  page.confirming = true;
  updateControls();
  const ready = vault.has() || (await askForToken({ vault }));
  if (!ready) {
    page.confirming = false;
    page.resumeRunId = null;
    updateControls();
    showToast("No key was saved, so the batch has not started.", { tone: "warn" });
    return;
  }
  showConfirmation();
}

/** Show the confirmation line with the most calls the batch can make, and wait for Continue or Cancel. */
function showConfirmation() {
  const choices = readChoices();
  const plan = planFor(choices);
  const steps = plan === null ? 0 : plan.totals.atMostNew;
  const stepText = formatCount(steps);
  const attemptText = formatCount(steps * MAX_ATTEMPTS_PER_STEP);
  const capText = formatCount(choices.cap);
  page.dom.confirmText.textContent = `You are about to run at most ${stepText} steps with your key, `
    + `up to ${attemptText} API attempts including retries (at most ${MAX_ATTEMPTS_PER_STEP} for each step). `
    + `Suite: ${page.suite.name}. `
    + customEndpointSentence(choices.models)
    + `The call cap is ${capText} attempts, and this page allows at most ${MAX_BATCH_CALLS}. Continue?`;
  page.dom.confirmPanel.hidden = false;
  setStatus("Waiting for you to confirm.");
  updateControls();
  page.dom.confirmContinue.focus();
}

/** Continue was pressed: hide the confirmation and start the batch. */
function confirmStart() {
  page.confirming = false;
  page.dom.confirmPanel.hidden = true;
  beginRun().catch(handleRunError);
}

/** Cancel was pressed: hide the confirmation. Nothing has been called. */
function cancelConfirmation() {
  page.confirming = false;
  page.resumeRunId = null;
  page.dom.confirmPanel.hidden = true;
  setStatus("Not started. No call was made.");
  updateControls();
  page.dom.start.focus();
}

/** Return the config a saved batch keeps, so a resume can put the form back the same way. No key is kept. */
function batchConfig(choices) {
  const { config } = page.data;
  return {
    kind: KIND_BATCH,
    pushbackSet: page.suite.ladderName,
    questionSet: page.suite.questionSet,
    models: choices.models,
    questions: choices.questions,
    families: [...choices.families],
    repeats: choices.repeats,
    condition: choices.condition,
    concurrency: choices.concurrency,
    callCap: choices.cap,
    temperature: config.temperature,
    maxTokens: config.max_tokens,
  };
}

/** Return a short label for a saved batch, within 80 characters. */
function batchLabel(choices) {
  return `Batch ${page.suite.name}: ${choices.models.length} models, ${choices.questions.length} questions`
    .slice(0, LABEL_LIMIT);
}

/**
 * Make the saved run for this batch, or reuse the run being resumed. Returns its id, or null when the run cannot be
 * saved (storage is not open, or the browser refused the write). A null id only means no resume is possible.
 */
async function openRunFor(choices) {
  const storage = page.storage;
  if (storage === null) {
    return null;
  }
  const { adapter } = storage;
  try {
    return await page.queue.run(async () => {
      // A resume keeps its original run and id; only a fresh batch creates a new saved run.
      if (page.resumeRunId !== null) {
        const resumedId = page.resumeRunId;
        await resumeRun(adapter, resumedId);
        return resumedId;
      }
      const plannedUnits = plannedBatchUnits(choices.models, choices.questions, choices.repeats);
      const label = batchLabel(choices);
      const created = await createRun(adapter, { label, config: batchConfig(choices), plannedUnits });
      await setRunStatus(adapter, created.id, "running");
      return created.id;
    });
  } catch {
    return null;
  }
}

/** Create the client and the batch runner from the choices on screen, then start the batch. */
async function beginRun() {
  const choices = readChoices();
  const { config } = page.data;
  page.phase = "running";
  page.runCondition = choices.condition;
  page.budgetHit = false;
  page.keyRefused = false;
  // Once a run has started, the cap the user sees is kept, even if the plan changes later.
  page.capTouched = true;
  resetCounts(unitCount(choices));
  setStatus("Running. Calls are made with the concurrency and cap you chose.");
  updateControls();
  renderProgress();
  page.runId = await openRunFor(choices);
  if (page.runId === null) {
    setStatus(`Running. ${NOT_SAVED_TEXT}`);
  }
  page.resumeRunId = null;
  // The budget enforces the call cap; the runner stops the batch when it is used up (see onBudgetExhausted).
  const client = createChatClient({
    baseUrl: config.base_url,
    customModels: page.customModels,
    vault,
    budget: createBudget(choices.cap),
    timeoutMs: config.request_timeout_seconds * 1000,
  });
  page.runner = createBatchRunner({
    client,
    models: choices.models,
    questions: selectedQuestions(choices.questions),
    repeats: choices.repeats,
    condition: choices.condition,
    families: choices.families,
    ladder: page.suite.ladder,
    probeSpec: page.suite.probeSpec,
    config,
    cache: page.cache,
    concurrency: choices.concurrency,
    onEvent: handleEvent,
  });
  updateControls();
  page.runner.start().catch(handleRunError);
}

/** Resume a saved batch from the notices or the list. The form is set back from the run, its saved units are reused. */
async function resumeBatchRun(run) {
  if (page.data === null || page.suite === null || run === null) {
    return;
  }
  if (isRunning() || page.confirming) {
    setStatus(RESUME_BLOCKED_TEXT);
    return;
  }
  const config = run.config;
  if (!isPushbackSet(config.pushbackSet) || !isQuestionSet(config.questionSet)) {
    setStatus("This saved batch uses a set that this site does not have, so it cannot be resumed.");
    return;
  }
  await selectSuite(config.pushbackSet, config.questionSet);
  const problem = restorePlanProblem(config);
  if (problem !== "") {
    setStatus(problem);
    return;
  }
  const remaining = pendingUnits(run).length;
  if (remaining === 0) {
    await page.queue.run(() => setRunStatus(page.storage.adapter, run.id, "done"));
    setStatus(RUN_DONE_TEXT);
    await refreshRuns();
    return;
  }
  // Putting the saved records back in the cache is what stops the runner repeating those calls.
  restoreChoices(config);
  addRecordsToCache(page.cache, resumeState(run).records);
  page.resumeRunId = run.id;
  onSelectionChanged();
  setStatus(`Resuming. ${formatCount(remaining)} units are left, and the saved ones are reused, not sent again.`);
  await handleStart();
}

/** Return why a saved batch's models or questions are not on this site, or "" when all of them are. */
function restorePlanProblem(config) {
  const missingModel = config.models.find((model) => !page.allModels.includes(model));
  if (missingModel !== undefined) {
    return `The model ${missingModel} is not in the list, so this batch cannot be resumed.`;
  }
  const missingQuestion = config.questions.find((id) => !page.questionsById.has(id));
  if (missingQuestion !== undefined) {
    return `The question ${missingQuestion} is not in ${page.suite.name}, so this batch cannot be resumed.`;
  }
  return "";
}

/** Set the form's models, questions, families, numbers and condition from a saved batch's config. */
function restoreChoices(config) {
  const dom = page.dom;
  tickOnly(dom.modelList, config.models);
  tickOnly(dom.questionList, config.questions);
  tickOnly(dom.familyList, config.families);
  dom.repeats.value = String(config.repeats);
  dom.concurrency.value = String(config.concurrency);
  dom.cap.value = String(config.callCap);
  page.capTouched = true;
  dom.condition.value = config.condition;
  applyTierFilter();
}

/** Tick exactly the boxes whose values are in the list, and untick the rest. Does not refresh the plan. */
function tickOnly(container, values) {
  const wanted = new Set(values);
  for (const input of container.querySelectorAll("input[type='checkbox']")) {
    input.checked = wanted.has(input.value);
  }
}

// A unit is one model, question and repeat. Its steps are buffered in page.unitSteps as they finish, and the
// whole unit is saved on "unit-done"; a failed unit is dropped, so a resume repeats it.
/** Route one event from the runner to the page. Events arrive in order. */
function handleEvent(event) {
  switch (event.kind) {
    case "step-done":
      bufferStep(event);
      onStepDone(event);
      break;
    case "step-failed":
      onStepFailed(event);
      break;
    case "unit-failed":
      onUnitFailed(event);
      break;
    case "unit-done":
      saveFinishedUnit(event);
      break;
    case "progress":
      onProgress(event);
      break;
    case "budget-exhausted":
      onBudgetExhausted();
      break;
    case "key-refused":
      onKeyRefused(event);
      break;
    case "stopped":
      onStopped();
      break;
    case "finished":
      onFinished(event);
      break;
    default:
      break;
  }
}

/** Return the one-line description of a unit for the log: model, question and repeat. */
function describeUnit(event) {
  return `${shortName(event.model)} · ${event.questionId} · repeat ${event.repeat}`;
}

/** Return the one-line description of a step for the log: the unit and the step. Never a reply. */
function describeStep(event) {
  return `${describeUnit(event)} · ${event.step}`;
}

/** Return the saved-run key of the unit an event belongs to. */
function eventUnitKey(event) {
  return unitKeyFor(event.model, event.questionId, event.repeat);
}

/** Keep the step record of a finished step (new or reused) until its unit is done, so the unit can be saved whole. */
function bufferStep(event) {
  // The runner writes each finished step into page.cache, so the record is looked up there by its key.
  const record = page.cache.get(cacheKey(page.runCondition, event.model, event.questionId, event.repeat, event.step));
  if (record === undefined) {
    return;
  }
  const key = eventUnitKey(event);
  const steps = page.unitSteps.get(key) ?? [];
  steps.push(record);
  page.unitSteps.set(key, steps);
}

/** Save a finished unit with all its step records. Saves go through the queue, so they never overwrite each other. */
function saveFinishedUnit(event) {
  const key = eventUnitKey(event);
  const records = page.unitSteps.get(key) ?? [];
  page.unitSteps.delete(key);
  const runId = page.runId;
  if (runId === null) {
    return;
  }
  const { adapter } = page.storage;
  page.queue.run(() => saveResult(adapter, runId, key, unitPayload(records))).catch(() => {
    addLogEntry("Note", SAVE_PROBLEM_TEXT);
  });
}

/** Handle a finished step. A new call is kept for the export; a reused one is only counted. */
function onStepDone(event) {
  if (event.reused) {
    page.counts.reused += 1;
    addLogEntry("Reused", describeStep(event));
    return;
  }
  page.counts.calls += 1;
  const key = cacheKey(page.runCondition, event.model, event.questionId, event.repeat, event.step);
  const record = page.cache.get(key);
  if (record !== undefined) {
    page.newRecords.push({ ...record, suite: page.suite.name });
  }
  addLogEntry("Called", describeStep(event));
}

/** Handle a failed step: count it and log the plain message. */
function onStepFailed(event) {
  page.counts.failed += 1;
  addLogEntry("Failed", `${describeStep(event)}: ${event.message}`);
}

/** Handle a unit that failed: count it, log it, and say that the other units carry on. Its steps are not saved. */
function onUnitFailed(event) {
  page.unitSteps.delete(eventUnitKey(event));
  page.counts.failed += 1;
  addLogEntry("Failed", `${describeUnit(event)}: ${event.message}`);
  setStatus(`A unit failed: ${event.message} The other units carry on.`);
}

/** Handle the progress after a unit: copy the counts, redraw the bar, and schedule a results redraw. */
function onProgress(event) {
  Object.assign(page.counts, {
    done: event.done,
    total: event.total,
    calls: event.calls,
    reused: event.reused,
    failed: event.failed,
  });
  renderProgress();
  scheduleResults();
}

/** Handle the call cap being reached: say how far the batch got and how to continue. */
function onBudgetExhausted() {
  page.budgetHit = true;
  addLogEntry("Note", "The call cap was reached.");
  setStatus(
    `The call cap was reached after ${formatCount(page.counts.calls)} calls. `
    + "Raise the cap and press Start again to continue: saved replies are reused.",
  );
}

/** Handle a refused key: show the message and say to check the key. The stopped event follows. */
function onKeyRefused(event) {
  page.keyRefused = true;
  addLogEntry("Note", "The key was refused.");
  setStatus(`The key was refused: ${event.message} Check the key, then press Start again.`);
}

/** Handle a stop. The cap or key message stays if one of them was the reason. */
function onStopped() {
  page.phase = "stopped";
  finishSavedRun("stopped");
  if (!page.budgetHit && !page.keyRefused) {
    setStatus(`Stopped at ${formatCount(page.counts.calls)} calls. Export what you have.`);
  }
  finishRun();
}

/** Handle the end of a batch that ran every unit. A batch with failed units is marked failed, so it can be resumed. */
function onFinished(event) {
  Object.assign(page.counts, { calls: event.calls, reused: event.reused, failed: event.failed });
  page.phase = "finished";
  finishSavedRun(event.failed > 0 ? "failed" : "done");
  setStatus(
    `Finished: ${formatCount(event.calls)} calls, ${formatCount(event.reused)} reused, `
    + `${formatCount(event.failed)} failed.`,
  );
  finishRun();
}

/** Show a batch that stopped with an unexpected error, then give the controls back. */
function handleRunError(error) {
  page.phase = "stopped";
  finishSavedRun("failed");
  setStatus(`The batch stopped because of a problem: ${errorText(error)}`);
  finishRun();
}

/**
 * Write the final status of the saved run, after its last unit is saved, then refresh the lists. The status
 * is queued behind the saves, so the run is never marked done before its last unit is in storage.
 */
function finishSavedRun(status) {
  // Clear page.runId first so no later event is saved into a run that has ended.
  const runId = page.runId;
  page.runId = null;
  if (runId === null) {
    return;
  }
  const { adapter } = page.storage;
  page.queue.run(() => setRunStatus(adapter, runId, status))
    .then(() => refreshRuns())
    .catch(() => addLogEntry("Note", SAVE_PROBLEM_TEXT));
}

/** The shared end of a batch: show the final counts, draw the results now, and give the controls back. */
function finishRun() {
  page.runner = null;
  renderProgress();
  flushResults();
  updateControls();
}

/** Pause was pressed: toggle the running batch between paused and running, and say which in the status line. */
function togglePause() {
  if (page.phase !== "running" || page.runner === null) {
    return;
  }
  if (page.runner.isPaused()) {
    page.runner.resume();
    setStatus("Running again.");
  } else {
    page.runner.pause();
    setStatus("Paused. Calls already in flight will finish. Press Resume to carry on.");
  }
  updateControls();
}

/** Stop was pressed: ask the runner to stop, and show that it is stopping. */
function stopRun() {
  if (page.phase !== "running" || page.runner === null) {
    return;
  }
  page.phase = "stopping";
  setStatus("Stopping…");
  page.runner.stop();
  updateControls();
}

/** Start the counters for a new batch with the number of units it will run. */
function resetCounts(total) {
  page.counts = { done: 0, total, calls: 0, reused: 0, failed: 0 };
}

/** Return the bar's class names for a percentage, rounded to the nearest step, such as "progress-fill progress-45". */
function progressFillClass(percent) {
  const step = Math.round(percent / PROGRESS_STEP) * PROGRESS_STEP;
  return `${PROGRESS_BASE_CLASS} progress-${step}`;
}

/** Draw the progress bar, its aria value and the counts line. The width comes from a CSS class, not a style. */
function renderProgress() {
  const { done, total, calls, reused, failed } = page.counts;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  page.dom.progressFill.className = progressFillClass(percent);
  page.dom.progressTrack.setAttribute("aria-valuenow", String(percent));
  page.dom.progressLine.textContent =
    `${done} of ${total} units done · ${calls} calls made · ${reused} reused · ${failed} failed`;
}

/** Add one line to the top of the log and drop the oldest lines past the limit. */
function addLogEntry(kind, text) {
  const item = el("li", { className: kind === "Failed" ? "log-item log-item-failed" : "log-item" }, [
    el("span", { className: "log-kind", text: kind }),
    el("span", { className: "log-text", text }),
  ]);
  const list = page.dom.logList;
  list.prepend(item);
  while (list.children.length > MAX_LOG_ENTRIES) {
    list.lastElementChild.remove();
  }
}

/** Ask for a results redraw. Redraws are at least RESULTS_INTERVAL_MS apart; the last request always runs. */
function scheduleResults() {
  if (page.resultsTimer !== null) {
    return;
  }
  // Throttle: wait out whatever is left of the interval since the last draw.
  const wait = Math.max(0, RESULTS_INTERVAL_MS - (Date.now() - page.lastResultsAt));
  page.resultsTimer = window.setTimeout(flushResults, wait);
}

/** Ask for a regrade after a selection change. Each change restarts the wait, so regrades are spaced out. */
function scheduleSelectionResults() {
  if (page.resultsTimer !== null) {
    window.clearTimeout(page.resultsTimer);
  }
  page.resultsTimer = window.setTimeout(flushResults, RESULTS_INTERVAL_MS);
}

/** Draw the results now and cancel any redraw that was waiting. */
function flushResults() {
  if (page.resultsTimer !== null) {
    window.clearTimeout(page.resultsTimer);
    page.resultsTimer = null;
  }
  page.lastResultsAt = Date.now();
  drawResults();
}

/** Return the saved and new replies for the ticked models and questions. */
function recordsFor(choices) {
  const models = new Set(choices.models);
  const questionIds = new Set(choices.questions);
  return [...page.cache.values()].filter(
    (record) => models.has(record.model) && questionIds.has(record.question_id),
  );
}

/** Return the grading settings for a redraw: fast while a batch runs, the configured resamples once it ends. */
function gradeNow() {
  const resamples = isRunning() ? FAST_RESAMPLES : page.data.config.bootstrap_resamples;
  return { ...page.data.config, bootstrap_resamples: resamples };
}

/** Grade the gauntlet rows for the ticked choices with the settings for this redraw. */
function gauntletRowsFor(choices, records) {
  return gradeCondition(records, page.suite.questions, gradeNow(), choices.condition, page.suite);
}

/** Grade the probe rows for the ticked choices with the settings for this redraw. */
function probeRowsFor(choices, records) {
  return gradeProbes(records, page.suite.questions, gradeNow(), choices.condition, page.suite.probeSpec);
}

/** Grade the replies for the ticked choices, then draw the tables, the chart and the probe table. */
function drawResults() {
  if (page.data === null || page.suite === null) {
    return;
  }
  const choices = readChoices();
  const records = recordsFor(choices);
  const gauntletRows = gauntletRowsFor(choices, records);
  const probeRows = probeRowsFor(choices, records);
  page.exportRows = { gauntlet: gauntletRows, probes: probeRows };
  page.shown = { models: choices.models, probeRows };
  renderGauntletTables(choices.models, gauntletRows);
  drawProbeChart(choices.models, probeRows);
  renderProbeTable(choices.models, probeRows);
  setResultsMessage(choices, records);
  updateExportButtons();
}

/** Redraw the chart from the last grading when the theme changes, so the colours update without a regrade. */
function redrawShownChart() {
  if (page.shown !== null) {
    drawProbeChart(page.shown.models, page.shown.probeRows);
  }
}

/** Say why there are no results yet, or clear the message when there are some. */
function setResultsMessage(choices, records) {
  let text = "";
  if (choices.models.length === 0 || choices.questions.length === 0) {
    text = NO_CHOICE_TEXT;
  } else if (records.length === 0) {
    text = NO_REPLIES_TEXT;
  }
  page.dom.resultsMessage.textContent = text;
}

/** Draw one table per ticked model with the gauntlet measures. */
function renderGauntletTables(models, rows) {
  const measures = gauntletMeasures(page.suite.levelCount);
  page.dom.gauntletTables.replaceChildren(
    ...models.map((model) => buildModelTable(model, rows.find((row) => row.model === model), measures)),
  );
}

/** Build the table for one model. A model with no replies gets a short note instead. */
function buildModelTable(model, row, measures) {
  const heading = el("h3", { className: "model-name", text: shortName(model) });
  if (row === undefined) {
    const note = el("p", { className: "field-hint", text: NO_MODEL_RESULT_TEXT });
    return el("section", { className: "model-table" }, [heading, note]);
  }
  const measureRows = measures.map(([label, key, digits]) => {
    return el("tr", {}, [el("th", { scope: "row", text: label }), numberCell(formatNumber(row[key], digits))]);
  });
  const table = el("table", { className: "data-table" }, [
    el("caption", { className: "visually-hidden", text: `Gauntlet measures for ${model}` }),
    el("tbody", {}, measureRows),
  ]);
  return el("section", { className: "model-table" }, [heading, table]);
}

/** Build a table cell that holds a number, aligned to the right. */
function numberCell(text) {
  return el("td", { className: "num", text });
}

/** Return the probe rows that are fingerprint flip rates. */
function fingerprintRows(probeRows) {
  return probeRows.filter((row) => row.family === FINGERPRINT_FAMILY && row.measure === FLIP_MEASURE);
}

/** Return the probe name written with spaces, for labels. */
function probeLabel(probe) {
  return String(probe).replace(/_/g, " ");
}

/** Return the chart style for a model, by its place in the full model list (colour, dashed, faded). */
function styleFor(model) {
  return seriesStyle(page.allModels.indexOf(model));
}

/** Return the number for one field of a probe row, or NaN when the row or the number is missing (no data). */
function numberOrNaN(row, field) {
  if (row === undefined || !Number.isFinite(row[field])) {
    return Number.NaN;
  }
  return row[field];
}

/** Find the probe row for one model and one probe, or undefined. */
function findProbeRow(rows, model, probe) {
  return rows.find((row) => row.model === model && row.probe === probe);
}

/** Build the chart options: one group per probe, one series per model, each with its interval. */
function buildChartOptions(rows, probes, models) {
  const series = models.map((model) => {
    const rowFor = (probe) => findProbeRow(rows, model, probe);
    return {
      name: shortName(model),
      ...styleFor(model),
      valuesByGroup: probes.map((probe) => numberOrNaN(rowFor(probe), "estimate")),
      lowsByGroup: probes.map((probe) => numberOrNaN(rowFor(probe), "low")),
      highsByGroup: probes.map((probe) => numberOrNaN(rowFor(probe), "high")),
    };
  });
  return {
    ariaLabel: "Fingerprint flip rate by probe, one bar per model",
    yAxisTitle: "Flip rate",
    yMax: 1,
    groups: probes.map(probeLabel),
    series,
  };
}

/** Draw the fingerprint flip-rate chart and its table. A new set of models or probes starts a new chart. */
function drawProbeChart(models, probeRows) {
  const dom = page.dom;
  const rows = fingerprintRows(probeRows);
  if (rows.length === 0 || models.length === 0) {
    clearPanel(page.chartPanel);
    dom.chartMessage.textContent = NO_CHART_TEXT;
    return;
  }
  dom.chartMessage.textContent = "";
  const probes = [...new Set(rows.map((row) => row.probe))];
  const options = buildChartOptions(rows, probes, models);
  // The key identifies the chart's shape; a changed key means the old chart cannot be updated in place.
  const key = `${models.join("|")}#${probes.join("|")}`;
  if (page.chartKey !== key) {
    destroyChart(page.chartPanel);
    page.chartKey = key;
  }
  drawPanel(page.chartPanel, options);
}

/** Fill the probe table under the chart with the fingerprint rows of the ticked models. */
function renderProbeTable(models, probeRows) {
  const shown = fingerprintRows(probeRows).filter((row) => models.includes(row.model));
  page.dom.probeBody.replaceChildren(...shown.map(probeTableRow));
}

/** Build one row of the probe table. Each number is aligned to the right. */
function probeTableRow(row) {
  return el("tr", {}, [
    el("td", { text: probeLabel(row.probe) }),
    el("td", { text: shortName(row.model) }),
    numberCell(formatNumber(row.units, 0)),
    numberCell(formatNumber(row.estimate)),
    numberCell(formatNumber(row.low)),
    numberCell(formatNumber(row.high)),
  ]);
}

/** Enable each export only when it has something to save. */
function updateExportButtons() {
  page.dom.exportGauntlet.disabled = page.exportRows.gauntlet.length === 0;
  page.dom.exportProbes.disabled = page.exportRows.probes.length === 0;
  page.dom.exportReplies.disabled = page.newRecords.length === 0;
}

/** Turn rows of plain objects into CSV text. The first line names the columns. */
function toCsv(rows) {
  if (rows.length === 0) {
    return "";
  }
  const columns = Object.keys(rows[0]);
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** Download the gauntlet rows for the ticked models as CSV, with full intervals. */
function exportGauntletCsv() {
  const choices = readChoices();
  const records = recordsFor(choices);
  // Exports grade with the full configured resamples, not the fast on-screen setting from gradeNow.
  const rows = gradeCondition(records, page.suite.questions, page.data.config, choices.condition, page.suite);
  downloadText("batch-gauntlet.csv", toCsv(rows), "text/csv");
}

/** Download the probe rows for the ticked models as CSV, with full intervals. */
function exportProbesCsv() {
  const choices = readChoices();
  const rows = gradeProbes(
    recordsFor(choices), page.suite.questions, page.data.config, choices.condition, page.suite.probeSpec,
  );
  downloadText("batch-probes.csv", toCsv(rows), "text/csv");
}

/** Download every reply made on this page as JSON. The key is never part of a reply, so it is never exported. */
function exportRepliesJson() {
  downloadText("batch-replies.json", JSON.stringify(page.newRecords), "application/json");
}

/** Return the preset view of the form: both sets, the models, families, numbers, cap and system prompt. */
function readPresetSettings() {
  const choices = readChoices();
  const { config } = page.data;
  return {
    pushbackSet: page.dom.pushbackSelect.value,
    questionSet: page.dom.questionSetSelect.value,
    models: choices.models,
    families: [...choices.families],
    repeats: choices.repeats,
    concurrency: choices.concurrency,
    callCap: choices.cap,
    condition: choices.condition,
    temperature: config.temperature,
    maxTokens: config.max_tokens,
  };
}

/** Set the form from a preset. Returns the sentences to add to the status: what was skipped, and why. */
async function applyPresetSettings(settings) {
  const dom = page.dom;
  const pushbackSet = settings.pushbackSet ?? dom.pushbackSelect.value;
  const questionSet = settings.questionSet ?? dom.questionSetSelect.value;
  await selectSuite(pushbackSet, questionSet);
  const notes = [];
  if (settings.models !== undefined) {
    const known = settings.models.filter((model) => page.allModels.includes(model));
    tickOnly(dom.modelList, known);
    notes.push(skippedModelsNote(settings.models.length - known.length));
  }
  if (settings.families !== undefined) {
    tickOnly(dom.familyList, settings.families);
  }
  if (settings.repeats !== undefined) {
    dom.repeats.value = String(settings.repeats);
  }
  if (settings.concurrency !== undefined) {
    dom.concurrency.value = String(settings.concurrency);
  }
  if (settings.callCap !== undefined) {
    dom.cap.value = String(settings.callCap);
    page.capTouched = true;
  }
  if (settings.condition !== undefined) {
    dom.condition.value = settings.condition;
  }
  notes.push(batchFixedSettingsNote(settings));
  onSelectionChanged();
  return notes.filter((note) => note !== "").join(" ");
}

/** Return the note for models in a preset that are not in the list, or "" when none were skipped. */
function skippedModelsNote(count) {
  if (count === 0) {
    return "";
  }
  return count === 1
    ? "One model in this preset is not in the list, so it was skipped."
    : `${count} models in this preset are not in the list, so they were skipped.`;
}

/** Return a note when a preset's temperature or max tokens differ from config.json. Those two are never changed. */
function batchFixedSettingsNote(settings) {
  const { config } = page.data;
  const temperature = settings.temperature ?? config.temperature;
  const maxTokens = settings.maxTokens ?? config.max_tokens;
  if (temperature === config.temperature && maxTokens === config.max_tokens) {
    return "";
  }
  return `This preset was saved with temperature ${temperature} and max tokens ${maxTokens}. `
    + `config.json sets ${config.temperature} and ${config.max_tokens}, so those two were not changed.`;
}
