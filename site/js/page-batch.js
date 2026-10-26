// Page II, The Batch. Tick the models, questions and probe families, see the exact call plan, then run
// the batch in this browser with the key the user types. Each finished unit is saved in this browser, so a
// reload can resume an unfinished run without repeating the calls that are already saved.

import { loadJson } from "./data-cache.js";
import { askForToken } from "./token-dialog.js";
import { showToast } from "./toast.js";
import { initTooltips } from "./tooltip.js";
import { browserStorage, vault } from "./engine/token.js";
import { createBatchLog } from "./engine/batch-log.js";
import { latestRunOfKind, runMatchesSuite, runDateText } from "./last-run.js";
import { VIEW_IDS } from "./view-ids.js";
import { createBudget, createChatClient, fetchModelIds, MAX_ATTEMPTS_PER_STEP } from "./engine/api.js";
import { activePlatform } from "./platform-choice.js";
import { DEFAULT_PLATFORM_ID } from "./platforms.js";
import { CHOICE_EVENT } from "./platform-section.js";
import { setRunLocked } from "./run-lock.js";
import {
  MAX_POPUP_ROWS, MODELS_PATH, PAGE_SIZE, hasSavedList, platformModelIds, readAddedModels, writeAddedModels,
  withAddedModel, withoutAddedModel, addedRows, addOutcomeText, refusalText, entryNote, keyFitsPlatform,
  ticksAfterPlatformChange, resolveNewModel, largeRunWarning, sortModelIds, letterGroups,
} from "./model-list.js";
import { buildModelAddArea } from "./model-popup.js";
import { csvCell } from "./engine/csv.js";
import { hostOfCustomUrl, validateCustomModel } from "./engine/custom-model.js";
import { createBatchRunner } from "./engine/runner.js";
import { buildCacheIndex, cacheKey, planAllModels } from "./engine/planner.js";
import { gradeCondition, gradeProbes } from "./engine/grade.js";
import { barErrorChart } from "./charts/index.js";
import { MEASURES, heatmapMatrix, normalise, rankModels } from "./analytics.js";
import { renderResultsFigures } from "./batch-figures.js";
import {
  barTable, clearPanel, destroyChart, drawPanel, makeChartPanel, seriesStyle, watchThemeChanges,
} from "./chart-panel.js";
import { clear, el, formatNumber } from "./ui.js";
import { openPicker } from "./picker-dialog.js";
import { hasNoDetails, modelRowText, sortByRank } from "./model-details.js";
import { updateSelectionCount } from "./selection-count.js";
import { createRun, saveResult, setStatus as setRunStatus, resumeRun, pendingUnits } from "./store/run-store.js";
import { createPresetStore } from "./presets.js";
import {
  createSuiteLoader, suiteSummary, isSavedSuite, pushbackSetNames, questionSetNames, isPushbackSet,
  isQuestionSet, DEFAULT_PUSHBACK_SET, DEFAULT_QUESTION_SET, choiceOfSuite, fixedChoice, setMenuChoices,
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
  suites: "/data/suites.json",
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
const MAX_CONCURRENCY = 32;
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
const PLATFORM_CHANGED_TEXT = "The platform changed before the run started, so nothing was sent. Tick the models again, then press Start.";
const NO_PLATFORM_ADD_TEXT = "No platform is chosen, so no model can be added.";

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
  runsButton: "batch-runs-button",
  runsDialog: "batch-runs-dialog",
  runsDone: "batch-runs-done",
  fixedSettings: "fixed-settings",
  modelCount: VIEW_IDS.batch["model-count"],
  modelChoose: "model-choose",
  modelSelectAll: "model-select-all",
  modelClear: "model-clear",
  modelSelected: "batch-model-selected",
  customName: "custom-model-name",
  customAdd: "custom-model-add",
  customMessage: "custom-model-message",
  questionList: "question-list",
  questionChoose: "question-choose",
  questionCount: VIEW_IDS.batch["question-count"],
  tierFilter: "tier-filter",
  questionAll: "question-all",
  questionNone: "question-none",
  questionCorrection: "question-correction",
  questionWrapper: "question-wrapper",
  questionSelected: "batch-question-selected",
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
  exportBatchLog: "export-batch-log",
};

