// Run lifecycle for the saved runs. A run is one batch of units (one model, one question and one repeat each).
// Each unit is saved as soon as it finishes, so after a reload the page can skip the saved units and never
// repeat a call. This module only reads and writes storage. It never sends a request, and it refuses any
// record that holds a key or a token, so a key cannot reach storage, an export or a log.
import { createIdbAdapter } from './idb-adapter.js';
import { createMemoryAdapter } from './memory-adapter.js';

export const RUNS_STORE = 'runs';
export const STATUSES = Object.freeze(['planned', 'running', 'paused', 'stopped', 'done', 'failed']);
export const MAX_RESULTS = 10000;
export const MAX_RECORD_BYTES = 200 * 1024;
const MAX_LABEL_LENGTH = 80;

// The only status changes allowed. Any other change is refused. A done run cannot change except by deleteRun.
const ALLOWED_TRANSITIONS = Object.freeze({
  planned: ['running'],
  running: ['paused', 'stopped', 'done', 'failed'],
  paused: ['running'],
  stopped: ['running'],
  failed: ['running'],
  done: [],
});

const TRANSITION_MESSAGE = 'That status change is not allowed for this run.';
const FINISHED_MESSAGE = 'This run is finished, so it cannot be changed.';
const NOT_FOUND_MESSAGE = 'No saved run has that id.';
const UNKNOWN_UNIT_MESSAGE = 'That unit is not part of this run.';
const SECRET_MESSAGE = 'The data holds a key or a token, so it was refused and not saved.';
const NOT_PLAIN_MESSAGE = 'The data is not a plain object that can be saved.';
const RUN_SIZE_MESSAGE = 'This run has 10,000 saved results, so no more can be saved.';
const RECORD_SIZE_MESSAGE = 'A record is over 200 KB, so it was refused and not saved.';
const LABEL_MESSAGE = 'The run needs a label of 1 to 80 characters.';
const UNITS_MESSAGE = 'The planned units must be unique, non-empty text.';

// Field names that must never appear in a record, at any depth, once normalised (see normaliseFieldName).
const SECRET_FIELD_NAMES = new Set(['key', 'token', 'authorization', 'secret']);
// A normalised field name ending in this is an API key field, such as apikey, x-api-key or OPENAI_API_KEY.
const API_KEY_SUFFIX = 'apikey';
// A Bearer token: the word Bearer, a space, then 16 or more token characters.
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\/=-]{16,}/i;
// A value that starts with v1. and then 40 or more characters with no space.
const V1_TOKEN_PATTERN = /^\s*v1\.\S{40,}/;

const encoder = new TextEncoder();

// The last timestamp handed out. Each new one is at least one millisecond later, so runs created in the
// same millisecond still list in creation order.
let lastStamp = 0;

/** Return an ISO timestamp that is later than every timestamp this module has returned before. */
function nextTimestamp() {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

/** Return a new id. Uses crypto.randomUUID when present, otherwise 32 hex characters from random bytes. */
function newId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Return true for a plain object (not an array, not null, not a class instance). */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Return the plain-data copy of a value, the same JSON that would be stored or exported. */
function toPlainData(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new Error(NOT_PLAIN_MESSAGE);
  }
}

/** Return the size in bytes of a plain value once serialised. */
function serialisedBytes(value) {
  return encoder.encode(JSON.stringify(value)).length;
}

/** Return true when one string looks like a Bearer token or a v1. key. */
function looksLikeToken(text) {
  return BEARER_PATTERN.test(text) || V1_TOKEN_PATTERN.test(text);
}

/** Return a field name in lower case with dashes, underscores and spaces removed, so API_KEY matches api-key. */
function normaliseFieldName(name) {
  return name.toLowerCase().replace(/[-_\s]/g, '');
}

/** Return true when a field name is a key, token, secret or authorization field, in any spelling. */
function isSecretFieldName(name) {
  const normalised = normaliseFieldName(name);
  return SECRET_FIELD_NAMES.has(normalised) || normalised.endsWith(API_KEY_SUFFIX);
}

/** Walk a value and throw SECRET_MESSAGE on a secret field name or a token-looking string. */
function scanForSecrets(value, ancestors) {
  if (typeof value === 'string') {
    if (looksLikeToken(value)) throw new Error(SECRET_MESSAGE);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (ancestors.has(value)) throw new Error(NOT_PLAIN_MESSAGE);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) scanForSecrets(item, ancestors);
  } else {
    for (const name of Object.keys(value)) {
      if (isSecretFieldName(name)) throw new Error(SECRET_MESSAGE);
      scanForSecrets(value[name], ancestors);
    }
  }
  ancestors.delete(value);
}

/**
 * The one key and token check. It throws SECRET_MESSAGE when the value holds a field whose normalised name is key,
 * token, authorization or secret, or ends in apikey, at any depth. It also throws for a string that looks like a
 * Bearer token or starts with v1. followed by 40 or more characters. Returns the value unchanged when it passes.
 */
export function assertNoSecrets(value) {
  scanForSecrets(value, new Set());
  return value;
}

