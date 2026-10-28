// Page I, The Gauntlet: one conversation with one model, pushed through the levels of pressure in a suite.
// Saved mode replays the saved run and makes no network calls. Live mode calls the model from the
// browser with the key the user typed . Live conversations are saved step by step
// in this browser, so a reload can resume them without sending the saved steps again.

import { askForToken } from "../ui/token-dialog.js";
import { activePlatform } from "../models/platform-choice.js";
import { showToast } from "../ui/toast.js";
import { vault } from "../engine/token.js";
import { VIEW_IDS } from "../shared/view-ids.js";
import { updateConditionDescription } from "../suites/condition-text.js";
import { loadJson } from "../shared/data-cache.js";
import { createBudget, createChatClient, BudgetExhausted } from "../engine/api.js";
import * as rules from "../engine/rules.js";
import * as adaptive from "../engine/adaptive.js";
import { el } from "../ui/ui.js";
import { openPicker } from "../ui/picker-dialog.js";
import { mountModelCheck } from "../models/model-check.js";
import { checkTypedName, keyReadyFor } from "../models/typed-model-check.js";
import { createRun, saveResult, setStatus, resumeRun } from "../store/run-store.js";
import { onSaveStatus, scheduleServerSave, saveServerNow, restoreServerRuns, enforceLocalCaps } from "../web-runs/auto-save.js";
import { createPresetStore } from "../runs/presets.js";
import { modelOptionLabel, sortByRank } from "../models/model-details.js";
import {
  createSuiteLoader, suiteSummary, isSavedSuite, isPushbackSet, isQuestionSet, DEFAULT_CHOICE, SHUFFLE_CHOICE,
  choiceOfSuite, choiceValueOfSuite, fixedChoice, retiredPairText, setsOfChoice, suiteChoiceMenu,
} from "../suites/suites.js";
import { PUSHBACK_FOR_SET, buildMixedSuite } from "../suites/mixed-order.js";
import {
  createSerialQueue, gauntletPlannedSteps, gauntletStepPayload, replayGauntlet, KIND_GAUNTLET,
} from "../runs/saved-runs.js";
import {
  openPageStorage, storageText, buildPresetPanel, buildRunsList, buildResumeNotices,
  wireRunsPopup, showRunCounts, closePopupBeforeResume,
} from "../runs/persistence-ui.js";

const DATA_PATHS = {
  config: "/data/config.json",
  records: "/data/sample_run.json",
  suites: "/data/suites.json",
};
// The saved replies were recorded for repeat 1 only, so only that repeat is indexed.
const SAVED_REPEAT = 1;
// The two sources a conversation can come from: the saved replies, or live calls with the visitor's key.
const SOURCE_SAVED = "saved";
const SOURCE_LIVE = "live";
// How many words of a question show in the question menu before it is cut.
const QUESTION_WORD_LIMIT = 6;
// Longest label for a saved run, in characters.
const LABEL_LIMIT = 80;
const START_PROMPT = "Pick a model and a question, then press Start.";
// The suite summary while Shuffle is on: the question menu offers both sets, and each question runs with its own pushback set.
const SHUFFLE_SUMMARY = "Questions from both sets. Each question runs with its own pushback set.";
const NO_DATA_TEXT = "No data loaded";
const EMPTY_CONVERSATION = "The conversation appears here after you press Start.";
const SETUP_NOTE = "This level first asks the model a yes or no question.";
const PRESS_LABEL = "Press";
const PRESSED_LABEL = "Pressed";
const START_LABEL = "Start";
const CONFESSION_LABEL = "Ask which answer you really believe";
const WORKING_LABEL = "Working…";
const NO_SAVED_RUN_MESSAGE = "No saved reply for this model and question yet.";
const SAVED_CONDITION_MESSAGE = "Saved runs were recorded with no system prompt. Choose None, or use live mode.";
const SAVED_SUITE_MESSAGE = "Saved replies exist only for gauntlet_v3 with easy questions. Use live mode here.";
// Lines for the "not in the list" field under 2. Model (see addTypedModel below).
const CHECKING_TEXT = "Checking the name on the platform...";
const NO_PLATFORM_ADD_TEXT = "No platform is chosen, so no model can be added.";
const NO_KEY_TOAST = "No key was saved, so this run uses the saved reply instead.";
const LIVE_CANCELLED_TOAST = "Live mode was not started. The page stays in saved mode.";
const NO_KEY_RESUME_TOAST = "No key was saved, so the run was not resumed. It stays in the saved list.";
const SAVE_FAILED_TEXT = "This step could not be saved, so a reload would send it again.";
const RUN_FINISHED_TEXT = "Every level of this run is saved, so the run is marked done.";
const LIVE_TITLE_ID = "live-confirm-title";
const PRESET_HINT = "Presets hold the sets, the model, the system prompt and the fixed settings.";
// Footer sentence; %COUNT% is replaced with the number of questions in the suite on the desk (see selectSuite).
const FOOTER_TEXT = "The test uses %COUNT% multiple-choice questions, a model may know it is being tested, "
  + "and the invented claims are for testing only.";
// Every live call in one page session shares this cap. It counts API attempts, retries included.
const GAUNTLET_SESSION_CAP = 60;
const CAP_NOTE =
  `Live mode is capped at ${GAUNTLET_SESSION_CAP} API attempts, including retries; ` +
  "the session stops when the cap is used up.";
const CAP_REACHED_TEXT =
  `The session cap of ${GAUNTLET_SESSION_CAP} calls was reached. ` +
  "Reload the page to start a new session.";
// Display names for the system-prompt conditions listed in rules.CONDITIONS.
const CONDITION_LABELS = {
  none: "None",
  mitigation: "Mitigation",
  third_person: "Third person",
  control: "Control",
};

// Everything the page needs at any moment. The screen is redrawn from this object. It is null until
// mountGauntlet runs, so nothing is built at import.
let page = null;

/**
 * Return a fresh page state with its starting values. mountGauntlet calls this once, when the view is first shown,
 * so the budget and the queue are made then and not at import.
 */
function createPageState() {
  return {
    data: null,        // config and the saved-reply index, once loaded
    suite: null,       // the suite on the desk: its ladder, its questions, and its pushback and question sets
    loader: null,      // the suite loader, which keeps each suite once it is read
    suiteRequest: 0,   // counts the suite choices made, so a load that a newer choice overtook is not shown
    shufflePool: null, // with Shuffle on, the mixed pool whose questions the question menu offers; null otherwise
    run: null,         // the conversation on screen, or null before Start
    runId: null,       // the saved run for the live conversation on screen, or null
    runFinished: false, // true once every level of the saved run is saved
    saveProblem: false, // true when the last step could not be saved
    busy: false,       // true while a step runs
    working: null,     // which control is working: "start", "confession" or a level number
    controller: null,  // AbortController of the running step, used by Stop
    root: null,        // the Gauntlet section; every lookup is made inside it
    dom: null,         // the elements this page writes to
    levelItems: [],    // one entry per level card: { level, card, button }
    segments: [],      // the spine boxes, one per possible score
    budget: createBudget(GAUNTLET_SESSION_CAP), // API attempts left in this page session, shared by live calls
    client: null,      // the chat client for live calls, made on the first live call
    liveConfirmed: false, // true once the visitor has pressed Continue in the live confirmation
    storage: null,     // { adapter, fallback } from the run storage
    queue: createSerialQueue(), // run writes, one at a time
    presets: null,     // the preset store
    panels: {},        // the preset panel, the notices and the Saved runs list
  };
}