// Everything the page needs at any moment. Controls are read from the page; this object holds the rest.
const page = {
  dom: null,                  // the elements named in IDS
  data: null,                 // config and the saved records, once loaded
  loadError: "",              // the message when a data file could not be loaded
  suite: null,                // the pushback set and question set on the form, with their questions and ladder
  loader: null,               // the suite loader, which keeps each suite once it is read
  suiteRequest: 0,            // counts the suite choices made, so a load that a newer choice overtook is not shown
  caches: new Map(),          // the reply cache of each suite, by suite name (the runner reads and writes it)
  cache: new Map(),           // the reply cache of the suite on the form
  questionsById: new Map(),   // question objects by id, for the suite on the form
  allModels: [],              // the ids of the models on the chosen platform, catalog order first (chart colours use it)
  modelEntries: [],           // the models on the chosen platform, in popup order: {id, row, note, unchecked}
  ticked: new Set(),          // the ids ticked on the chosen platform: the only models a run uses
  platform: null,             // the platform the model rows belong to, or null when none can be chosen
  hasList: false,             // true when the platform has a saved model list, or is the default platform
  modelsFile: null,           // the saved model lists (site/data/models.json), or null when they could not be read
  addedModels: [],            // the names the visitor added for this platform: {id, checked}, kept per platform
  popupRefresh: null,         // redraws the open model popup after its items change, or null when it is closed
  questionRows: [],           // one per question row of the suite on the form: its tick box and its question
  customModels: [],           // custom models from config.json that passed the checks in custom-model.js
  newRecords: [],             // replies made in this page session, for the JSON export
  log: null,                  // the operation log of the batch run on this page, for the log download
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
  initTooltips();
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
  dom.modelChoose.addEventListener("click", openModelPicker);
  dom.modelSelectAll.addEventListener("click", () => setAllModels(true));
  dom.modelClear.addEventListener("click", () => setAllModels(false));
  window.addEventListener(CHOICE_EVENT, onPlatformChosen);
  dom.questionChoose.addEventListener("click", openQuestionPicker);
  dom.questionAll.addEventListener("click", () => setChecks(dom.questionList, () => true));
  dom.questionNone.addEventListener("click", () => setChecks(dom.questionList, () => false));
  dom.questionCorrection.addEventListener("click", () => setChecks(dom.questionList, flaggedAs("correction_test")));
  dom.questionWrapper.addEventListener("click", () => setChecks(dom.questionList, flaggedAs("wrapper_test")));
  dom.customAdd.addEventListener("click", addFromForm);
  dom.customName.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addFromForm();
    }
  });
  dom.start.addEventListener("click", handleStart);
  dom.pause.addEventListener("click", togglePause);
  dom.stop.addEventListener("click", stopRun);
  dom.confirmContinue.addEventListener("click", confirmStart);
  dom.confirmCancel.addEventListener("click", cancelConfirmation);
  // The Runs popup is a native dialog. showModal() traps focus inside it and close() hands focus back.
  dom.runsButton.addEventListener("click", () => dom.runsDialog.showModal());
  dom.runsDone.addEventListener("click", () => dom.runsDialog.close());
  dom.exportGauntlet.addEventListener("click", exportGauntletCsv);
  dom.exportProbes.addEventListener("click", exportProbesCsv);
  dom.exportReplies.addEventListener("click", exportRepliesJson);
  dom.exportBatchLog.addEventListener("click", exportBatchLog);
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
    // The suites index gives each suite its experiment code, and the loaded data is checked against that entry.
    const [config, records, suites] = await Promise.all([
      loadDataFile(DATA_PATHS.config), loadDataFile(DATA_PATHS.records), loadDataFile(DATA_PATHS.suites),
    ]);
    requireGradeSettings(config);
    page.data = { config, savedRecords: records.map((record) => ({ ...record, condition: SAVED_CONDITION })) };
    page.loader = createSuiteLoader(loadDataFile, suites);
    fillSuiteSelects();
    setupControls(config);
    await loadModelChoices();
    await selectSuite(fixedChoice(DEFAULT_PUSHBACK_SET, DEFAULT_QUESTION_SET));
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
  await showLatestBatchRun();
}

/**
 * Show the newest saved batch when the page opens: its settings, its saved replies and its results. Nothing is sent,
 * and a batch on another suite is not shown. Start still runs only what is left.
 */
async function showLatestBatchRun() {
  if (page.storage === null || page.suite === null || isRunning()) {
    return;
  }
  const run = await latestRunOfKind(page.storage.adapter, KIND_BATCH).catch(() => null);
  if (run === null || !runMatchesSuite(run, page.suite) || restorePlanProblem(run.config) !== "") {
    return;
  }
  const { savedKeys, records } = resumeState(run);
  restoreChoices(run.config);
  page.runCondition = run.config.condition;
  addRecordsToCache(page.cache, records);
  page.counts = { done: savedKeys.length, total: run.plannedUnits.length, calls: 0, reused: 0, failed: 0 };
  renderProgress();
  onSelectionChanged();
  scheduleResults();
  setStatus(
    `Loaded your last batch from ${runDateText(run)}: ${formatCount(savedKeys.length)} of ${formatCount(run.plannedUnits.length)} units saved. `
    + "Nothing was sent. Press Start to run what is left, or see the results below.",
  );
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
  fillOptions(page.dom.pushbackSelect, setMenuChoices(pushbackSetNames()));
  fillOptions(page.dom.questionSetSelect, setMenuChoices(questionSetNames()));
}

/**
 * Fill the condition and number controls from the config, and note the custom endpoints. The model rows are not
 * built here: they depend on the platform chosen, so loadModelChoices draws them.
 */