/** Return a plain copy of a record, refusing it when it is not a plain object, holds a secret, or is too big. */
function checkedRecord(record) {
  const plain = toPlainData(record);
  if (!isPlainObject(plain)) throw new Error(NOT_PLAIN_MESSAGE);
  assertNoSecrets(plain);
  if (serialisedBytes(plain) > MAX_RECORD_BYTES) throw new Error(RECORD_SIZE_MESSAGE);
  return plain;
}

/** Throw TRANSITION_MESSAGE unless the status change is in the allowed list. */
function assertTransition(from, to) {
  const allowed = Object.hasOwn(ALLOWED_TRANSITIONS, from) ? ALLOWED_TRANSITIONS[from] : [];
  if (!allowed.includes(to)) throw new Error(TRANSITION_MESSAGE);
}

/** Load one run for a change. Throws NOT_FOUND_MESSAGE when it is missing. */
async function loadRun(adapter, runId) {
  const run = typeof runId === 'string' ? await adapter.get(RUNS_STORE, runId) : null;
  if (run === null) throw new Error(NOT_FOUND_MESSAGE);
  return run;
}

/** Check the planned units: an array of unique, non-empty text. */
function checkUnits(plannedUnits) {
  if (!Array.isArray(plannedUnits)) throw new Error(UNITS_MESSAGE);
  const seen = new Set();
  for (const unitKey of plannedUnits) {
    if (typeof unitKey !== 'string' || unitKey.trim() === '' || seen.has(unitKey)) {
      throw new Error(UNITS_MESSAGE);
    }
    seen.add(unitKey);
  }
  return plannedUnits.slice();
}

/** Check the label: text of 1 to 80 characters once trimmed. Return the trimmed text. */
function checkLabel(label) {
  const text = typeof label === 'string' ? label.trim() : '';
  if (text.length < 1 || text.length > MAX_LABEL_LENGTH) throw new Error(LABEL_MESSAGE);
  return text;
}

/**
 * Create a run in the planned state and save it. The config is checked for keys and tokens and must be
 * at most 200 KB. Returns the saved run.
 */
export async function createRun(adapter, { label, config = {}, plannedUnits } = {}) {
  const plainConfig = toPlainData(config === undefined ? {} : config);
  if (!isPlainObject(plainConfig)) throw new Error(NOT_PLAIN_MESSAGE);
  const now = nextTimestamp();
  const run = {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    status: 'planned',
    label: checkLabel(label),
    config: plainConfig,
    plannedUnits: checkUnits(plannedUnits),
    results: {},
  };
  assertNoSecrets(run);
  if (serialisedBytes(plainConfig) > MAX_RECORD_BYTES) throw new Error(RECORD_SIZE_MESSAGE);
  await adapter.put(RUNS_STORE, run);
  return run;
}

/**
 * Save the finished record of one unit. Saving the same unit again keeps the first copy and changes
 * nothing. A finished (done) run refuses new results, and so does a unit that is not in the run.
 * Returns the run.
 */
export async function saveResult(adapter, runId, unitKey, record) {
  const plain = checkedRecord(record);
  const run = await loadRun(adapter, runId);
  if (run.status === 'done') throw new Error(FINISHED_MESSAGE);
  if (typeof unitKey !== 'string' || !run.plannedUnits.includes(unitKey)) {
    throw new Error(UNKNOWN_UNIT_MESSAGE);
  }
  if (Object.hasOwn(run.results, unitKey)) return run;
  if (Object.keys(run.results).length >= MAX_RESULTS) throw new Error(RUN_SIZE_MESSAGE);
  // defineProperty keeps a unit key such as "__proto__" as an ordinary entry.
  Object.defineProperty(run.results, unitKey, { value: plain, enumerable: true, writable: true, configurable: true });
  run.updatedAt = nextTimestamp();
  await adapter.put(RUNS_STORE, run);
  return run;
}

/**
 * Save a run that was loaded from a file, in one write. Saving unit by unit (saveResult) would rewrite the whole run
 * for every unit, which is far too slow for a full run of about 1,700 units. Each saved unit must be one of the planned
 * units, and the run gets a new id, the same as createRun gives. The status is set as given, so a loaded run can be
 * opened with Resume. Returns the saved run.
 */
export async function importRunDocument(adapter, { label, config, status, plannedUnits, results, totals }) {
  const plainConfig = toPlainData(config);
  if (!isPlainObject(plainConfig)) throw new Error(NOT_PLAIN_MESSAGE);
  if (serialisedBytes(plainConfig) > MAX_RECORD_BYTES) throw new Error(RECORD_SIZE_MESSAGE);
  const units = checkUnits(plannedUnits);
  const plannedSet = new Set(units);
  const savedKeys = Object.keys(results);
  if (savedKeys.length > MAX_RESULTS || savedKeys.some((key) => !plannedSet.has(key))) {
    throw new Error(UNKNOWN_UNIT_MESSAGE);
  }
  const now = nextTimestamp();
  const run = {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    status,
    label: checkLabel(label),
    config: plainConfig,
    plannedUnits: units,
    results: {},
  };
  for (const key of savedKeys) {
    // defineProperty keeps a unit key such as "__proto__" as an ordinary entry, as saveResult does.
    Object.defineProperty(run.results, key, { value: checkedRecord(results[key]), enumerable: true, writable: true, configurable: true });
  }
  // A file from before totals existed has none, and the run then reads as zero totals.
  if (totals !== undefined) run.totals = toPlainData(totals);
  assertNoSecrets(run);
  await adapter.put(RUNS_STORE, run);
  return run;
}