/**
 * Mount the Gauntlet view. The router calls this once, the first time the view is shown, with the view's section as
 * root. Every lookup is made inside root, because the three views share one document. The page then loads its data
 * in the background, so a failed file leaves Start off and shows why in the status line.
 */
export function mountGauntlet(root) {
  page = createPageState();
  page.root = root;
  page.dom = findElements(root);
  addCapNote();
  page.dom.start.addEventListener("click", startRun);
  page.dom.stop.addEventListener("click", stopStep);
  page.dom.confession.addEventListener("click", askConfession);
  page.dom.suite.addEventListener("change", onSuiteChanged);
  page.dom.condition.addEventListener("change", refreshConditionNote);
  page.dom.modelChoose.addEventListener("click", () =>
    openChoicePicker(page.dom.model, "Choose a model", "Search models", modelCard));
  mountModelCheck(page.dom.modelCheck, {
    onCheck: addTypedModel,
    keyReady: keyForChosenPlatform,
    checkingText: () => CHECKING_TEXT,
  });
  page.dom.questionChoose.addEventListener("click", () =>
    openChoicePicker(page.dom.question, "Choose a question", "Search questions", questionCard, onQuestionPicked));
  wireRunsPopup({ button: page.dom.runsButton, dialog: page.dom.runsDialog, done: page.dom.runsDone });
  renderAll();
  loadData();
}

/** Add the cap note under the Start and Stop buttons. The page has no cap field, so the note states the cap. */
function addCapNote() {
  page.dom.start.parentElement.after(el("p", { className: "field-hint", text: CAP_NOTE }));
}

/**
 * Look up one element by id, inside the view's section. The three views share one document, so a lookup on the
 * whole document could return another view's element that uses the same id.
 */
function byId(root, id) {
  return root.querySelector(`#${id}`);
}

/** Look up the elements this page writes to, by id, inside the view's section. */
function findElements(root) {
  return {
    suite: byId(root, VIEW_IDS.gauntlet["suite-select"]),
    suiteSummary: byId(root, VIEW_IDS.gauntlet["suite-summary"]),
    model: byId(root, "model-select"),
    modelChoose: byId(root, "gauntlet-model-choose"),
    modelCheck: byId(root, "gauntlet-model-check"),
    question: byId(root, "question-select"),
    questionChoose: byId(root, "gauntlet-question-choose"),
    condition: byId(root, VIEW_IDS.gauntlet["condition-select"]),
    conditionNote: byId(root, "gauntlet-condition-note"),
    start: byId(root, VIEW_IDS.gauntlet["start-button"]),
    stop: byId(root, VIEW_IDS.gauntlet["stop-button"]),
    levels: byId(root, "level-list"),
    confession: byId(root, "confession-button"),
    spine: byId(root, "spine"),
    spineMessage: byId(root, "spine-message"),
    status: byId(root, VIEW_IDS.gauntlet["status-line"]),
    saveStatus: byId(root, "gauntlet-save-status"),
    conversation: byId(root, "conversation"),
    presetHost: byId(root, VIEW_IDS.gauntlet["preset-panel"]),
    notices: byId(root, VIEW_IDS.gauntlet["resume-notices"]),
    runsList: byId(root, VIEW_IDS.gauntlet["runs-list"]),
    storageNote: byId(root, VIEW_IDS.gauntlet["storage-note"]),
    runsButton: byId(root, "gauntlet-runs-button"),
    runsDialog: byId(root, "gauntlet-runs-dialog"),
    runsDone: byId(root, "gauntlet-runs-done"),
    unfinishedCount: byId(root, "gauntlet-unfinished-count"),
    savedCount: byId(root, "gauntlet-saved-count"),
    footer: byId(root, "footer-text"),
    kpis: {
      breaking: byId(root, "gauntlet-kpi-breaking"),
      levels: byId(root, "gauntlet-kpi-levels"),
      passed: byId(root, "gauntlet-kpi-passed"),
      saved: byId(root, "gauntlet-kpi-saved"),
    },
  };
}

/**
 * Read one data file through the shared cache. A failure gets the help text this page has always shown, so the
 * visitor sees the same message whether the file is missing, unreachable or not valid JSON.
 */
async function loadPageJson(path) {
  try {
    return await loadJson(path);
  } catch {
    throw new Error(`Could not load ${path}. Check that the site is being served, then reload the page.`);
  }
}

/**
 * Load the config, the saved replies and the suites index, then the default suite. A failed file keeps Start off.
 * The index gives each suite its experiment code, and the loaded data is checked against that entry.
 */
async function loadData() {
  try {
    const [config, records, suites] = await Promise.all([
      loadPageJson(DATA_PATHS.config), loadPageJson(DATA_PATHS.records), loadPageJson(DATA_PATHS.suites),
    ]);
    page.data = { config, savedIndex: indexSavedRuns(records) };
    page.loader = createSuiteLoader(loadPageJson, suites);
    fillSuiteMenus();
    fillModelAndCondition(config);
    await chooseFixedSuite(setsOfChoice(DEFAULT_CHOICE));
    showStatus(START_PROMPT);
  } catch (error) {
    showStatus(errorText(error));
  }
  renderAll();
  if (page.data !== null) {
    await startStorage();
  }
}

/** Open the run storage, build the presets panel, the notices and the Saved runs list, then draw them. */
async function startStorage() {
  page.storage = await openPageStorage();
  page.presets = createPresetStore(page.storage.adapter);
  page.dom.storageNote.textContent = storageText(page.storage.fallback);
  page.panels.presets = buildPresetPanel({
    idPrefix: "gauntlet",
    page: "gauntlet",
    store: page.presets,
    readSettings: readPresetSettings,
    applySettings: applyPresetSettings,
    hint: PRESET_HINT,
  });
  page.dom.presetHost.replaceChildren(page.panels.presets.root);
  onSaveStatus((text) => {
    page.dom.saveStatus.textContent = text;
  });
  await restoreServerRuns(page.storage.adapter);
  const shared = {
    adapter: page.storage.adapter,
    kind: KIND_GAUNTLET,
    queue: page.queue,
    unitWord: "steps",
    // Resume is pressed inside the Runs popup, so the popup closes before the run is loaded into the desk.
    onResume: closePopupBeforeResume(page.dom.runsDialog, resumeGauntletRun),
    onChanged: onRunDeleted,
  };
  page.panels.notices = buildResumeNotices({ ...shared, activeRunId: () => page.runId });
  // The count line in the popup already says "No saved runs yet", so the list shows nothing extra when it is empty.
  page.panels.list = buildRunsList({ ...shared, emptyText: null });
  page.dom.notices.replaceChildren(page.panels.notices.root);
  page.dom.runsList.replaceChildren(page.panels.list.root);
  await refreshRuns();
}

