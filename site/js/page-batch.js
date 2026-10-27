// Page II, The Batch. Tick the models, questions and probe families, see the exact call plan, then run
// the batch in this browser with the key the user types. Each finished unit is saved in this browser, so a
// reload can resume an unfinished run without repeating the calls that are already saved.

import { loadJson } from "./data-cache.js";
import { showToast } from "./toast.js";
import { initTooltips } from "./tooltip.js";
import { browserStorage, vault } from "./engine/token.js";
import { createBatchLog } from "./engine/batch-log.js";
import { latestRunOfKind, runMatchesSuite, runDateText } from "./last-run.js";
import { VIEW_IDS } from "./view-ids.js";
import { updateConditionDescription } from "./condition-text.js";
import { createBudget, createChatClient, MAX_ATTEMPTS_PER_STEP } from "./engine/api.js";
import { activePlatform } from "./platform-choice.js";
import { DEFAULT_PLATFORM_ID, parseModelReference } from "./platforms.js";
import { CHOICE_EVENT } from "./platform-section.js";
import { setRunLocked, suiteChoiceLocked } from "./run-lock.js";
import {
  MAX_POPUP_ROWS, MODELS_PATH, PAGE_SIZE, hasSavedList, platformModelIds, readAddedModels, writeAddedModels,
  withAddedModel, withoutAddedModel, addedRows, addOutcomeText, entryNote,
  ticksAfterPlatformChange, largeRunWarning, sortModelIds, letterGroups, withCatalogueNumbers,
  nextAddedNumber, numberAddedModels, readAddedCounter, writeAddedCounter,
} from "./model-list.js";
import { buildModelAddArea } from "./model-popup.js";
import { mountModelCheck } from "./model-check.js";
import { checkTypedName, keyReadyFor } from "./typed-model-check.js";
import { hostOfCustomUrl, validateCustomModel } from "./engine/custom-model.js";
import { createBatchRunner } from "./engine/runner.js";
import { buildCacheIndex, cacheKey, planAllModels } from "./engine/planner.js";
import { gradeCondition, gradeProbes } from "./engine/grade.js";
import { MEASURES, heatmapMatrix, normalise, rankModels } from "./analytics.js";
import { renderResultsFigures } from "./batch-figures.js";
import { mountFingerprintFigure } from "./fingerprint-figure.js";
import { clear, el, formatNumber } from "./ui.js";
import { openPicker } from "./picker-dialog.js";
import { modelNumberText, hasNoDetails, modelRowText, sortByRank } from "./model-details.js";
import { rateLimitRowFor } from "./rate-limits.js";
import { updateSelectionCount } from "./selection-count.js";
import { idsForAction, numberedQuestionLines, shortQuestionText } from "./question-actions.js";
import { createRun, saveResult, setStatus as setRunStatus, resumeRun, pendingUnits } from "./store/run-store.js";
import { createPresetStore } from "./presets.js";
import {
  createSuiteLoader, suiteSummary, isSavedSuite, isPushbackSet, isQuestionSet, DEFAULT_CHOICE, SHUFFLE_CHOICE,
  choiceOfSuite, choiceValueOfSuite, fixedChoice, retiredPairText, setsOfChoice, suiteChoiceMenu,
} from "./suites.js";
import {
  applyMixedOrder, buildMixedSuite, countsSentence, mixCounts, mixedOrderPath, MIXED_NAME, orderRows,
  pickMixedSeed, PUSHBACK_FOR_SET, selectSlots,
} from "./mixed-order.js";
import {
  createSerialQueue, KIND_BATCH, plannedBatchUnits, unitKeyFor, unitPayload, resumeState, addRecordsToCache,
} from "./saved-runs.js";
import {
  openPageStorage, storageText, buildPresetPanel, buildRunsList, buildResumeNotices, downloadText,
  wireRunsPopup, showRunCounts, closePopupBeforeResume,
} from "./persistence-ui.js";
import { readReplyGroups, importReplyGroups } from "./full-run-upload.js";