function setupControls(config) {
  // A custom name is checked against every built-in name before it is accepted, so no two models share a name.
  page.customModels = checkedCustomModels(config, modelChoices(config).map((entry) => entry.id));
  fillConditionSelect(config.system_prompts);
  page.dom.repeats.value = String(config.repeats);
  page.dom.concurrency.value = String(config.concurrency);
  page.dom.fixedSettings.textContent = fixedSettingsText(config);
}

/** Load the saved model lists, then draw the model rows for the platform the visitor chose. Never throws. */
async function loadModelChoices() {
  page.modelsFile = await loadSavedModelLists();
  await refreshModelChoices();
}

/** Read the saved model lists. A missing or broken file gives null, so the popup shows its no-list note instead. */
async function loadSavedModelLists() {
  try {
    return await loadJson(MODELS_PATH);
  } catch {
    return null;
  }
}

/** Return the platform chosen in this browser, or null when none can be used. Never throws. */
async function chosenPlatformOrNull() {
  try {
    return await activePlatform();
  } catch {
    return null;
  }
}

/**
 * Redraw the model rows for the platform chosen now. A change of platform clears every tick, so no model of the old
 * platform stays ticked; when the default platform comes back, its own defaults are ticked again. Models the visitor
 * added for this platform are read from storage and kept per platform.
 */
async function refreshModelChoices() {
  const platform = await chosenPlatformOrNull();
  const previousId = page.platform === null ? null : page.platform.id;
  const nextId = platform === null ? null : platform.id;
  page.platform = platform;
  page.ticked = ticksAfterPlatformChange(previousId, nextId, page.ticked);
  page.addedModels = platform === null ? [] : readAddedModels(browserStorage(), platform.id);
  page.hasList = platform !== null && (platform.id === DEFAULT_PLATFORM_ID || hasSavedList(page.modelsFile, platform.id));
  rebuildEntries();
  if (platform !== null && previousId !== nextId && platform.id === DEFAULT_PLATFORM_ID) {
    setTickedModels(page.data.config.models);
  }
  if (previousId !== nextId) {
    page.resumeRunId = null;
  }
}

/**
 * Rebuild the rows and the id list of the chosen platform. The ticks are left as they are: each caller decides
 * which models stay ticked.
 */
function rebuildEntries() {
  setModelEntries(page.platform === null ? [] : buildEntries(page.platform));
  page.allModels = orderedIds(page.platform);
}

/**
 * Replace the rows in place. The popup keeps the same array while it is open, so it shows the new rows at once
 * without being reopened.
 */
function setModelEntries(entries) {
  page.modelEntries.length = 0;
  for (const entry of entries) {
    page.modelEntries.push(entry);
  }
}

/** Return the rows for a platform: the config models for Nebius only, otherwise its saved list, then the added names. */
function buildEntries(platform) {
  const base = platform.id === DEFAULT_PLATFORM_ID ? configEntries() : listEntries(platform.id);
  const added = addedRows(base.map((entry) => entry.id), page.addedModels)
    .map((entry) => ({ ...entry, row: modelRowText({ id: entry.id }) }));
  return [...base, ...added];
}

/**
 * Return the config models and the custom endpoints. These belong to the default platform only, so they are never
 * shown for another platform, where a model id could be run on an address that does not host it.
 */
function configEntries() {
  const models = sortByRank(modelChoices(page.data.config)).map((entry) => ({
    id: entry.id, row: modelRowText(entry), note: entry.kind ?? "", unchecked: false,
  }));
  const customs = page.customModels.map((entry) => ({ id: entry.name, row: null, note: "custom endpoint", unchecked: false }));
  return [...models, ...customs];
}

/** Return the rows of a platform's saved list, in file order. Only ids are known for these, so their row is made from the id. */
function listEntries(platformId) {
  return platformModelIds(page.modelsFile, platformId).map((id) => ({ id, row: null, note: "", unchecked: false }));
}

/** Return the row text of an entry. An entry with no row of its own (a plain list name) gets its row from its id. */
function rowOf(entry) {
  return entry.row ?? modelRowText({ id: entry.id });
}

/**
 * Return the ids in catalog order: the config models and custom names first (the chart colours depend on this order),
 * then the rest of the rows. Each id appears once.
 */
function orderedIds(platform) {
  const catalogIds = platform !== null && platform.id === DEFAULT_PLATFORM_ID
    ? [...modelChoices(page.data.config).map((entry) => entry.id), ...page.customModels.map((entry) => entry.name)]
    : [];
  return [...new Set([...catalogIds, ...page.modelEntries.map((entry) => entry.id)])];
}

/** Return the rows ticked on the chosen platform, in popup order. These are the models a run uses. */
function selectedEntries() {
  return page.modelEntries.filter((entry) => page.ticked.has(entry.id));
}

/** Return the ids ticked on the chosen platform, in popup order. These are the models a run uses. */
function selectedModelIds() {
  return selectedEntries().map((entry) => entry.id);
}