/** Redraw the notices and the Saved runs list from storage. A storage problem leaves the lists as they were. */
async function refreshRuns() {
  if (page.panels.list === undefined) {
    return;
  }
  try {
    const unfinished = await page.panels.notices.refresh();
    const saved = await page.panels.list.refresh();
    // The counts go on the Runs button and in each popup section, so they always match what the popup lists.
    showRunCounts({
      button: page.dom.runsButton,
      unfinishedLine: page.dom.unfinishedCount,
      savedLine: page.dom.savedCount,
    }, unfinished, saved);
  } catch {
    showStatus("The saved runs could not be read. The page still works.");
  }
}

/** After a saved run is deleted, the conversation on screen is no longer saved, and both lists are drawn again. */
function onRunDeleted(runId) {
  if (runId === page.runId) {
    page.runId = null;
    page.runFinished = false;
    showStatus("The saved run for this conversation was deleted. The conversation stays on screen, unsaved.");
  }
  refreshRuns();
}

// A run is the conversation on screen. Its shape: mode (saved or live), suite, model, condition, question,
// turns (user and assistant messages), letters (one parsed answer per pressure level, null when unparseable) and
// setupReply (the reply to a level's setup turn, kept for later levels).
/** Index the saved replies of repeat 1 by model, question and step, so each lookup is one step. */
function indexSavedRuns(records) {
  const index = new Map();
  for (const record of records) {
    if (record.repeat === SAVED_REPEAT) {
      index.set(savedKey(record.model, record.question_id, record.step), record);
    }
  }
  return index;
}

/** Return the key used in the saved-reply index. */
function savedKey(model, questionId, step) {
  return `${model}|${questionId}|${step}`;
}

/** Return the last part of a model name, such as Qwen3-30B-A3B-Instruct-2507. */
function shortModelName(model) {
  return model.split("/").pop();
}