const DATA_PATHS = {
  config: "/data/config.json",
  records: "/data/sample_run.json",
  suites: "/data/suites.json",
  // Read on its own, not with the others, because the page still works when this file is missing.
  rateLimits: "/data/rate_limits.json",
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
const MAX_CONCURRENCY = 300;
// The most API attempts one batch may be given. It is the same limit as the live page's cap.
const MAX_BATCH_CALLS = 400;
// The default call cap is the planned attempt bound rounded up to a multiple of this.
const CAP_STEP = 10;
const MAX_LOG_ENTRIES = 200;
const RESULTS_INTERVAL_MS = 500;
const LABEL_LIMIT = 80;
// Quick grading for redraws while a run is going, so each redraw stays fast. The config value is used after.
const FAST_RESAMPLES = 200;
// Prices are typed per million tokens, so the cost estimate divides by this.
const PRICE_SCALE = 1000000;
// The progress bar uses one width class per step: progress-0, progress-5 ... progress-100 (see the CSS).
const PROGRESS_STEP = 5;
const PROGRESS_BASE_CLASS = "progress-fill";

// The Shuffle wording: the summary under the sets, the note on a busy page, and why the batch page shows no results.
const MIXED_SUMMARY = "Both sets in one order: easy with gauntlet_v3, hard with gauntlet_v4. The seed is picked when the run starts.";
const MIXED_BUSY_TEXT = "A run is in progress, so Shuffle cannot change until it ends. Wait for it to finish or stop it.";
const MIXED_RESULTS_TEXT = "A mixed run is graded per set by the Python tool (ordeal.grade --shuffle-mix). This page shows no grades for it.";
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
const RUN_DONE_TEXT = "Every unit of this run is already saved. Nothing was sent; the results are shown.";
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
  shuffleNote: "batch-shuffle-note",
  suiteSelect: VIEW_IDS.batch["suite-select"],
  suiteSummary: VIEW_IDS.batch["suite-summary"],
  presetHost: VIEW_IDS.batch["preset-panel"],
  resumeNotices: VIEW_IDS.batch["resume-notices"],
  runsList: VIEW_IDS.batch["runs-list"],
  storageNote: VIEW_IDS.batch["storage-note"],
  runsButton: "batch-runs-button",
  runsDialog: "batch-runs-dialog",
  runsDone: "batch-runs-done",
  fullRunFile: "batch-full-run-file",
  fullRunStatus: "batch-full-run-status",
  unfinishedCount: "batch-unfinished-count",
  savedCount: "batch-saved-count",
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
  questionMenuButton: "question-menu-button",
  questionMenuDialog: "question-menu-dialog",
  questionMenuDone: "question-menu-done",
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
  conditionNote: "batch-condition-note",
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
  figure: "fingerprint-figure",
  exportReplies: "export-replies",
  exportBatchLog: "export-batch-log",
};

// Everything the page needs at any moment. Controls are read from the page; this object holds the rest.
const page = {
  dom: null,                  // the elements named in IDS
  data: null,                 // config and the saved records, once loaded
  loadError: "",              // the message when a data file could not be loaded
  suite: null,                // the suite on the form: its ladder, its questions, and its pushback and question sets
  loader: null,               // the suite loader, which keeps each suite once it is read
  suiteRequest: 0,            // counts the suite choices made, so a load that a newer choice overtook is not shown
  caches: new Map(),          // the reply cache of each suite, by suite name (the runner reads and writes it)
  cache: new Map(),           // the reply cache of the suite on the form
  questionsById: new Map(),   // question objects by id, for the suite on the form
  allModels: [],              // the ids of the models on the chosen platform, catalog order first
  modelEntries: [],           // the models on the chosen platform, in popup order: {id, row, note, unchecked}
  ticked: new Set(),          // the ids ticked on the chosen platform: the only models a run uses
  platform: null,             // the platform the model rows belong to, or null when none can be chosen
  hasList: false,             // true when the platform has a saved model list, or is the default platform
  modelsFile: null,           // the saved model lists (site/data/models.json), or null when they could not be read
  rateLimits: null,           // the per-model rate limits (site/data/rate_limits.json), or null when they could not be read
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
  fingerprint: null,          // the fingerprint figure (its views and drawing), made at start-up
  resultsTimer: null,         // the pending results redraw, or null
  lastResultsAt: 0,           // when the results were last drawn, in milliseconds
  storage: null,              // { adapter, fallback } from the run storage
  presets: null,              // the preset store
  panels: {},                 // the preset panel, the notices and the Saved runs list
  queue: createSerialQueue(), // run writes, one at a time
  runId: null,                // the saved run of the batch on screen, or null
  resumeRunId: null,          // the saved run the next Start continues, or null
  unitSteps: new Map(),       // the step records of each unit still running, by unit key
  mixed: null,                // with Shuffle on: { seed, slots } of the run, once picked or restored; else null
};

