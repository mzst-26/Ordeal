// Named presets for the Gauntlet and Batch pages (decision D5). A preset is a set of choices and never holds a key:
// a key-looking field is refused, and any field the page does not use is dropped.
// Presets are kept in the store that holds the saved runs. The run store opens only its "runs" object store, so
// each preset has an id that starts with PRESET_PREFIX, and the runs list skips those documents.
// This file does no DOM work and sends no request.

import { RUNS_STORE, assertNoSecrets } from "./store/run-store.js";
import { CONDITIONS } from "./engine/rules.js";
import { isPushbackSet, isQuestionSet } from "./suites.js";

export const PRESET_PREFIX = "preset:";
const PRESET_KIND = "preset";
// Limits that a preset field must meet to be kept. A value outside its limit is dropped, not clamped.
const NAME_MAX_LENGTH = 80;
const MODEL_NAME_MAX_LENGTH = 200;
const MAX_MODELS = 50;
const MAX_CALL_CAP = 400;
const MAX_MAX_TOKENS = 100000;
const MAX_TEMPERATURE = 2;
// The probe family names a batch preset may list.
const PROBE_FAMILIES = ["gauntlet", "corrections", "fingerprint", "twins", "dose"];
const MAX_REPEATS = 4;
const MAX_CONCURRENCY = 300;

const NAME_MESSAGE = "A preset needs a name of 1 to 80 characters.";
const DUPLICATE_MESSAGE = "A preset with that name already exists on this page.";
const NOT_FOUND_MESSAGE = "No saved preset has that id.";
const NO_SETTINGS_MESSAGE = "The preset has no settings to save.";
const PAGE_MESSAGE = "Presets can only be kept for the Gauntlet or the Batch page.";

/** Return true for a whole number from min to max. */
function isWholeInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** Return true for a model name: text with no spaces, short enough to be a name. */
function isModelName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MODEL_NAME_MAX_LENGTH && !/\s/.test(value);
}

// The check for each field a preset can hold. A value that fails its check is dropped, as an unknown field is.
const FIELD_CHECKS = {
  pushbackSet: (value) => typeof value === "string" && isPushbackSet(value),
  questionSet: (value) => typeof value === "string" && isQuestionSet(value),
  model: (value) => isModelName(value),
  models: (value) => Array.isArray(value) && value.length <= MAX_MODELS && value.every(isModelName),
  families: (value) => Array.isArray(value) && value.every((family) => PROBE_FAMILIES.includes(family)),
  repeats: (value) => isWholeInRange(value, 1, MAX_REPEATS),
  concurrency: (value) => isWholeInRange(value, 1, MAX_CONCURRENCY),
  callCap: (value) => isWholeInRange(value, 1, MAX_CALL_CAP),
  condition: (value) => CONDITIONS.includes(value),
  temperature: (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_TEMPERATURE,
  maxTokens: (value) => isWholeInRange(value, 1, MAX_MAX_TOKENS),
};

// The fields each page keeps. The Gauntlet page has one model and no batch limits. A preset saved before the
// shuffle was removed also has pushbackSeed and questionSeed fields. Those are not kept, so the preset loads as the
// fixed sets it names, and the load reports them as dropped.
const PAGE_FIELDS = {
  gauntlet: ["pushbackSet", "questionSet", "model", "condition", "temperature", "maxTokens"],
  batch: [
    "pushbackSet", "questionSet", "models", "families", "repeats", "concurrency", "callCap", "condition",
    "temperature", "maxTokens",
  ],
};

/** Return a new id. Uses crypto.randomUUID when the browser has it, otherwise a random string. */
function newId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Throw PAGE_MESSAGE unless the page has a preset list. */
function checkPage(page) {
  if (!Object.hasOwn(PAGE_FIELDS, page)) {
    throw new Error(PAGE_MESSAGE);
  }
}

/** Return the trimmed name, or throw NAME_MESSAGE when it is empty or too long. A name is checked for keys too. */
function checkName(name) {
  const text = typeof name === "string" ? name.trim() : "";
  if (text.length < 1 || text.length > NAME_MAX_LENGTH) {
    throw new Error(NAME_MESSAGE);
  }
  assertNoSecrets(text);
  return text;
}

/** Return true for an id this module made. */
export function isPresetId(id) {
  return typeof id === "string" && id.startsWith(PRESET_PREFIX);
}

/** Return true for a stored document that is a preset. */
export function isPresetDocument(doc) {
  return doc !== null && typeof doc === "object" && isPresetId(doc.id) && doc.kind === PRESET_KIND;
}

/**
 * Return { settings, dropped } for the fields one page keeps. The key and token check runs first, on the raw
 * input, so a key-looking field is refused rather than dropped. Unknown and invalid fields go in dropped.
 */
export function normaliseSettings(page, raw) {
  checkPage(page);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(NO_SETTINGS_MESSAGE);
  }
  assertNoSecrets(raw);
  const settings = {};
  const dropped = Object.keys(raw).filter((name) => !PAGE_FIELDS[page].includes(name));
  for (const name of PAGE_FIELDS[page]) {
    if (!Object.hasOwn(raw, name)) continue;
    if (FIELD_CHECKS[name](raw[name])) {
      settings[name] = structuredClone(raw[name]);
    } else {
      dropped.push(name);
    }
  }
  return { settings, dropped };
}