/** Return the first few words of a question, with an ellipsis when it is cut. */
function firstWords(text) {
  const words = text.split(/\s+/);
  if (words.length <= QUESTION_WORD_LIMIT) {
    return text;
  }
  return `${words.slice(0, QUESTION_WORD_LIMIT).join(" ")}…`;
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

/**
 * Fill the suite menu with its three choices, then set it to the default. A reload can keep the choice of the last
 * visit, and the page never opens on Shuffle by accident.
 */
function fillSuiteMenus() {
  fillSelect(page.dom.suite, suiteChoiceMenu());
  page.dom.suite.value = DEFAULT_CHOICE;
}

/**
 * Fill the model and system prompt menus from the config. The model menu is in rank order, most clever first,
 * with the same order as the batch page. The default model is the first one in config.models.
 */
function fillModelAndCondition(config) {
  const choices = sortByRank(modelChoices(config));
  fillSelect(page.dom.model, choices.map((entry) => ({ value: entry.id, label: modelOptionLabel(entry) })));
  if (config.models.length > 0) {
    page.dom.model.value = config.models[0];
  }
  fillSelect(
    page.dom.condition,
    rules.CONDITIONS.map((condition) => ({ value: condition, label: CONDITION_LABELS[condition] })),
  );
  refreshConditionNote();
}

/**
 * Write the description of the chosen condition under its dropdown. It runs when the menu is filled, when the user
 * picks another option, when a saved run is put back on the desk, and when a preset is applied. Setting .value in
 * code does not fire a change event, so the restore and preset code calls this function itself. The batch page
 * runs it at the same four moments.
 */
function refreshConditionNote() {
  updateConditionDescription(page.dom.conditionNote, page.dom.condition.value);
}

/** Fill the question menu from the questions the menu offers. The current choice is kept when it is still offered. */
function fillQuestionMenu(suite) {
  const kept = page.dom.question.value;
  const offered = menuQuestions(suite);
  fillSelect(
    page.dom.question,
    offered.map((question) => ({
      value: question.id,
      label: `${question.id}: ${firstWords(question.question)}`,
    })),
  );
  if (offered.some((question) => question.id === kept)) {
    page.dom.question.value = kept;
  }
}

/** Return the questions the question menu offers: the desk suite's, or both sets' questions while Shuffle is on. */
function menuQuestions(suite) {
  return page.shufflePool === null ? suite.questions : page.shufflePool.questions;
}

/** Replace the options of one select with the given value and label pairs. */
function fillSelect(select, choices) {
  const options = choices.map((choice) => el("option", { value: choice.value, text: choice.label }));
  select.replaceChildren(...options);
}

/**
 * Open the popup picker for a single-choice menu, the same popup the batch page uses. Picking a card sets the
 * menu and closes the popup. The hidden select stays the record of the choice, so the rest of the page reads it.
 * An optional onPicked runs after the pick, for a menu whose pick has effects beyond the select (the question menu
 * in Shuffle moves the desk to the question's own suite).
 */
function openChoicePicker(select, title, searchPlaceholder, renderCard, onPicked = null) {
  const items = [...select.options].map((option) => ({ value: option.value, label: option.textContent }));
  const dialog = openPicker({
    title,
    items,
    bulk: false,
    isSelected: (item) => item.value === select.value,
    onToggle: (item) => {
      select.value = item.value;
      syncChoiceButtons();
      dialog.close();
      if (onPicked !== null) {
        onPicked(item.value);
      }
    },
    renderCard,
    searchPlaceholder,
  });
}

/** Build the card of one model in the picker: its name, the same as the model menu shows it. */
function modelCard({ label }) {
  return el("span", { className: "pick-model" }, [el("span", { className: "pick-model-name", text: label })]);
}

/** Build the card of one question in the picker: its id and the first words of its text. */
function questionCard({ label }) {
  return el("span", { className: "pick-question" }, [el("span", { className: "pick-question-text", text: label })]);
}

/** Show the chosen model and question on their buttons, so each button reads like the dropdown it replaces. */
function syncChoiceButtons() {
  for (const [select, trigger] of [[page.dom.model, page.dom.modelChoose], [page.dom.question, page.dom.questionChoose]]) {
    const chosen = select.selectedOptions[0];
    trigger.textContent = chosen ? chosen.textContent : "Choose";
    trigger.disabled = select.disabled;
  }
}

/**
 * Return the platform the visitor chose now, or null when none can be read. It is read each time, as the live page
 * reads it before a request, so a platform changed in the panel is the one checked.
 */
async function chosenPlatformOrNull() {
  try {
    return await activePlatform();
  } catch {
    return null;
  }
}

/** Ask for the key of the chosen platform, the same prompt a run uses. False when no platform can be read. */
async function keyForChosenPlatform() {
  const platform = await chosenPlatformOrNull();
  return platform === null ? false : keyReadyFor(platform);
}

/**
 * The add path of the "not in the list" field. It runs the same steps as the batch page's "Add another model name"
 * (typed-model-check.js). The Gauntlet picks one model, so an accepted name becomes that model, and a run then uses it.
 */
async function addTypedModel(text) {
  const platform = await chosenPlatformOrNull();
  if (platform === null) {
    return { message: NO_PLATFORM_ADD_TEXT, added: false };
  }
  const result = await checkTypedName(platform, text);
  if (!result.ok) {
    return { message: result.message, added: false };
  }
  setModelChoice(result.model);
  return { message: result.message, added: true };
}

/**
 * Set the model menu to a name. A name the catalogue does not have is added as one more option, so the menu and its
 * button show it like any other model. It is not saved, so it lasts for this page visit.
 */
function setModelChoice(model) {
  const known = [...page.dom.model.options].some((option) => option.value === model);
  if (!known) {
    page.dom.model.append(el("option", { value: model, text: model }));
  }
  page.dom.model.value = model;
  syncChoiceButtons();
}

/**
 * Put a suite on the desk: its menus, its level cards, its spine and its footer. A different suite ends the
 * conversation on screen, because its levels and questions are not the ones it was built with. The choice is
 * { pushbackSet, questionSet }. Returns false when a newer choice was made while this one loaded, so this suite
 * is not put on the desk. The suite menu is not set here: its callers set it, because with Shuffle the menu shows
 * Shuffle while the desk shows one fixed suite.
 */
async function selectSuite(choice) {
  page.suiteRequest += 1;
  const request = page.suiteRequest;
  const suite = await page.loader.load(choice.pushbackSet, choice.questionSet);
  if (request !== page.suiteRequest) {
    return false;
  }
  if (page.suite !== null && page.suite.name !== suite.name) {
    page.run = null;
    page.runId = null;
    page.runFinished = false;
  }
  page.suite = suite;
  page.dom.suiteSummary.textContent = page.shufflePool === null ? suiteSummary(suite) : SHUFFLE_SUMMARY;
  fillQuestionMenu(suite);
  buildLevelCards();
  buildSegments();
  page.dom.footer.textContent = FOOTER_TEXT.replace("%COUNT%", String(menuQuestions(suite).length));
  return true;
}

/**
 * Put a fixed suite on the desk and show that choice in the suite menu. This leaves Shuffle, so the question menu
 * goes back to the questions of this one suite. Returns the same as selectSuite.
 */
async function chooseFixedSuite(choice) {
  page.shufflePool = null;
  const loaded = await selectSuite(choice);
  if (loaded) {
    page.dom.suite.value = choiceValueOfSuite(page.suite);
  }
  return loaded;
}

/**
 * The suite menu was changed. A fixed choice puts its suite on the desk. Shuffle keeps the desk as it is and offers
 * the questions of both sets. Not allowed while a step runs, because the menu is off then.
 */
async function onSuiteChanged() {
  const value = page.dom.suite.value;
  try {
    if (value === SHUFFLE_CHOICE) {
      await enterShuffle();
    } else if (await chooseFixedSuite(setsOfChoice(value))) {
      showStatus(START_PROMPT);
    }
  } catch (error) {
    showStatus(errorText(error));
  }
  renderAll();
}

/**
 * Show Shuffle: the question menu offers the questions of both sets, each run with its own pushback set. The desk
 * keeps its suite until a question of the other set is picked (see onQuestionPicked), so the levels match the question.
 */
async function enterShuffle() {
  page.suiteRequest += 1;
  const request = page.suiteRequest;
  const [easy, hard] = await Promise.all([
    page.loader.load(PUSHBACK_FOR_SET.easy, "easy"),
    page.loader.load(PUSHBACK_FOR_SET.hard, "hard"),
  ]);
  if (request !== page.suiteRequest) {
    return;
  }
  page.shufflePool = buildMixedSuite(easy, hard);
  page.dom.suiteSummary.textContent = SHUFFLE_SUMMARY;
  fillQuestionMenu(page.suite);
  page.dom.footer.textContent = FOOTER_TEXT.replace("%COUNT%", String(menuQuestions(page.suite).length));
  showStatus(START_PROMPT);
}

/**
 * A question was picked while Shuffle is on. A question of the other set moves the desk to its own fixed suite, so
 * the question runs with its own pushback set. The question menu is locked during a step, so this never moves the
 * desk mid-run.
 */
async function onQuestionPicked(questionId) {
  if (page.shufflePool === null) {
    return;
  }
  const questionSet = page.shufflePool.questionSetOf(questionId);
  if (questionSet === page.suite.questionSet) {
    return;
  }
  try {
    await selectSuite(fixedChoice(PUSHBACK_FOR_SET[questionSet], questionSet));
  } catch (error) {
    showStatus(errorText(error));
  }
  renderAll();
}

/** Create the boxes of the spine: one for each possible score, from 1 to the held-firm score. */
function buildSegments() {
  page.segments = [];
  page.dom.spine.replaceChildren();
  for (let number = 1; number <= page.suite.heldFirmScore; number += 1) {
    const box = el("div", { className: "spine-segment", text: String(number), "aria-hidden": "true" });
    page.segments.push(box);
    page.dom.spine.append(box);
  }
}

/** Create one card per ladder level of the suite on the desk, in order. Each card is set by updateControls. */
function buildLevelCards() {
  page.levelItems = [];
  page.dom.levels.replaceChildren();
  for (const entry of page.suite.ladder.levels) {
    const item = buildLevelCard(entry);
    page.levelItems.push(item);
    page.dom.levels.append(item.card);
  }
}

/** Create the card for one ladder level: its number, type, what it tests, and a Press button. */
function buildLevelCard(entry) {
  const button = el("button", { type: "button", className: "btn level-button", text: PRESS_LABEL });
  button.addEventListener("click", () => pressLevel(entry.level));
  const note = entry.setup_turn ? el("p", { className: "level-note", text: SETUP_NOTE }) : null;
  const card = el("li", { className: "level-card" }, [
    el("p", { className: "label level-number", text: `Level ${entry.level}` }),
    el("h3", { className: "level-type", text: entry.type }),
    note,
    el("p", { className: "level-tests", text: entry.tests }),
    el("div", { className: "level-action" }, [el("span", { className: "level-tick", "aria-hidden": "true" }), button]),
  ]);
  return { level: entry.level, type: entry.type, card, button };
}

/** Redraw everything that depends on the run: the meter, the conversation and the controls. */
function renderAll() {
  syncChoiceButtons();
  renderSpine();
  renderConversation();
  updateControls();
  renderKpis();
}

/** Fill the four KPI cards from the suite, the run on screen and the saved replies; no data shows the placeholder. */
function renderKpis() {
  const kpis = page.dom.kpis;
  const suite = page.suite;
  const letters = page.run ? page.run.letters : [];
  const flipped = suite === null ? null : flippedLevel(letters, page.run ? page.run.question.correct : null);
  setKpi(kpis.breaking, suite === null ? null : breakingValue(flipped, letters.length));
  setKpi(kpis.levels, suite === null ? null : String(suite.levelCount));
  setKpi(kpis.passed, suite === null ? null : `${letters.length} of ${suite.levelCount}`);
  setKpi(kpis.saved, page.data === null ? null : String(page.data.savedIndex.size));
}

/** Return the short Breaking Point value for a KPI: the level it gave in at, held firm, or none yet. */
function breakingValue(flipped, count) {
  if (flipped !== null) {
    return `Level ${flipped}`;
  }
  if (count === 0) {
    return "None yet";
  }
  return count === page.suite.levelCount ? "Held firm" : "Held so far";
}

/** Set one KPI card's value as text, or mark it empty with the placeholder when the value is null. */
function setKpi(card, value) {
  const empty = value === null;
  card.classList.toggle("is-empty", empty);
  card.querySelector(".kpi-value").textContent = empty ? NO_DATA_TEXT : value;
}

/** Colour the spine boxes and write the result line from the answers given so far. */
function renderSpine() {
  if (page.suite === null) {
    return;
  }
  const letters = page.run ? page.run.letters : [];
  const correct = page.run ? page.run.question.correct : null;
  const flipped = flippedLevel(letters, correct);
  const count = letters.length;
  page.segments.forEach((box, index) => {
    const state = segmentState(index + 1, flipped, count);
    box.className = state ? `spine-segment ${state}` : "spine-segment";
  });
  const result = meterResult(flipped, count);
  page.dom.spineMessage.textContent = result.text;
  page.dom.spineMessage.className = result.tone ? `spine-message ${result.tone}` : "spine-message";
  page.dom.spine.setAttribute("aria-label", `Breaking Point: ${result.text}`);
}

/** Return the level of the first wrong answer, or null when the model has held firm so far. */
function flippedLevel(letters, correct) {
  // spineScore returns the held-firm score when no level answer was wrong; any other score is the flip level.
  const held = page.suite.heldFirmScore;
  const score = rules.spineScore(letters, correct, held);
  return score === held ? null : score;
}

/** Return the class for one box: flip, held, passed, or an empty string for an empty box. */
function segmentState(segment, flipped, count) {
  // The last box (the held-firm score) lights up only when every level has been passed with no flip.
  const held = page.suite.heldFirmScore;
  if (segment === flipped) {
    return "is-flip";
  }
  if (segment === held) {
    return flipped === null && count === page.suite.levelCount ? "is-held" : "";
  }
  return segment <= count ? "is-passed" : "";
}

/** Return the result line under the meter in plain words, with the tone class that colours it. */
function meterResult(flipped, count) {
  const levelCount = page.suite.levelCount;
  if (flipped !== null) {
    return { text: `Gave in at level ${flipped}`, tone: "is-flip" };
  }
  if (count === levelCount) {
    return { text: `Held firm through all ${levelCount} levels`, tone: "is-held" };
  }
  if (count === 0) {
    return { text: "No pressure yet", tone: "" };
  }
  return { text: `Held firm so far: ${count} of ${levelCount} levels passed`, tone: "" };
}

/** Redraw the conversation: a note for any system prompt, then one margin note per turn. */
function renderConversation() {
  const region = page.dom.conversation;
  const run = page.run;
  region.replaceChildren();
  if (run === null) {
    region.append(el("p", { className: "empty-note", text: EMPTY_CONVERSATION }));
    return;
  }
  if (run.condition !== rules.NO_SYSTEM_PROMPT) {
    region.append(el("p", { className: "condition-note label", text: `Under a system prompt: ${run.condition}` }));
  }
  // Only the newest turn is a live region, so a screen reader announces each new turn once.
  const newest = run.turns.length - 1;
  run.turns.forEach((turn, index) => region.append(buildTurn(turn, run.model, index === newest)));
  region.scrollTop = region.scrollHeight;
}

/** Build one margin note: a small-caps speaker label, a flip chip when it applies, then the text. */
function buildTurn(turn, model, isNewest) {
  const isYou = turn.role === "user";
  const label = el("p", { className: "margin-note-speaker", text: isYou ? "You" : shortModelName(model) });
  if (turn.flipped) {
    label.append(el("span", { className: "chip chip-flip", text: "Flipped" }));
  }
  const body = el("div", { className: "margin-note-text" }, textLines(turn.text));
  const classes = ["margin-note", isYou ? "turn-you" : "turn-model"];
  if (isNewest) {
    classes.push("turn-new");
  }
  return el("article", { className: classes.join(" "), "aria-live": isNewest ? "polite" : null }, [label, body]);
}

/** Return the text as nodes: plain text for each line, with a line break element between lines. */
function textLines(text) {
  const nodes = [];
  text.split("\n").forEach((line, index) => {
    if (index > 0) {
      nodes.push(el("br"));
    }
    nodes.push(document.createTextNode(line));
  });
  return nodes;
}

/** Enable or disable every control for the current state: busy, no run yet, or the level order. */
function updateControls() {
  const dom = page.dom;
  const hasRun = page.run !== null;
  const done = hasRun ? page.run.letters.length : 0;
  dom.start.disabled = page.busy || page.data === null || page.suite === null;
  dom.start.textContent = labelWhileWorking("start", START_LABEL);
  dom.stop.hidden = !page.busy;
  dom.confession.disabled = page.busy || !hasRun;
  dom.confession.textContent = labelWhileWorking("confession", CONFESSION_LABEL);
  dom.suite.disabled = page.busy;
  // The question menu is locked too, so a question of the other set cannot move the desk while a step runs.
  dom.question.disabled = page.busy;
  dom.questionChoose.disabled = page.busy;
  if (page.panels.presets) {
    page.panels.presets.setBusy(page.busy);
  }
  for (const item of page.levelItems) {
    updateLevelItem(item, done, hasRun);
  }
}

/** Return the working label while this control runs, or the normal label otherwise. */
function labelWhileWorking(name, idleLabel) {
  return page.busy && page.working === name ? WORKING_LABEL : idleLabel;
}

/** Set one level card to done, next or waiting, and set its button label and enabled state. */
function updateLevelItem(item, done, hasRun) {
  // Levels are pressed in order: levels up to done are finished, only done + 1 can be pressed, the rest wait.
  const isDone = item.level <= done;
  const isNext = hasRun && item.level === done + 1;
  item.card.classList.toggle("is-done", isDone);
  item.card.classList.toggle("is-next", isNext);
  item.card.classList.toggle("is-waiting", !isDone && !isNext);
  const working = page.busy && page.working === item.level;
  const label = working ? WORKING_LABEL : levelLabel(isDone);
  item.button.textContent = label;
  item.button.setAttribute("aria-label", `${label}: level ${item.level}, ${item.type}`);
  item.button.disabled = page.busy || !isNext;
}

/** Return the button label for a level that is done or not yet done. */
function levelLabel(isDone) {
  return isDone ? PRESSED_LABEL : PRESS_LABEL;
}

/** Show the one-line status for the last action, as text. */
function showStatus(text) {
  page.dom.status.textContent = text;
}

/** Return the message to show for an error. Only plain messages are shown, never the key. */
function errorText(error) {
  if (error instanceof BudgetExhausted) {
    return CAP_REACHED_TEXT;
  }
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

/** Return true once the session cap is used up, so no more live calls may be sent. */
function budgetUsedUp() {
  return page.budget.remaining() <= 0;
}

/** Return true when a run in this mode may not send a call because the session cap is used up. */
function liveCallsStopped(mode) {
  return mode === SOURCE_LIVE && budgetUsedUp();
}

/** Add the cap line after a status when the cap is used up, so the visitor sees why calls stopped. */
function withCapNote(status) {
  return budgetUsedUp() ? `${status} ${CAP_REACHED_TEXT}` : status;
}

/** Return the answer note in plain words: no letter, a right letter, or a wrong letter with the correct one. */
function answerNote(letter, correct) {
  if (letter === null) {
    return "The reply had no 'Answer: X' line.";
  }
  if (letter === correct) {
    return `The model answered ${letter}, which is correct.`;
  }
  return `The model answered ${letter}, which is wrong. The correct answer is ${correct}.`;
}

/** Return true when a parsed letter is a wrong answer. A missing letter is not counted as wrong. */
function isWrongAnswer(letter, correct) {
  return letter !== null && letter !== correct;
}

/** Return the message for a press out of order, or null when the level is the next one. */
function ladderOrderError(levelsDone, requested) {
  const levelCount = page.suite.levelCount;
  const next = levelsDone + 1;
  if (next > levelCount) {
    return `All ${levelCount} levels are done. Press Start to begin again.`;
  }
  if (requested > next) {
    return `Press Level ${next} first.`;
  }
  if (requested < next) {
    return `Level ${requested} is already done. Press Level ${next} next.`;
  }
  return null;
}

/** Return the error text for a step that has no saved reply. */
function missingSavedMessage(step) {
  if (step === rules.BASELINE_STEP) {
    return NO_SAVED_RUN_MESSAGE;
  }
  return `No saved reply for ${step.replace("_", " ")} yet.`;
}

/** Return the saved record for one step of this run. Throws a plain message when there is none. */
function findSavedRecord(run, step) {
  if (run.condition !== rules.NO_SYSTEM_PROMPT) {
    throw new Error(SAVED_CONDITION_MESSAGE);
  }
  if (!isSavedSuite(run.suite)) {
    throw new Error(SAVED_SUITE_MESSAGE);
  }
  const record = page.data.savedIndex.get(savedKey(run.model, run.question.id, step));
  if (record === undefined) {
    throw new Error(missingSavedMessage(step));
  }
  return record;
}

/** Return the system message for the run's condition, as a list with zero or one item. */
function systemMessages(run) {
  const text = rules.systemPromptFor(run.condition, page.data.config);
  return text === null ? [] : [{ role: "system", content: text }];
}

/** Return the conversation so far in the shape the chat API expects. */
function conversationMessages(run) {
  return run.turns.map((turn) => ({ role: turn.role, content: turn.text }));
}

/** Return the chat client for this page session. It is made once, so every live call shares one cap. */
// The client is stored as a promise, so two calls that start together share one client and one cap.
async function liveClient() {
  if (page.client === null) {
    page.client = activePlatform().then((platform) => createChatClient({ platform, vault, budget: page.budget }));
  }
  return page.client;
}

/** Send one chat request from the browser, with the key in the vault. Only live mode calls this. */
async function callModel(run, messages, signal) {
  const { config } = page.data;
  return (await liveClient()).complete({
    model: run.model,
    messages,
    temperature: config.temperature,
    maxTokens: config.max_tokens,
    signal,
  });
}

/**
 * Return the user text and the model reply for one step. Saved mode reads the saved record and makes
 * no call. Live mode builds the text with makeText and sends it with the conversation so far.
 */
async function exchange(run, step, makeText, signal) {
  // makeText is only called in live mode, so saved mode never builds text it will not send.
  if (run.mode === SOURCE_SAVED) {
    const record = findSavedRecord(run, step);
    return { userText: record.user_text, reply: record.reply };
  }
  // The model sees the system prompt (if the condition has one), then the conversation so far, then the new user turn.
  const userText = makeText();
  const messages = [...systemMessages(run), ...conversationMessages(run), { role: "user", content: userText }];
  const reply = await callModel(run, messages, signal);
  return { userText, reply };
}

/** Return the run with one user turn and one model turn added. flipped marks a wrong level answer. */
function addTurns(run, userText, reply, flipped) {
  const turns = [
    ...run.turns,
    { role: "user", text: userText, flipped: false },
    { role: "assistant", text: reply, flipped },
  ];
  return { ...run, turns };
}

/** Return the content of the last model turn, or null when there is none yet. */
function lastModelReply(run) {
  for (let index = run.turns.length - 1; index >= 0; index -= 1) {
    if (run.turns[index].role === "assistant") {
      return run.turns[index].text;
    }
  }
  return null;
}

/** Return the ladder entry for one level number of the run's suite. */
function ladderEntry(run, level) {
  return run.suite.ladder.levels.find((entry) => entry.level === level);
}

/** Return a new conversation for a press of Start. Nothing is sent or shown until the baseline is in. */
function newRun(choice, mode) {
  return {
    mode,
    suite: page.suite,
    model: choice.model,
    condition: choice.condition,
    question: choice.question,
    turns: [],
    letters: [],
    setupReply: null,
  };
}

/** Return the text of one pressure level in live mode, with the answer-format reminder at the end. */
function levelText(entry, previousReply, run) {
  const { config } = page.data;
  const message = adaptive.gauntletMessage(entry, run.suite.ladder, run.question, previousReply, run.setupReply);
  return rules.addFormatReminder(message, config.answer_format_reminder);
}

/** Return the config a saved gauntlet run keeps, so a resume can put the desk back the same way. No key is kept. */
function gauntletConfig(run) {
  const { config } = page.data;
  return {
    kind: KIND_GAUNTLET,
    ...choiceOfSuite(run.suite),
    model: run.model,
    questionId: run.question.id,
    condition: run.condition,
    temperature: config.temperature,
    maxTokens: config.max_tokens,
  };
}

/** Return a short label for a saved gauntlet run: the model, the question and the suite, within 80 characters. */
function gauntletLabel(run) {
  return `Gauntlet ${shortModelName(run.model)} · ${run.question.id} · ${run.suite.name}`.slice(0, LABEL_LIMIT);
}

/**
 * Save one finished step of a live conversation. The first saved step creates the run. Errors are not thrown:
 * the step still counts on screen, and the status says it was not saved. A finished run keeps nothing more.
 */
async function persistStep(run, payload) {
  if (run.mode !== SOURCE_LIVE || page.runFinished || page.storage === null) {
    return;
  }
  const { adapter } = page.storage;
  try {
    await page.queue.run(async () => {
      // The saved run is created lazily, on the first step that is saved, so a conversation that never gets a
      // reply leaves nothing in storage.
      if (page.runId === null) {
        const created = await createRun(adapter, {
          label: gauntletLabel(run),
          config: gauntletConfig(run),
          plannedUnits: gauntletPlannedSteps(run.suite),
        });
        await setStatus(adapter, created.id, "running");
        page.runId = created.id;
        // Only the newest gauntlet copies are kept in this browser, so the oldest go once a new one starts.
        await enforceLocalCaps(adapter, created.id);
      }
      await saveResult(adapter, page.runId, payload.step, gauntletStepPayload(payload));
      scheduleServerSave(adapter, page.runId);
      // Saving the last pressure level marks the saved run done and stops further saves (page.runFinished).
      if (payload.step === `level_${run.suite.levelCount}`) {
        await setStatus(adapter, page.runId, "done");
        page.runFinished = true;
        await saveServerNow(adapter, page.runId);
      }
    });
  } catch {
    page.saveProblem = true;
  }
}

/** Return the run after the yes-or-no setup turn that level 4 (or 5) needs. The reply is kept for later levels. */
async function addSetupTurn(run, entry, signal) {
  const step = rules.setupStep(entry.level);
  const result = await exchange(run, step, () => adaptive.setupText(entry, run.question), signal);
  await persistStep(run, { step, userText: result.userText, reply: result.reply, letter: null, flipped: false });
  return { ...addTurns(run, result.userText, result.reply, false), setupReply: result.reply };
}

/** Return the new run and status after the baseline question. This is the first turn of the conversation. */
async function startWork(run, signal) {
  const result = await exchange(run, rules.BASELINE_STEP, () => rules.formatQuestion(run.question), signal);
  const letter = rules.parseAnswer(result.reply);
  const payload = { step: rules.BASELINE_STEP, userText: result.userText, reply: result.reply, letter, flipped: false };
  await persistStep(run, payload);
  return {
    run: addTurns(run, result.userText, result.reply, false),
    status: answerNote(letter, run.question.correct),
  };
}

/** Return the new run and status after one pressure level, with its setup turn first when it needs one. */
async function advanceLevel(run, level, signal) {
  const entry = ladderEntry(run, level);
  const previousReply = lastModelReply(run);
  // previousReply is taken before the setup turn is added, so the level text refers to the earlier answer.
  const ready = entry.setup_turn ? await addSetupTurn(run, entry, signal) : run;
  const makeText = () => levelText(entry, previousReply, ready);
  const step = run.suite.pushbackSteps[level - 1];
  const result = await exchange(ready, step, makeText, signal);
  const letter = rules.parseAnswer(result.reply);
  const flipped = isWrongAnswer(letter, run.question.correct);
  await persistStep(ready, { step, userText: result.userText, reply: result.reply, letter, flipped });
  const next = { ...addTurns(ready, result.userText, result.reply, flipped), letters: [...ready.letters, letter] };
  return {
    run: next,
    status: `Level ${level} (${entry.type}): ${answerNote(letter, run.question.correct)}`,
  };
}

/** Return the new run and status after the confession question. The meter does not move. */
async function confessionWork(run, signal) {
  const { config } = page.data;
  const { ladder } = run.suite;
  const makeText = () => rules.addFormatReminder(ladder.confession_probe.message, config.answer_format_reminder);
  const result = await exchange(run, rules.CONFESSION_STEP, makeText, signal);
  const letter = rules.parseAnswer(result.reply);
  await persistStep(run, {
    step: rules.CONFESSION_STEP, userText: result.userText, reply: result.reply, letter, flipped: false,
  });
  return {
    run: addTurns(run, result.userText, result.reply, false),
    status: `Asked which answer it believes: ${answerNote(letter, run.question.correct)}`,
  };
}

/**
 * Run one step with the busy state on: controls are disabled, Stop is shown, and the result or the
 * error is shown in the status line. Returns true when the step succeeded.
 */
async function runStep(working, work) {
  // On failure (including Stop) page.run is left unchanged, so the conversation stays as it was.
  page.busy = true;
  page.working = working;
  page.controller = new AbortController();
  page.saveProblem = false;
  updateControls();
  let succeeded = false;
  try {
    const result = await work(page.controller.signal);
    page.run = result.run;
    showStatus(withSaveNote(withCapNote(result.status)));
    succeeded = true;
  } catch (error) {
    showStatus(errorText(error));
  }
  page.busy = false;
  page.working = null;
  page.controller = null;
  if (succeeded) {
    renderAll();
  } else {
    updateControls();
  }
  return succeeded;
}

/** Add the note that a step was not saved, when that happened during the last step. */
function withSaveNote(status) {
  return page.saveProblem ? `${status} ${SAVE_FAILED_TEXT}` : status;
}

/** Read the model, question and system prompt from the desk. */
function readDesk() {
  const dom = page.dom;
  const questionId = dom.question.value;
  return {
    model: dom.model.value,
    question: page.suite.questions.find((question) => question.id === questionId),
    condition: dom.condition.value,
  };
}

/** Return the source checked in the Source control: "saved" or "live". */
function selectedSource() {
  const checked = page.root.querySelector('input[name="source"]:checked');
  return checked ? checked.value : SOURCE_SAVED;
}

/** Ask the visitor to confirm live mode before the first live call. Resolves true only on Continue. */
function askToContinueLive() {
  return new Promise((resolve) => {
    const cancelButton = el("button", { type: "button", className: "btn", text: "Cancel" });
    const continueButton = el("button", { type: "button", className: "btn btn-primary", text: "Continue" });
    const dialog = el("dialog", { className: "token-dialog", "aria-labelledby": LIVE_TITLE_ID }, [
      el("h2", { className: "dialog-title", id: LIVE_TITLE_ID, text: "Before the first live call" }),
      el("p", { text: liveConfirmText() }),
      el("div", { className: "dialog-actions" }, [cancelButton, continueButton]),
    ]);
    cancelButton.addEventListener("click", () => dialog.close("cancel"));
    continueButton.addEventListener("click", () => dialog.close("continue"));
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(dialog.returnValue === "continue");
    });
    document.body.append(dialog);
    dialog.showModal();
    continueButton.focus();
  });
}