/**
 * Set the batch page up inside its section: find the controls, wire them, then load the data files. The router
 * calls this once, the first time the view is shown, so the page keeps its state when the visitor leaves it.
 */
export function mountBatch(root) {
  page.dom = findElements(root);
  // The "not in the list" field uses the same add path as "Add another model name" (addTypedModel), and the same key
  // prompt for the chosen platform as a run (keyReadyFor).
  mountModelCheck(root.querySelector("#model-check"), {
    onCheck: addTypedModel,
    keyReady: keyForChosenPlatform,
    checkingText: checkingTextFor,
  });
  page.fingerprint = mountFingerprintFigure(page.dom.figure);
  wireControls();
  initTooltips();
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
  dom.suiteSelect.addEventListener("change", onSuiteChanged);
  dom.condition.addEventListener("change", refreshConditionNote);
  dom.modelChoose.addEventListener("click", openModelPicker);
  dom.modelSelectAll.addEventListener("click", () => setAllModels(true));
  dom.modelClear.addEventListener("click", () => setAllModels(false));
  window.addEventListener(CHOICE_EVENT, onPlatformChosen);
  // The Questions dropdown is a native dialog too. Each choice inside it runs through runQuestionAction.
  dom.questionMenuButton.addEventListener("click", () => dom.questionMenuDialog.showModal());
  dom.questionMenuDone.addEventListener("click", () => dom.questionMenuDialog.close());
  dom.questionAll.addEventListener("click", () => runQuestionAction("all"));
  dom.questionNone.addEventListener("click", () => runQuestionAction("none"));
  dom.questionCorrection.addEventListener("click", () => runQuestionAction("correction"));
  dom.questionWrapper.addEventListener("click", () => runQuestionAction("wrapper"));
  dom.questionChoose.addEventListener("click", () => runQuestionAction("choose"));
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
  wireRunsPopup({ button: dom.runsButton, dialog: dom.runsDialog, done: dom.runsDone });
  dom.fullRunFile.addEventListener("change", (event) => loadFullRunFile(event.target));
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
    await selectSuite(setsOfChoice(DEFAULT_CHOICE));
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
    onResume: closePopupBeforeResume(page.dom.runsDialog, resumeBatchRun),
    onChanged: onRunDeleted,
  };
  page.panels.notices = buildResumeNotices({ ...shared, activeRunId: () => page.runId });
  // The count line in the popup already says "No saved runs yet", so the list shows nothing extra when it is empty.
  page.panels.list = buildRunsList({ ...shared, emptyText: null });
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

/**
 * Load the four conditions of a full run from the replies file picked in the Runs popup. Each condition is saved as a
 * run, so the Saved list shows it, and Resume opens its results and charts. Nothing is sent to a model, because every
 * planned unit already has its reply.
 */