/**
 * Save the settings a run is continued with, when a Start carries it on with a new reply size or concurrency. Only those
 * two settings change; the set of models, questions and repeats stays as it was. Returns the run.
 */
export async function saveRunSettings(adapter, runId, { maxTokens, concurrency }) {
  const run = await loadRun(adapter, runId);
  run.config = { ...run.config, maxTokens, concurrency };
  run.updatedAt = nextTimestamp();
  assertNoSecrets(run);
  await adapter.put(RUNS_STORE, run);
  return run;
}

/**
 * Change the status of a run. Only the transitions in ALLOWED_TRANSITIONS are made; any other change throws
 * TRANSITION_MESSAGE and nothing is saved. Returns the run.
 */
export async function setStatus(adapter, runId, status) {
  const run = await loadRun(adapter, runId);
  assertTransition(run.status, status);
  run.status = status;
  run.updatedAt = nextTimestamp();
  await adapter.put(RUNS_STORE, run);
  return run;
}

/**
 * Save the totals of a run: the counts added up over every Start, with the most recent failures. Only the totals
 * change; the status and the saved results stay as they are. Returns the run.
 */
export async function saveTotals(adapter, runId, totals) {
  const run = await loadRun(adapter, runId);
  run.totals = toPlainData(totals);
  run.updatedAt = nextTimestamp();
  assertNoSecrets(run);
  await adapter.put(RUNS_STORE, run);
  return run;
}

/**
 * Move a run to running again: a paused, stopped, failed or planned run, or an interrupted run that is
 * still marked running after a reload. An interrupted run first goes to paused, which is an allowed change.
 * Returns the run. It never sends a request.
 */
export async function resumeRun(adapter, runId) {
  const run = await loadRun(adapter, runId);
  if (run.status === 'running') {
    await setStatus(adapter, runId, 'paused');
  }
  return setStatus(adapter, runId, 'running');
}

/** Return the unit keys that have no saved result yet, in the planned order. */
export function pendingUnits(run) {
  return run.plannedUnits.filter((unitKey) => !Object.hasOwn(run.results, unitKey));
}

/** Return every saved run, newest first. */
export async function listRuns(adapter) {
  const runs = await adapter.list(RUNS_STORE);
  return runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** Return one saved run, or null when there is none with that id. */
export async function getRun(adapter, runId) {
  if (typeof runId !== 'string') return null;
  return adapter.get(RUNS_STORE, runId);
}

/**
 * Keep a copy of a run in this browser, replacing any copy with the same id. It is used for runs fetched from the
 * server, so the run is checked first: it must be a plain object with an id, and nothing is saved otherwise.
 */
export async function keepRunCopy(adapter, run) {
  if (!isPlainObject(run) || typeof run.id !== 'string') throw new Error(NOT_PLAIN_MESSAGE);
  await adapter.put(RUNS_STORE, run);
}

/** Delete one run and its results. Deleting an id that is not there does nothing. */
export async function deleteRun(adapter, runId) {
  if (typeof runId !== 'string') return;
  await adapter.remove(RUNS_STORE, runId);
}

/**
 * Return the runs that were still marked running when the page loaded, newest first. Such a run was cut off
 * by a reload or a closed tab. Runs whose ids are in activeRunIds are left out. Nothing is changed or sent.
 */
export async function interruptedRuns(adapter, activeRunIds = []) {
  const active = new Set(activeRunIds);
  const runs = await listRuns(adapter);
  return runs.filter((run) => run.status === 'running' && !active.has(run.id));
}

/**
 * Return the run as a JSON string with the fields a user can see. The key and token check runs again on
 * the output before it is returned.
 */
export function exportRun(run) {
  if (!isPlainObject(run)) throw new Error(NOT_PLAIN_MESSAGE);
  const doc = {
    id: run.id,
    label: run.label,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    config: run.config,
    plannedUnits: run.plannedUnits,
    results: run.results,
  };
  // Totals are left out of older runs, so the file only has them when the run has them.
  if (run.totals !== undefined) doc.totals = run.totals;
  const text = JSON.stringify(doc, null, 2);
  assertNoSecrets(JSON.parse(text));
  return text;
}

/**
 * Open the saved-run storage. It tries IndexedDB first and falls back to memory when IndexedDB is missing
 * or the open fails. The result says which one is in use: fallback is true when runs will not survive a reload.
 * getIndexedDb is passed on to createIdbAdapter, so a test can supply a fake.
 */
export async function openRunStorage(options = {}) {
  const idb = createIdbAdapter(options);
  if (await idb.available()) {
    return { adapter: idb, fallback: false };
  }
  return { adapter: createMemoryAdapter(), fallback: true };
}