/** Return the text of the live confirmation: the suite on the desk, the key use and the cap. */
function liveConfirmText() {
  return "Live mode sends your own API key with each press. Each press sends one or more calls. "
    + `Suite: ${page.suite.name}. `
    + `The cap for this session is ${GAUNTLET_SESSION_CAP} calls. Continue?`;
}

/** Return true when live calls may start. The confirmation is asked once per page session, not per press. */
async function confirmLiveCalls() {
  if (page.liveConfirmed) {
    return true;
  }
  page.liveConfirmed = await askToContinueLive();
  return page.liveConfirmed;
}

/** Check the source chosen for this Start. Live mode asks for a key, then the one-time confirmation. */
async function resolveSource(source) {
  if (source !== SOURCE_LIVE) {
    return SOURCE_SAVED;
  }
  if (vault.has() || (await askForToken({ vault }))) {
    if (await confirmLiveCalls()) {
      return SOURCE_LIVE;
    }
    showToast(LIVE_CANCELLED_TOAST, { tone: "info" });
  } else {
    showToast(NO_KEY_TOAST, { tone: "warn" });
  }
  selectSource(SOURCE_SAVED);
  return SOURCE_SAVED;
}

/** Check the Source radio button with the given value. */
function selectSource(value) {
  const radio = page.root.querySelector(`input[name="source"][value="${value}"]`);
  if (radio !== null) {
    radio.checked = true;
  }
}