async function loadFullRunFile(input) {
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (page.storage === null || page.data === null) {
    showFullRunStatus("Saved runs are not available in this window, so the full run cannot be loaded.");
    return;
  }
  showFullRunStatus(`Reading ${file.name}. A large file can take a minute.`);
  try {
    const groups = await readReplyGroups(file);
    const common = {
      callCap: MAX_BATCH_CALLS,
      temperature: page.data.config.temperature,
      maxTokens: page.data.config.max_tokens,
    };
    const { saved, skipped } = await importReplyGroups(page.storage.adapter, groups, common);
    await refreshRuns();
    const savedText = saved.length > 0 ? `Saved: ${saved.join(", ")}.` : "Nothing new was saved.";
    const skippedText = skipped.length > 0 ? ` Not saved: ${skipped.join("; ")}.` : "";
    showFullRunStatus(savedText + skippedText);
  } catch (error) {
    showFullRunStatus(`The file could not be loaded: ${errorText(error)} Check that it is the cache.jsonl file.`);
  }
}

/**
 * Say what the full-run upload is doing. The text goes in the Runs popup, under the file box, because the page's own
 * status line sits behind the open popup and would not be seen. It also goes to the page's status line.
 */
function showFullRunStatus(text) {
  page.dom.fullRunStatus.textContent = text;
  setStatus(text);
}

/**
 * Redraw the notices and the Saved runs list from storage, then the counts that show them. A storage problem leaves
 * the lists and the counts as they were.
 */