/** Return the view of a stored preset that the pages use. */
function toView(doc) {
  return {
    id: doc.id,
    name: doc.name,
    page: doc.page,
    settings: doc.settings,
    updatedAt: doc.updatedAt,
  };
}

/** Return the names of two presets in alphabetical order, ignoring case. */
function byName(a, b) {
  return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
}

/** Return the preset stored under an id, or throw NOT_FOUND_MESSAGE. */
async function loadPresetDoc(adapter, id) {
  const doc = isPresetId(id) ? await adapter.get(RUNS_STORE, id) : null;
  if (!isPresetDocument(doc)) {
    throw new Error(NOT_FOUND_MESSAGE);
  }
  return doc;
}

/** Throw DUPLICATE_MESSAGE when another preset on this page already has the name. */
async function assertNameFree(adapter, page, name, ownId) {
  const docs = await adapter.list(RUNS_STORE);
  const taken = docs.some((doc) => isPresetDocument(doc) && doc.page === page && doc.id !== ownId
    && doc.name.toLowerCase() === name.toLowerCase());
  if (taken) {
    throw new Error(DUPLICATE_MESSAGE);
  }
}

/**
 * Create the preset store on top of a run store adapter (memory or IndexedDB). Every method is async.
 * page is "gauntlet" or "batch". Each method throws a plain Error with a message the pages can show.
 */
export function createPresetStore(adapter) {
  return {
    /** Return the presets of one page, in alphabetical order. */
    async list(page) {
      checkPage(page);
      const docs = await adapter.list(RUNS_STORE);
      return docs.filter((doc) => isPresetDocument(doc) && doc.page === page).map(toView).sort(byName);
    },
    /** Save the settings as a new preset with this name. Returns the view and the names of dropped fields. */
    async save(page, name, rawSettings) {
      checkPage(page);
      const cleanName = checkName(name);
      const { settings, dropped } = normaliseSettings(page, rawSettings);
      await assertNameFree(adapter, page, cleanName, null);
      const now = new Date().toISOString();
      const doc = {
        id: `${PRESET_PREFIX}${newId()}`, kind: PRESET_KIND, page, name: cleanName, settings,
        createdAt: now, updatedAt: now,
      };
      await adapter.put(RUNS_STORE, doc);
      return { ...toView(doc), dropped };
    },
    /** Return one preset with its settings checked again, and the names of any fields that were dropped. */
    async load(id) {
      const doc = await loadPresetDoc(adapter, id);
      const { settings, dropped } = normaliseSettings(doc.page, doc.settings);
      return { ...toView(doc), settings, dropped };
    },
    /** Give a preset a new name. The name must be free on its page. */
    async rename(id, name) {
      const doc = await loadPresetDoc(adapter, id);
      const cleanName = checkName(name);
      await assertNameFree(adapter, doc.page, cleanName, id);
      const updated = { ...doc, name: cleanName, updatedAt: new Date().toISOString() };
      await adapter.put(RUNS_STORE, updated);
      return toView(updated);
    },
    /** Delete one preset. Ids that are not presets are refused, so a saved run cannot be removed here. */
    async remove(id) {
      await loadPresetDoc(adapter, id);
      await adapter.remove(RUNS_STORE, id);
    },
  };
}