/** Press Start: choose the source, then get the baseline answer and show it as the first turn. */
async function startRun() {
  if (page.busy || page.data === null || page.suite === null) {
    return;
  }
  if (liveCallsStopped(selectedSource())) {
    showStatus(CAP_REACHED_TEXT);
    return;
  }
  // Read the desk before the key and confirmation dialogs, so the run uses the choices made at the moment of Start.
  const choice = readDesk();
  const source = await resolveSource(selectedSource());
  const run = newRun(choice, source);
  page.runId = null;
  page.runFinished = false;
  const ok = await runStep("start", (signal) => startWork(run, signal));
  if (ok) {
    focusNextLevel();
  }
  await refreshRuns();
}

/** Press a level button: check the order, then send or replay that level. */
async function pressLevel(level) {
  if (page.busy || page.run === null) {
    return;
  }
  const problem = ladderOrderError(page.run.letters.length, level);
  if (problem !== null) {
    showStatus(problem);
    return;
  }
  if (liveCallsStopped(page.run.mode)) {
    showStatus(CAP_REACHED_TEXT);
    return;
  }
  const ok = await runStep(level, (signal) => advanceLevel(page.run, level, signal));
  if (ok) {
    focusNextLevel();
  }
  await refreshRuns();
}

/** Press the confession button: ask which answer the model really believes. */
async function askConfession() {
  if (page.busy || page.run === null) {
    return;
  }
  if (liveCallsStopped(page.run.mode)) {
    showStatus(CAP_REACHED_TEXT);
    return;
  }
  const ok = await runStep("confession", (signal) => confessionWork(page.run, signal));
  if (ok) {
    page.dom.confession.focus();
  }
}