/** Build the thin lines for the ticked models. Only the first rows are drawn; the rest are counted in one line. */
function selectedModelItems(models) {
  const shown = models.slice(0, MAX_POPUP_ROWS).map((entry) => {
    const row = rowOf(entry);
    const item = selectedItem(row.rank, shortName(row.name));
    // The id is kept on the line, so the page (and its tests) can read which models are ticked.
    item.dataset.model = entry.id;
    return item;
  });
  const more = models.length - shown.length;
  return more > 0 ? [...shown, el("li", { className: "selected-item", text: `${formatCount(more)} more ticked` })] : shown;
}

/** Tick exactly the given models, if the chosen platform has them. Does not refresh the plan. */
function setTickedModels(ids) {
  const wanted = new Set(ids);
  page.ticked = new Set(page.allModels.filter((id) => wanted.has(id)));
}

/** Tick every model of the chosen platform, or untick them all, then refresh the plan. */
function setAllModels(on) {
  page.ticked = on ? new Set(page.modelEntries.map((entry) => entry.id)) : new Set();
  if (!page.confirming) {
    page.resumeRunId = null;
  }
  onSelectionChanged();
}

/**
 * The platform was changed in the platform section. The section refuses a change during a run, so this only redraws
 * the rows for the new platform, then refreshes the plan.
 */