async function refreshRuns() {
  if (page.panels.list === undefined) {
    return;
  }
  try {
    const unfinished = await page.panels.notices.refresh();
    const saved = await page.panels.list.refresh();
    showRunCounts({
      button: page.dom.runsButton,
      unfinishedLine: page.dom.unfinishedCount,
      savedLine: page.dom.savedCount,
    }, unfinished, saved);
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

/** Fill the suite menu with its three choices: Gauntlet v4 with hard questions, Gauntlet v3 with easy, and Shuffle. */
function fillSuiteSelects() {
  fillOptions(page.dom.suiteSelect, suiteChoiceMenu());
}

/**
 * Fill the condition and number controls from the config, and note the custom endpoints. The model rows are not
 * built here: they depend on the platform chosen, so loadModelChoices draws them.
 */
function setupControls(config) {
  // A custom name is checked against every built-in name before it is accepted, so no two models share a name.
  page.customModels = checkedCustomModels(config, modelChoices(config).map((entry) => entry.id));
  fillConditionSelect(config.system_prompts);
  refreshConditionNote();
  page.dom.repeats.value = String(config.repeats);
  page.dom.concurrency.value = String(config.concurrency);
  page.dom.fixedSettings.textContent = fixedSettingsText(config);
  // A reload can keep the choice from the last visit. The page always opens on the default suite, so it never opens
  // on Shuffle by accident.
  page.dom.suiteSelect.value = DEFAULT_CHOICE;
}

/** Load the saved model lists, then draw the model rows for the platform the visitor chose. Never throws. */
async function loadModelChoices() {
  page.modelsFile = await loadSavedModelLists();
  page.rateLimits = await loadRateLimits();
  await refreshModelChoices();
}

/**
 * Read the per-model rate limits. A missing or broken file gives null, so each row says "unknown" and names the
 * file, and the rest of the page works without it.
 */
async function loadRateLimits() {
  try {
    return await loadJson(DATA_PATHS.rateLimits);
  } catch {
    return null;
  }
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
  if (platform !== null) numberSavedNames(platform);
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

/**
 * Return the rows for a platform: the config models for Nebius only, otherwise its saved list, then the added names.
 * The catalogue models are numbered here by position. A name the visitor added already has its number, from when it
 * was added, so it is kept as it is. The card, the selected line and the plan line all read the number from the row.
 */
function buildEntries(platform) {
  const base = withCatalogueNumbers(platform.id === DEFAULT_PLATFORM_ID ? configEntries() : listEntries(platform.id));
  const added = addedRows(base.map((entry) => entry.id), page.addedModels)
    .map((entry) => ({ ...entry, row: modelRowText({ id: entry.id }) }));
  return [...base, ...added];
}

/**
 * Give a number to any saved name that has none, which happens to names saved before numbers existed. The list and the
 * counter are written back only when a number was given, so an ordinary page load writes nothing.
 */
function numberSavedNames(platform) {
  const storage = browserStorage();
  const filled = numberAddedModels(page.addedModels, readAddedCounter(storage, platform.id));
  if (!filled.changed) return;
  page.addedModels = filled.added;
  writeAddedModels(storage, platform.id, filled.added);
  writeAddedCounter(storage, platform.id, filled.lastUsed);
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
    const item = selectedItem(modelNumberText(entry), shortName(row.name));
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

/**
 * Write the description of the chosen condition under its dropdown. It runs when the page fills the menu, when a
 * saved setup is restored, and when the user picks another option. Setting .value in code does not fire a change
 * event, so those places call this function themselves.
 */
function refreshConditionNote() {
  updateConditionDescription(page.dom.conditionNote, page.dom.condition.value);
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
  putOnForm(suite);
  return true;
}

/**
 * Put the mixed suite on the form: the questions of both sets, each with its own pushback set. It is built from the
 * two fixed suites, so their data is read through the same loader and checked the same way. Returns false when a
 * newer choice was made while it loaded.
 */
async function selectMixedSuite() {
  page.suiteRequest += 1;
  const request = page.suiteRequest;
  const [easy, hard] = await Promise.all([
    page.loader.load(PUSHBACK_FOR_SET.easy, "easy"),
    page.loader.load(PUSHBACK_FOR_SET.hard, "hard"),
  ]);
  if (request !== page.suiteRequest) {
    return false;
  }
  putOnForm(buildMixedSuite(easy, hard));
  return true;
}

/** Make a suite the one on the form: its summary, its reply cache, its questions and its tiers. */
function putOnForm(suite) {
  page.suite = suite;
  page.dom.suiteSummary.textContent = suite.mixed ? MIXED_SUMMARY : suiteSummary(suite);
  // The suite menu shows the choice this suite stands for: Shuffle for the mixed suite, otherwise its fixed choice.
  page.dom.suiteSelect.value = choiceValueOfSuite(suite);
  page.cache = cacheFor(suite);
  page.questionsById = new Map(suite.questions.map((question) => [question.id, question]));
  rebuildQuestionList(suite);
  fillTierFilter(suite.questions);
}

/** Return true while the suite menu shows Shuffle. */
function shuffleOn() {
  return page.dom.suiteSelect.value === SHUFFLE_CHOICE;
}

/**
 * The suite menu was changed. Shuffle puts the mixed suite on the form, and a fixed choice puts its suite on the form.
 * A change while a run is busy is refused, and the menu goes back to the suite on the form.
 */
async function onSuiteChanged() {
  if (isRunning() || page.confirming) {
    page.dom.suiteSelect.value = choiceValueOfSuite(page.suite);
    setStatus(MIXED_BUSY_TEXT);
    return;
  }
  page.resumeRunId = null;
  page.mixed = null;
  page.dom.shuffleNote.textContent = "";
  try {
    if (shuffleOn()) {
      await selectMixedSuite();
    } else {
      await selectSuite(setsOfChoice(page.dom.suiteSelect.value));
    }
    showPageStatus("Tick what to run. Nothing runs until you press Start.");
  } catch (error) {
    showPageStatus(errorText(error));
  }
  onSelectionChanged();
}

/**
 * Pick a seed from 1 to 10 for a new run, load its order file and check it against the two question lists.
 * Throws with a plain message when the file cannot be read or does not match the questions.
 */
async function pickMixedRun() {
  const seed = pickMixedSeed();
  const file = await loadDataFile(mixedOrderPath(seed));
  const slots = applyMixedOrder(file.order, page.suite.easyQuestions, page.suite.hardQuestions);
  page.mixed = { seed, slots };
  page.dom.shuffleNote.textContent = `Seed ${seed} for this run. It is saved with the run.`;
}

/** Return the ticked question ids in the mixed order when a run has one. Otherwise they keep the list order. */
function orderedQuestionIds(ids) {
  if (page.mixed === null) {
    return ids;
  }
  const position = new Map(page.mixed.slots.map((slot, index) => [slot.question.id, index]));
  return [...ids].sort((first, second) => position.get(first) - position.get(second));
}

/** Return the mixed counts sentence for the ticked questions, ending with a full stop and a space. "" otherwise. */
function mixedCountsLine(choices) {
  if (page.suite === null || !page.suite.mixed || choices.questions.length === 0) {
    return "";
  }
  const ticked = choices.questions.map((id) => ({ questionSet: page.suite.questionSetOf(id) }));
  return `${countsSentence(mixCounts(ticked))}. `;
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

/**
 * Build the text of one picker card: the catalogue number, the short name with its note, and the facts under the name.
 * The number is always shown, so a plain name from a saved list has it too; such a card has no facts, only the name.
 */
function buildModelCard(entry) {
  const row = rowOf(entry);
  const note = entryNote(entry);
  const name = note ? `${shortName(row.name)} (${note})` : shortName(row.name);
  const number = el("span", { className: "model-rank", text: modelNumberText(entry) });
  if (hasNoDetails(row)) {
    return el("span", { className: "pick-model" }, [number, el("span", { className: "pick-model-name", text: name })]);
  }
  return el("span", { className: "pick-model", title: row.basis }, [
    number,
    el("span", { className: "pick-model-name", text: name }),
    buildModelFacts(row, rateLimitRowFor(page.rateLimits, entry.id)),
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

/** Ask for the key of the chosen platform, the same prompt a run uses. False when no platform can be chosen. */
async function keyForChosenPlatform() {
  if (page.platform === null) return false;
  return keyReadyFor(page.platform);
}

/** Return the line shown while a typed name is checked, such as "Checking org/name on Nebius...". */
function checkingTextFor(text) {
  const platform = page.platform;
  if (platform === null) return "Checking the name on the platform...";
  const parsed = parseModelReference(platform, text);
  const model = parsed.ok ? parsed.model : String(text).trim();
  return `Checking ${model} on ${platform.name}...`;
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
  const result = await checkTypedName(platform, text);
  if (!result.ok) {
    return { message: result.message, added: false, addedModels: page.addedModels };
  }
  return saveNewModel(platform, result.model, result.checked);
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
  // The new name takes the next number, and the counter remembers it, so removing the name later never frees it.
  const storage = browserStorage();
  const number = nextAddedNumber(page.addedModels, readAddedCounter(storage, platform.id));
  const next = withAddedModel(page.addedModels, model, checked, number);
  const saved = writeAddedModels(storage, platform.id, next.added) && writeAddedCounter(storage, platform.id, number);
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
 * Build the line of facts under a model's name: context, reasoning, rate limit and price. Each one has a fixed-width
 * slot, the same slot as in the heading, so the figures line up from one row to the next. The rate limit's tooltip
 * says where its numbers came from.
 */
function buildModelFacts(row, rate) {
  return el("span", { className: "model-facts" }, [
    el("span", { className: "model-context", text: row.context }),
    el("span", { className: "model-reasoning", text: row.reasoning }),
    el("span", { className: "model-rate", text: rate.text, title: rate.source }),
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

/**
 * Run one choice from the Questions dropdown. The dropdown closes first, so the one-by-one picker (a dialog of its
 * own) never opens on top of it. The other choices tick the tick boxes: the rule for each one is in
 * question-actions.js, so the tests can check it without a browser.
 */
function runQuestionAction(action) {
  page.dom.questionMenuDialog.close();
  if (action === "choose") {
    openQuestionPicker();
    return;
  }
  const ticked = idsForAction(action, page.questionRows.map((entry) => entry.question));
  setChecks(page.dom.questionList, (input) => ticked.has(input.value));
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
  return `${question.id} · ${question.tier} · ${shortQuestionText(question.question)}`;
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
    questions: orderedQuestionIds(checkedValues(dom.questionList)),
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
  if (page.mixed !== null) {
    return selectSlots(page.mixed.slots, wanted).map((slot) => slot.question);
  }
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
  // A mixed suite has no single ladder, so its pairFor gives each question its own. Fixed suites pass null.
  const { ladder, probeSpec } = page.suite;
  return planAllModels(
    choices.models, selectedQuestions(choices.questions), choices.repeats, page.cache,
    choices.condition, choices.families, ladder, probeSpec, page.data.config, page.suite.pairFor ?? null,
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
  return target === page.dom.suiteSelect;
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
  const questions = page.questionRows.filter((entry) => entry.input.checked).map((entry) => entry.question);
  page.dom.modelSelected.replaceChildren(...selectedModelItems(models));
  page.dom.questionSelected.replaceChildren(...numberedQuestionLines(questions).map(numberedQuestionItem));
}

/**
 * Build one line of the numbered question list: the number, the question id, then the short text. The text is
 * cut by numberedQuestionLines, so each question stays on one line.
 */
function numberedQuestionItem(line) {
  return el("li", { className: "selected-item" }, [
    el("span", { className: "selected-number", text: `${line.number}.` }),
    el("span", { className: "selected-lead", text: line.id }),
    el("span", { className: "selected-text", text: line.text }),
  ]);
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
  // With Shuffle on, the plan starts with the counts of the ticked questions, so the two sets are visible before Start.
  const countsLine = mixedCountsLine(choices);
  if (plan === null) {
    dom.planTotals.textContent = countsLine + PLAN_EMPTY_TEXT;
  } else {
    // Keep main's catalogue-number lookup for each plan line, and put the Shuffle counts before the totals.
    const entryById = new Map(page.modelEntries.map((entry) => [entry.id, entry]));
    dom.planModels.append(...plan.models.map((row) => planItem(row, entryById.get(row.model))));
    dom.planTotals.textContent = countsLine + totalsSentence(plan.totals, choices);
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

/**
 * Return one plan line for a model: its catalogue number, its saved replies and the most new calls it can need.
 * The entry is the model's row, which carries the number; a model with no row shows "unknown" for its number.
 */
function planItem(row, entry) {
  const saved = formatCount(row.saved);
  const newSteps = formatCount(row.atMostNew);
  const text = `${modelNumberText(entry)} ${shortName(row.model)}: ${saved} saved, at most ${newSteps} new steps`;
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
  // The suite menu follows the run lock too (see run-lock.js).
  dom.suiteSelect.disabled = suiteChoiceLocked({ busy: running || page.confirming });
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
    experiment: page.suite.mixed ? MIXED_NAME : null,
    ...mixedConfigFields(choices),
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

/**
 * Return the fields that a mixed run keeps: its seed, the full order as plain rows, and the counts of the ticked
 * questions. A resume reads these, so it never picks a new seed. A fixed run adds nothing here.
 */
function mixedConfigFields(choices) {
  if (page.mixed === null) {
    return {};
  }
  const ticked = new Set(choices.questions);
  return {
    seed: page.mixed.seed,
    order: orderRows(page.mixed.slots),
    counts: mixCounts(selectSlots(page.mixed.slots, ticked)),
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
  // A new run with Shuffle on picks its own seed. A resumed run keeps the order it saved, so nothing is picked.
  if (page.resumeRunId === null && shuffleOn()) {
    try {
      await pickMixedRun();
    } catch (error) {
      setStatus(errorText(error));
      updateControls();
      return;
    }
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
    shuffle_seed: page.mixed === null ? null : page.mixed.seed,
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
  const mixed = config.experiment === MIXED_NAME;
  if (!mixed && (!isPushbackSet(config.pushbackSet) || !isQuestionSet(config.questionSet))) {
    setStatus("This saved batch uses a set that this site does not have, so it cannot be resumed.");
    return;
  }
  // A run on a pairing the site no longer offers is refused, not guessed into another pairing.
  const retired = mixed ? "" : retiredPairText(config.pushbackSet, config.questionSet);
  if (retired !== "") {
    setStatus(`${retired} This saved batch cannot be resumed.`);
    return;
  }
  // A batch from the shuffled orders kept a seed. Its ladder or question order is not on this site any more.
  if ((config.pushbackSeed ?? null) !== null || (config.questionSeed ?? null) !== null) {
    setStatus("This saved batch used a shuffled order that this site no longer has, so it cannot be resumed.");
    return;
  }
  if (mixed) {
    if (!(await enterMixedFromRun(config))) {
      return;
    }
  } else {
    await selectSuite(fixedChoice(config.pushbackSet, config.questionSet));
  }
  const problem = restorePlanProblem(config);
  if (problem !== "") {
    setStatus(problem);
    return;
  }
  const remaining = pendingUnits(run).length;
  // Nothing is left to send, so the status is not changed. A stopped run can only move to running, not to done, and
  // leaving it stopped keeps Resume available to open the results again.
  if (remaining === 0) {
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

/**
 * Put a saved mixed run back on the form: the box on, the mixed suite, and the order the run saved. The saved order
 * is checked against the question lists, so a run whose order does not match is refused. Returns false when refused.
 */
async function enterMixedFromRun(config) {
  try {
    await selectMixedSuite();
    const slots = applyMixedOrder(config.order ?? [], page.suite.easyQuestions, page.suite.hardQuestions);
    page.mixed = { seed: config.seed, slots };
    page.dom.shuffleNote.textContent = `Seed ${config.seed} for this run, from its saved order.`;
    return true;
  } catch (error) {
    setStatus(errorText(error));
    return false;
  }
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
  refreshConditionNote();
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
  // A mixed run is graded per set by the Python tool, so this page draws no grades for it.
  if (page.suite.mixed) {
    showPageStatus(MIXED_RESULTS_TEXT);
    return;
  }
  const choices = readChoices();
  const records = recordsFor(choices);
  const gauntletRows = gauntletRowsFor(choices, records);
  const probeRows = probeRowsFor(choices, records);
  renderGauntletTables(choices.models, gauntletRows);
  const figureMeasures = resultMeasures(page.suite.levelCount);
  renderResultsFigures(document.getElementById("results-figures"), analyticsRows(choices.models, gauntletRows, figureMeasures), figureMeasures);
  drawFingerprint(choices.models, probeRows);
  setResultsMessage(choices, records);
  updateExportButtons();
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

/** Draw the fingerprint figure for the ticked models. A set with no fingerprint replies shows a message instead. */
function drawFingerprint(models, probeRows) {
  const rows = fingerprintRows(probeRows).filter((row) => models.includes(row.model));
  if (rows.length === 0 || models.length === 0) {
    page.fingerprint.clear();
    page.dom.chartMessage.textContent = NO_CHART_TEXT;
    return;
  }
  page.dom.chartMessage.textContent = "";
  page.fingerprint.render(models.map(figureModel), rows);
}

/**
 * Describe one ticked model for the figure: its id, its short name and its catalogue number as text (such as "#19").
 * The number is what a reader uses to find the model in the picker.
 */
function figureModel(model) {
  const entry = page.modelEntries.find((item) => item.id === model);
  return { id: model, name: shortName(model), numberText: modelNumberText(entry) };
}

/** Enable each export only when it has something to save. */
function updateExportButtons() {
  page.dom.exportReplies.disabled = page.newRecords.length === 0;
  page.dom.exportBatchLog.disabled = page.log === null || page.log.entries().length === 0;
}

/** Download the operation log of the batch run as JSON Lines. It has no key and no reply text. */
function exportBatchLog() {
  if (page.log === null) {
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadText(`ordeal-batch-log-${stamp}.jsonl`, page.log.toJsonl(), "application/x-ndjson");
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
    // With Shuffle on the sets are not one pair, so the preset holds none and applying it leaves the sets as they are.
    ...(shuffleOn() ? {} : choiceOfSuite(page.suite)),
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
  const notes = [];
  // With Shuffle on, a preset does not change the sets: a mixed run always uses both sets.
  if (!shuffleOn()) {
    const pushbackSet = settings.pushbackSet ?? current.pushbackSet;
    const questionSet = settings.questionSet ?? current.questionSet;
    // A preset on a pairing the site no longer offers is not applied, and the status says so.
    const retired = retiredPairText(pushbackSet, questionSet);
    if (retired === "") {
      await selectSuite(fixedChoice(pushbackSet, questionSet));
    } else {
      notes.push(`${retired} The sets were not changed.`);
    }
  }
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
    refreshConditionNote();
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