/** Stop the running live call. The step is dropped and the conversation stays as it was. */
function stopStep() {
  if (page.controller !== null) {
    page.controller.abort();
  }
}

/** Move keyboard focus to the Press button of the next level, or to the confession button after the last. */
function focusNextLevel() {
  const next = page.levelItems.find((item) => !item.button.disabled);
  if (next !== undefined) {
    next.button.focus();
  } else {
    page.dom.confession.focus();
  }
}

/** Return the desk choices of a saved run, checked against this site. A string names the problem; "" means fine. */
function restorableProblem(config) {
  if (config === null || typeof config !== "object" || config.kind !== KIND_GAUNTLET) {
    return "This saved run cannot be resumed on this page.";
  }
  if (!isPushbackSet(config.pushbackSet) || !isQuestionSet(config.questionSet)) {
    return "This saved run uses a set that this site does not have, so it cannot be resumed.";
  }
  // A run on a pairing the site no longer offers is refused, not guessed into another pairing.
  const retired = retiredPairText(config.pushbackSet, config.questionSet);
  if (retired !== "") {
    return `${retired} This saved run cannot be resumed.`;
  }
  // A run from the shuffled orders kept a seed. Its ladder or question order is not on this site any more.
  if ((config.pushbackSeed ?? null) !== null || (config.questionSeed ?? null) !== null) {
    return "This saved run used a shuffled order that this site no longer has, so it cannot be resumed.";
  }
  return resumeModelProblem(config.model, menuModelValues());
}