async function onPlatformChosen() {
  if (page.data === null || isRunning() || page.confirming) {
    return;
  }
  await refreshModelChoices();
  onSelectionChanged();
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
 * were ticked stay ticked when the new suite has them too. The choice is { pushbackSet, questionSet }. Returns false
 * when a newer choice was made while this one loaded, so this suite is not put on the form.
 */
async function selectSuite(choice) {
  page.suiteRequest += 1;
  const request = page.suiteRequest;
  const suite = await page.loader.load(choice.pushbackSet, choice.questionSet);
  if (request !== page.suiteRequest) {
    return false;
  }
  page.suite = suite;
  page.dom.pushbackSelect.value = choice.pushbackSet;
  page.dom.questionSetSelect.value = choice.questionSet;
  page.dom.suiteSummary.textContent = suiteSummary(suite);
  page.cache = cacheFor(suite);
  page.questionsById = new Map(suite.questions.map((question) => [question.id, question]));
  rebuildQuestionList(suite);
  fillTierFilter(suite.questions);
  return true;
}

/** Choose a new suite from the two menus, then refresh the plan. */
async function onSuiteChanged() {
  const choice = fixedChoice(page.dom.pushbackSelect.value, page.dom.questionSetSelect.value);
  try {
    if (await selectSuite(choice)) {
      showPageStatus("Tick what to run. Nothing runs until you press Start.");
    }
  } catch (error) {
    showPageStatus(errorText(error));
  }
  onSelectionChanged();
}

/** Redraw the question tick boxes for a suite, keeping the ticks of questions the suite still has. */
function rebuildQuestionList(suite) {
  const kept = new Set(checkedValues(page.dom.questionList));
  page.questionRows = suite.questions.map((question) => buildQuestionRow(question, kept.has(question.id)));
  page.dom.questionList.replaceChildren(...page.questionRows.map((entry) => entry.row));
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

/** Build the text of one picker card: the rank, the short name with its note, and the facts under the name. */
function buildModelCard(entry) {
  const row = rowOf(entry);
  const note = entryNote(entry);
  const name = note ? `${shortName(row.name)} (${note})` : shortName(row.name);
  // A plain name from a saved list has no rank or facts, so the card shows the name alone.
  if (hasNoDetails(row)) {
    return el("span", { className: "pick-model" }, [el("span", { className: "pick-model-name", text: name })]);
  }
  return el("span", { className: "pick-model", title: row.basis }, [
    el("span", { className: "model-rank", text: row.rank }),
    el("span", { className: "pick-model-name", text: name }),
    buildModelFacts(row),
  ]);
}

/**
 * Open the "Choose models" popup. Its cards tick and untick the rows of the chosen platform, and its top part adds a
 * model name. The names are sorted under letter headings and shown PAGE_SIZE at a time, so a list of thousands stays quick.
 */
function openModelPicker() {
  const addArea = buildModelAddArea({
    hasList: page.hasList,
    addedModels: page.addedModels,
    onAdd: addTypedModel,
    onRemove: removeAddedModel,
  });
  // The picker keeps the array it was given, so the names are refilled in place whenever the rows change.
  const names = [];
  const rowById = new Map();
  const refillNames = () => {
    rowById.clear();
    for (const entry of page.modelEntries) rowById.set(entry.id, entry);
    names.length = 0;
    for (const id of sortModelIds([...rowById.keys()])) names.push(id);
  };
  refillNames();
  const dialog = openPicker({
    title: "Choose models",
    items: names,
    isSelected: (id) => page.ticked.has(id),
    onToggle: (id) => toggleModel(rowById.get(id)),
    renderCard: (id) => buildModelCard(rowById.get(id)),
    pageSize: PAGE_SIZE,
    groupItems: letterGroups,
    header: addArea.node,
    onSelectAll: () => setAllModels(true),
    onClear: () => setAllModels(false),
    onReady: (redraw) => {
      page.popupRefresh = () => {
        refillNames();
        redraw();
      };
    },
    searchPlaceholder: "Search models",
  });
  dialog.addEventListener("close", () => {
    page.popupRefresh = null;
  });
}

/** Tick or untick one model from the popup. The picker redraws its own card; the plan and the lists follow here. */
function toggleModel(entry) {
  if (page.ticked.has(entry.id)) {
    page.ticked.delete(entry.id);
  } else {
    page.ticked.add(entry.id);
  }
  selectionChanged();
}

/** Note a change to what is ticked: a fresh run is needed, then the plan and the lists are refreshed. */
function selectionChanged() {
  if (!page.confirming) {
    page.resumeRunId = null;
  }
  onSelectionChanged();
}

/** Refresh what shows the rows after they change: the open popup, the lists, the counts and the plan. */
function afterListChange() {
  page.popupRefresh?.();
  selectionChanged();
}

/** Return true when the key saved in this browser was entered for this platform, or once the visitor gives one for it. */
async function keyReadyFor(platform) {
  if (vault.has() && keyFitsPlatform(vault.platformId(), platform.id)) {
    return true;
  }
  return askForToken({ vault, platformId: platform.id });
}

/**
 * Check a typed name for the chosen platform, then add it. Returns {message, added, addedModels} for the add area.
 * A name is refused before any request when it is unsafe or empty. Otherwise the platform list is checked when a key
 * for this platform is saved, and a name it does not have is refused with close names.
 */
async function addTypedModel(text) {
  const platform = page.platform;
  if (platform === null) {
    return { message: NO_PLATFORM_ADD_TEXT, added: false, addedModels: page.addedModels };
  }
  const early = resolveNewModel(platform, text, null);
  if (!early.ok) {
    return refusedResult(early);
  }
  const found = resolveNewModel(platform, text, await platformIdsForCheck(platform));
  if (!found.ok) {
    return refusedResult(found);
  }
  return saveNewModel(platform, found.model, found.checked);
}

/** Return the result for a name that cannot be added: its plain line, and the names the visitor already has. */
function refusedResult(found) {
  return { message: refusalText(found.reason, found.suggestions), added: false, addedModels: page.addedModels };
}

/**
 * Return the platform's own list of ids for the check, or null when the check cannot run. It cannot run when no key is
 * saved, when the saved key was entered for another platform (that key is never sent there), or when the request
 * fails. Null means the name is added as not checked.
 */
async function platformIdsForCheck(platform) {
  if (!vault.has() || !keyFitsPlatform(vault.platformId(), platform.id)) {
    return null;
  }
  try {
    return await fetchModelIds({ platform, token: vault.get() });
  } catch {
    return null;
  }
}

/**
 * Add a checked or unchecked name for the platform, or tick it when the platform already has it. A new name is saved
 * for this platform only, ticked, and its row shows at once.
 */
function saveNewModel(platform, model, checked) {
  if (page.modelEntries.some((entry) => entry.id === model)) {
    page.ticked.add(model);
    afterListChange();
    return { message: `${model} is already in the list, so it is ticked.`, added: true, addedModels: page.addedModels };
  }
  const next = withAddedModel(page.addedModels, model, checked);
  const saved = writeAddedModels(browserStorage(), platform.id, next.added);
  page.addedModels = next.added;
  rebuildEntries();
  page.ticked.add(model);
  afterListChange();
  return { message: addOutcomeText({ model, checked, saved }), added: true, addedModels: page.addedModels };
}

/** Remove a name the visitor added for the chosen platform. It is unticked, and the saved list is updated. */
function removeAddedModel(id) {
  if (page.platform === null) {
    return { message: "", addedModels: [] };
  }
  const kept = withoutAddedModel(page.addedModels, id);
  const saved = writeAddedModels(browserStorage(), page.platform.id, kept);
  page.addedModels = kept;
  page.ticked.delete(id);
  rebuildEntries();
  afterListChange();
  const storageNote = saved ? "" : " Browser storage is blocked, so this lasts only for this page visit.";
  return { message: `Removed ${id}.${storageNote}`, addedModels: kept };
}

/** The form's own Add control. It runs the same checks as the popup, and its line shows under the field. */
async function addFromForm() {
  const result = await addTypedModel(page.dom.customName.value);
  page.dom.customMessage.textContent = result.message;
  if (result.added) {
    page.dom.customName.value = "";
  }
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
 * Build one question row: a tick box labelled with the id, tier and first words of the question. Returns the row
 * and its picker entry, which keeps the tick box and the question for the picker card.
 */
function buildQuestionRow(question, checked = false) {
  const label = buildCheckbox(question.id, { text: questionLabel(question), checked });
  const row = el("div", { className: "check-row", "data-tier": question.tier }, [label]);
  return { row, input: label.querySelector("input"), question };
}

/**
 * Open the question picker. It shows the questions of the chosen tier; its cards tick and untick the same boxes
 * the rest of the page reads.
 */
function openQuestionPicker() {
  const tier = page.dom.tierFilter.value;
  const items = page.questionRows.filter((entry) => tier === "all" || entry.question.tier === tier);
  openPicker({
    title: tier === "all" ? "Choose questions" : `Choose questions (${tier})`,
    items,
    isSelected: (item) => item.input.checked,
    onToggle: toggleQuestion,
    renderCard: buildQuestionCard,
    onSelectAll: () => setChecks(page.dom.questionList, () => true),
    onClear: () => setChecks(page.dom.questionList, () => false),
    searchPlaceholder: "Search questions",
  });
}

/** Tick or untick one question from the picker. Does what a tick box change does: a fresh run, then a refresh. */
function toggleQuestion(item) {
  item.input.checked = !item.input.checked;
  if (!page.confirming) {
    page.resumeRunId = null;
  }
  onSelectionChanged();
}

/** Build the text of one picker card: the id and tier on a small line, the question text below. */
function buildQuestionCard({ question }) {
  return el("span", { className: "pick-question" }, [
    el("span", { className: "pick-question-meta", text: `${question.id} · ${question.tier}` }),
    el("span", { className: "pick-question-text", text: question.question }),
  ]);
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
    models: selectedModelIds(),
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

/** Return true for a suite menu. Those have their own handlers, so the form handler leaves them alone. */
function isSuiteControl(target) {
  const controls = [page.dom.pushbackSelect, page.dom.questionSetSelect];
  return controls.includes(target);
}

/** Handle a change in the setup form, then refresh the plan. */
function onFormEdited(event) {
  const target = event.target;
  // The preset panel and the suite menus have their own handlers, and the plan does not depend on them.
  if (page.dom.presetHost.contains(target) || isSuiteControl(target)) {
    return;
  }
  // Editing the form means the next Start is a fresh run, not the continuation of a saved one.
  if (!page.confirming) {
    page.resumeRunId = null;
  }
  if (target === page.dom.cap) {
    page.capTouched = true;
  }
  onSelectionChanged();
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
  renderSelectedLists();
  if (page.phase === "idle") {
    resetCounts(unitCount(choices));
    renderProgress();
  }
  updateControls();
  scheduleSelectionResults();
}

/** Refresh the count line of each multi-select group: models, questions and probe families. */
function updateCountLines() {
  updateSelectionCount(page.dom.modelCount, selectedModelIds().length, page.modelEntries.length, "models");
  updateGroupCount(page.dom.questionCount, page.dom.questionList, "questions");
  updateGroupCount(page.dom.familyCount, page.dom.familyList, "families");
}

/** Write a group's count line, such as "3 of 29 models selected", from its tick boxes. */
function updateGroupCount(countElement, container, noun) {
  const total = container.querySelectorAll("input[type='checkbox']").length;
  updateSelectionCount(countElement, checkedValues(container).length, total, noun);
}

/** Fill the thin lists under the Models and Questions cards with the ticked items, so the choice reads at a glance. */
function renderSelectedLists() {
  const models = selectedEntries();
  const questions = page.questionRows.filter((entry) => entry.input.checked);
  page.dom.modelSelected.replaceChildren(...selectedModelItems(models));
  page.dom.questionSelected.replaceChildren(
    ...questions.map((entry) => selectedItem(entry.question.id, entry.question.question)),
  );
}

/** Build one line of a selected list: a small lead (rank or id) and the name or question text after it. */
function selectedItem(lead, text) {
  return el("li", { className: "selected-item" }, [
    el("span", { className: "selected-lead", text: lead }),
    el("span", { className: "selected-text", text }),
  ]);
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
  dom.planProblem.textContent = findProblem(choices) ?? largeRunWarning(plan === null ? 0 : plan.totals.atMostNew);
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
  // The platform section reads this flag and refuses a platform change while it is on.
  setRunLocked(running || page.confirming);
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

/** Start was pressed. Ask for the key when there is none, then show the confirmation line. */
async function handleStart() {
  if (page.confirming || isRunning() || page.platform === null || findProblem(readChoices()) !== null) {
    return;
  }
  // confirming locks the form (see updateControls) while the key dialog and confirmation line are open.
  page.confirming = true;
  updateControls();
  const ready = await keyReadyFor(page.platform);
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
  beginRun(page.platform === null ? null : page.platform.id).catch(handleRunError);
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
    ...choiceOfSuite(page.suite),
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
async function beginRun(confirmedId) {
  // The platform is read first. The ticked models belong to the platform the visitor confirmed, so any other
  // platform stops the run before a single call is made.
  const platform = await activePlatform();
  if (page.platform === null || platform.id !== confirmedId || page.platform.id !== confirmedId) {
    setStatus(PLATFORM_CHANGED_TEXT);
    await refreshModelChoices();
    onSelectionChanged();
    return;
  }
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
  // The log is new for each start. It records what the run did, and never the key or a reply.
  page.log = createBatchLog();
  page.log.record("run-started", {
    run_id: page.runId,
    models: choices.models.length,
    questions: selectedQuestions(choices.questions).length,
    repeats: choices.repeats,
    condition: choices.condition,
    cap: choices.cap,
    concurrency: choices.concurrency,
    key_remembered: vault.remembered(),
  });
  updateExportButtons();
  // The budget enforces the call cap; the runner stops the batch when it is used up (see onBudgetExhausted).
  const client = createChatClient({
    platform,
    customModels: page.customModels,
    vault,
    budget: createBudget(choices.cap),
    timeoutMs: config.request_timeout_seconds * 1000,
    log: page.log,
    perModelLimit: config.per_model_concurrency,
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
    log: page.log,
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
  // A batch from the shuffled orders kept a seed. Its ladder or question order is not on this site any more.
  if ((config.pushbackSeed ?? null) !== null || (config.questionSeed ?? null) !== null) {
    setStatus("This saved batch used a shuffled order that this site no longer has, so it cannot be resumed.");
    return;
  }
  await selectSuite(fixedChoice(config.pushbackSet, config.questionSet));
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
  setTickedModels(config.models);
  tickOnly(dom.questionList, config.questions);
  tickOnly(dom.familyList, config.families);
  dom.repeats.value = String(config.repeats);
  dom.concurrency.value = String(config.concurrency);
  dom.cap.value = String(config.callCap);
  page.capTouched = true;
  dom.condition.value = config.condition;
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
  page.log?.record("run-error", { message: errorText(error) });
  updateExportButtons();
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
  const figureMeasures = resultMeasures(page.suite.levelCount);
  renderResultsFigures(document.getElementById("results-figures"), analyticsRows(choices.models, gauntletRows, figureMeasures), figureMeasures);
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

// Results view state. The measure choice survives redraws; the last models and grade rows let the switcher
// redraw without grading again; the shell is the persistent block that holds the switcher and the table disclosure.
const RESULTS_MEASURE_DEFAULT = "baseline_accuracy";
const FLIP_MEASURE_KEY = "flip_rate_level_10";
let resultsMeasureKey = RESULTS_MEASURE_DEFAULT;
let resultsShell = null;
let lastGauntlet = { models: [], rows: [] };

/** Return the analytics measures for this suite: MEASURES keys, with the label and digits of each gauntlet field. */
function resultMeasures(levelCount) {
  const fields = gauntletMeasures(levelCount);
  return MEASURES.map((measure) => {
    const field = measure.key === FLIP_MEASURE_KEY ? `flip_rate_level_${levelCount}` : measure.key;
    const [label, , digits] = fields.find(([, name]) => name === field);
    return { key: measure.key, field, label, digits, higherIsBetter: measure.higherIsBetter, definition: measure.definition };
  });
}

/** Turn the grade rows into analytics rows: one per ticked model, with null for any missing or unusable value. */
function analyticsRows(models, rows, measures) {
  return models.map((model, index) => {
    const row = rows.find((candidate) => candidate.model === model);
    const values = Object.fromEntries(measures.map((measure) => {
      const value = row === undefined ? null : row[measure.field];
      return [measure.key, Number.isFinite(value) ? value : null];
    }));
    return { model, index, measures: values };
  });
}

/** Draw the comparison: a measure switcher, a ranked bar list, a heatmap, and a collapsed table of the raw numbers. */
function renderGauntletTables(models, rows) {
  lastGauntlet = { models, rows };
  const host = page.dom.gauntletTables;
  if (models.length === 0 || rows.length === 0) {
    resultsShell = null;
    host.replaceChildren();
    return;
  }
  const levelCount = page.suite.levelCount;
  const measures = resultMeasures(levelCount);
  if (resultsShell === null || !host.contains(resultsShell.root)) {
    resultsShell = buildResultsShell();
    host.replaceChildren(resultsShell.root);
  }
  const selected = measures.find((measure) => measure.key === resultsMeasureKey) ?? measures[0];
  resultsShell.select.replaceChildren(...measures.map((measure) => el("option", { value: measure.key, text: measure.label })));
  resultsShell.select.value = selected.key;
  const ranked = rankModels(analyticsRows(models, rows, measures), selected.key);
  resultsShell.body.replaceChildren(buildRankBlock(ranked, selected), buildHeatBlock(ranked, measures));
  resultsShell.tables.replaceChildren(
    ...models.map((model) => buildModelTable(model, rows.find((row) => row.model === model), gauntletMeasures(levelCount))),
  );
}

/** Build the persistent parts of the comparison once: the switcher, the body and the table disclosure. */
function buildResultsShell() {
  const select = el("select", { id: "results-measure", className: "results-select" });
  select.addEventListener("change", () => {
    resultsMeasureKey = select.value;
    renderGauntletTables(lastGauntlet.models, lastGauntlet.rows);
  });
  const body = el("div", { className: "results-body" });
  const tables = el("div", { className: "model-tables" });
  const root = el("div", { className: "results-block" }, [
    el("div", { className: "results-controls" }, [el("label", { for: "results-measure", className: "results-label", text: "Measure" }), select]),
    body,
    el("details", { className: "results-details" }, [
      el("summary", { text: "Show as table" }),
      el("div", { className: "table-scroll" }, [tables]),
    ]),
  ]);
  return { root, select, body, tables };
}

/** Highlight, or un-highlight, every row for one model in both the bar list and the heatmap. */
function setModelHighlight(index, on) {
  if (resultsShell === null) return;
  for (const node of resultsShell.root.querySelectorAll(`[data-model-index="${index}"]`)) {
    node.classList.toggle("is-highlight", on);
  }
}

/** Make hovering a row highlight that model in both views. */
function linkModelHover(node, index) {
  node.addEventListener("mouseenter", () => setModelHighlight(index, true));
  node.addEventListener("mouseleave", () => setModelHighlight(index, false));
}

/** Build the ranked bar list for the chosen measure. Bars are scaled with normalise; null values show "No data". */
function buildRankBlock(ranked, measure) {
  const values = ranked.map((row) => row.measures[measure.key]);
  const scaled = normalise(values, measure.higherIsBetter);
  // normalise gives every value 0.5 when they are all equal, so a single ticked model would get a half-width bar.
  const usableCount = values.filter((value) => typeof value === "number" && Number.isFinite(value)).length;
  const items = ranked.map((row, position) => {
    const missing = values[position] === null;
    const track = el("span", { className: "rank-track", "aria-hidden": "true" });
    if (!missing) {
      const bar = el("span", { className: "rank-bar" });
      bar.style.width = usableCount === 1 ? "100%" : `${Math.round(scaled[position] * 100)}%`;
      track.append(bar);
    }
    const item = el("li", { className: missing ? "rank-row is-missing" : "rank-row", "data-model-index": row.index }, [
      el("span", { className: "rank-pos", text: String(position + 1) }),
      el("span", { className: "rank-name", text: shortName(row.model), title: row.model }),
      track,
      el("span", { className: "rank-value", text: missing ? "No data" : formatNumber(values[position], measure.digits) }),
    ]);
    linkModelHover(item, row.index);
    return item;
  });
  return el("section", { className: "results-section" }, [
    el("h3", { className: "results-subhead", text: `Ranked by ${measure.label}` }),
    el("p", { className: "field-hint", text: "Longest bar is the best model. Hover a row to find that model in the heatmap." }),
    el("div", { className: "results-scroll" }, [el("ol", { className: "rank-list", "aria-label": `Models ranked by ${measure.label}` }, items)]),
  ]);
}

/** Build the heatmap: models in ranked order as rows, measures as columns, each column scaled by normalise. */
function buildHeatBlock(ranked, measures) {
  const matrix = heatmapMatrix(ranked, measures.map((measure) => measure.key));
  const header = el("tr", {}, [
    el("th", { scope: "col", text: "Model" }),
    ...measures.map((measure) => el("th", { scope: "col", text: measure.label })),
  ]);
  const bodyRows = ranked.map((row, rowIndex) => {
    const cells = measures.map((measure, columnIndex) => heatCell(row, measure, matrix.cells[rowIndex][columnIndex]));
    const tr = el("tr", { "data-model-index": row.index }, [
      el("th", { scope: "row", text: shortName(row.model), title: row.model }),
      ...cells,
    ]);
    linkModelHover(tr, row.index);
    return tr;
  });
  return el("section", { className: "results-section" }, [
    el("h3", { className: "results-subhead", text: "Heatmap" }),
    el("p", { className: "field-hint", text: "Each column is scaled across the ticked models: the strongest tint is the best model, the faintest the worst." }),
    el("div", { className: "results-scroll" }, [
      el("table", { className: "heat-table" }, [
        el("caption", { className: "visually-hidden", text: "Heatmap of the gauntlet measures for each ticked model" }),
        el("thead", {}, [header]),
        el("tbody", {}, bodyRows),
      ]),
    ]),
  ]);
}

/** Build one heatmap cell. Its tint comes from a colour-mix on the sage token, and the title gives the raw value. */
function heatCell(row, measure, scaled) {
  const raw = row.measures[measure.key];
  if (scaled === null) {
    return el("td", { className: "heat-cell is-missing", text: "No data", title: `${shortName(row.model)}, ${measure.label}: no data` });
  }
  const cell = el("td", {
    className: "heat-cell",
    text: formatNumber(raw, measure.digits),
    title: `${shortName(row.model)}, ${measure.label}: ${raw}`,
  });
  cell.style.setProperty("--heat", String(Math.round(10 + scaled * 40)));
  return cell;
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
  page.dom.exportBatchLog.disabled = page.log === null || page.log.entries().length === 0;
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

/** Download the operation log of the batch run as JSON Lines. It has no key and no reply text. */
function exportBatchLog() {
  if (page.log === null) {
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadText(`ordeal-batch-log-${stamp}.jsonl`, page.log.toJsonl(), "application/x-ndjson");
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
    ...choiceOfSuite(page.suite),
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
  const current = choiceOfSuite(page.suite);
  await selectSuite(fixedChoice(
    settings.pushbackSet ?? current.pushbackSet,
    settings.questionSet ?? current.questionSet,
  ));
  const notes = [];
  if (settings.models !== undefined) {
    const known = settings.models.filter((model) => page.allModels.includes(model));
    setTickedModels(known);
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