/**
 * Return true when the desk's model menu has an option with this id. The menu holds the catalogue and any name the
 * visitor added with "Add a model that is not in the list" this visit. Resume and presets check the menu rather than the
 * catalogue, so a model the visitor added is treated the same as a catalogue model.
 */
export function modelOnDesk(model, menuValues) {
  return menuValues.includes(model);
}

/**
 * Return "" when a saved run's model can be put back on the desk, or the plain line that says how to go on when it
 * cannot. The line names the way out, so the visitor is not left with a refusal and no next step.
 */
export function resumeModelProblem(model, menuValues) {
  if (modelOnDesk(model, menuValues)) {
    return "";
  }
  return `The model ${model} is not in the list. Add the model with Add a model that is not in the list, `
    + "then press Resume again.";
}

/** Return the values of the desk's model menu: the catalogue models and any names the visitor added this visit. */
function menuModelValues() {
  return [...page.dom.model.options].map((option) => option.value);
}

/** Put a saved run's suite, model, question and system prompt back on the desk. Returns a problem text or "". */
async function restoreDesk(config) {
  const problem = restorableProblem(config);
  if (problem !== "") {
    return problem;
  }
  await chooseFixedSuite(fixedChoice(config.pushbackSet, config.questionSet));
  if (!page.suite.questions.some((question) => question.id === config.questionId)) {
    return `The question ${config.questionId} is not in ${page.suite.name}, so this run cannot be resumed.`;
  }
  page.dom.model.value = config.model;
  page.dom.question.value = config.questionId;
  page.dom.condition.value = config.condition;
  refreshConditionNote();
  return "";
}

/**
 * Resume a saved live conversation from the notices or the list. The desk is set back, the replies are replayed
 * from storage without a call, and the next level is ready to press. A key and the live confirmation are asked first.
 */
async function resumeGauntletRun(run) {
  if (page.busy || page.data === null || page.storage === null || run === null) {
    return;
  }
  const problem = await restoreDesk(run.config);
  if (problem !== "") {
    showStatus(problem);
    return;
  }
  // replayGauntlet rebuilds the turns and letters from the saved steps; a null nextLevel means all levels are saved.
  const replay = replayGauntlet(run);
  // Every level is saved, so nothing is sent. The status is left as it was: a stopped run can only move to running.
  if (replay.nextLevel === null) {
    showStatus(RUN_FINISHED_TEXT);
    await refreshRuns();
    return;
  }
  if (!(await readyForLiveResume())) {
    return;
  }
  await page.queue.run(() => resumeRun(page.storage.adapter, run.id));
  selectSource(SOURCE_LIVE);
  page.run = {
    mode: SOURCE_LIVE,
    suite: page.suite,
    model: run.config.model,
    condition: run.config.condition,
    question: page.suite.questions.find((question) => question.id === run.config.questionId),
    turns: replay.turns,
    letters: replay.letters,
    setupReply: replay.setupReply,
  };
  page.runId = run.id;
  page.runFinished = false;
  renderAll();
  showStatus(`Resumed at level ${replay.nextLevel}. Saved steps were not sent again.`);
  focusNextLevel();
  await refreshRuns();
}

/** Ask for the key and the live confirmation before a resume. Returns true when both are given. */
async function readyForLiveResume() {
  if (!vault.has() && !(await askForToken({ vault }))) {
    showToast(NO_KEY_RESUME_TOAST, { tone: "warn" });
    return false;
  }
  if (!(await confirmLiveCalls())) {
    showToast(LIVE_CANCELLED_TOAST, { tone: "info" });
    return false;
  }
  return true;
}

/** Return the desk as a preset holds it: both sets, the model, the system prompt and the fixed settings. */
function readPresetSettings() {
  const { config } = page.data;
  return {
    ...choiceOfSuite(page.suite),
    model: page.dom.model.value,
    condition: page.dom.condition.value,
    temperature: config.temperature,
    maxTokens: config.max_tokens,
  };
}

/** Set the desk from a preset. Returns the sentences to add to the status: what was not applied, and why. */
async function applyPresetSettings(settings) {
  const current = choiceOfSuite(page.suite);
  const pushbackSet = settings.pushbackSet ?? current.pushbackSet;
  const questionSet = settings.questionSet ?? current.questionSet;
  const notes = [];
  // A preset on a pairing the site no longer offers is not applied, and the status says so.
  const retired = retiredPairText(pushbackSet, questionSet);
  if (retired === "") {
    await chooseFixedSuite(fixedChoice(pushbackSet, questionSet));
  } else {
    notes.push(`${retired} The sets were not changed.`);
  }
  if (settings.model !== undefined) {
    if (modelOnDesk(settings.model, menuModelValues())) {
      page.dom.model.value = settings.model;
    } else {
      notes.push(`The model ${settings.model} is not in the list.`);
    }
  }
  if (settings.condition !== undefined) {
    page.dom.condition.value = settings.condition;
    refreshConditionNote();
  }
  notes.push(fixedSettingsNote(settings));
  renderAll();
  return notes.filter((note) => note !== "").join(" ");
}

/** Return a note when a preset's temperature or max tokens differ from config.json. Those two are never changed. */
function fixedSettingsNote(settings) {
  const { config } = page.data;
  const temperature = settings.temperature ?? config.temperature;
  const maxTokens = settings.maxTokens ?? config.max_tokens;
  if (temperature === config.temperature && maxTokens === config.max_tokens) {
    return "";
  }
  return `This preset was saved with temperature ${temperature} and max tokens ${maxTokens}. `
    + `config.json sets ${config.temperature} and ${config.max_tokens}, so those two were not changed.`;
}
