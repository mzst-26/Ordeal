// Tests for site/js/model-list.js: the per-platform model lists, the names a
// visitor adds (kept per platform), the checks on a new name, and the large-run warning. Every test is pure: no
// network, no DOM. The storage tests use fake storage objects, one that works and one whose every call throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  platformModelIds,
  MAX_POPUP_ROWS,
  hasSavedList,
  addedStorageName,
  readAddedModels,
  writeAddedModels,
  withAddedModel,
  ticksAfterPlatformChange,
  resolveNewModel,
  largeRunWarning,
  LARGE_RUN_CALLS,
  withoutAddedModel,
  addedRows,
  addOutcomeText,
  refusalText,
  entryNote,
  keyFitsPlatform,
} from '../site/js/model-list.js';
import { setRunLocked, isRunLocked } from '../site/js/run-lock.js';
import { allCards } from '../site/js/picker-dialog.js';
import { platformList, findPlatform, platformIdFor, DEFAULT_PLATFORM_ID } from '../site/js/platforms.js';
import { readJson } from './helpers.js';

const PROVIDERS = readJson('site/data/providers.json');
const ALL = platformList(PROVIDERS);
const HF = findPlatform(ALL, 'huggingface');
const NEBIUS = findPlatform(ALL, 'nebius');

/** A saved-list file with one refreshed platform, for the tests below. */
function listFile(platforms) {
  return { checked: '2026-10-25', platforms };
}

/** A fake storage that works, keeping its values in a Map. */
function workingStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

/** A fake storage whose every call throws, as a blocked storage does. */
const BLOCKED_STORAGE = {
  getItem() {
    throw new Error('storage is blocked');
  },
  setItem() {
    throw new Error('storage is blocked');
  },
};

// platformModelIds: the list of one platform, read from the saved file, with corrupt input never breaking.

test('platformModelIds returns the saved ids of a refreshed platform, in file order', () => {
  const file = listFile({ huggingface: { status: 'refreshed', models: ['org/b', 'org/a'] } });
  assert.deepEqual(platformModelIds(file, 'huggingface'), ['org/b', 'org/a']);
});

test('platformModelIds returns no ids when the saved file is missing', () => {
  assert.deepEqual(platformModelIds(null, 'huggingface'), []);
  assert.deepEqual(platformModelIds(undefined, 'huggingface'), []);
});

test('platformModelIds returns no ids for a file that is not an object or has no platforms map', () => {
  assert.deepEqual(platformModelIds('not json at all', 'huggingface'), []);
  assert.deepEqual(platformModelIds([1, 2, 3], 'huggingface'), []);
  assert.deepEqual(platformModelIds({ checked: '2026-10-25' }, 'huggingface'), []);
});

test('platformModelIds returns no ids for a platform whose status is not refreshed', () => {
  const file = listFile({ groq: { status: 'needs a key', models: ['x/y'] }, nebius: { status: 'failed: timeout', models: ['a/b'] } });
  assert.deepEqual(platformModelIds(file, 'groq'), []);
  assert.deepEqual(platformModelIds(file, 'nebius'), []);
});

test('platformModelIds returns no ids when models is not an array', () => {
  const file = listFile({ huggingface: { status: 'refreshed', models: 'org/name' } });
  assert.deepEqual(platformModelIds(file, 'huggingface'), []);
});

test('platformModelIds skips an entry that is not a string, or is empty, and keeps the rest', () => {
  const file = listFile({ huggingface: { status: 'refreshed', models: ['org/a', 42, null, '', { id: 'x' }, 'org/b'] } });
  assert.deepEqual(platformModelIds(file, 'huggingface'), ['org/a', 'org/b']);
});

test('platformModelIds keeps only the first copy of a repeated id', () => {
  const file = listFile({ huggingface: { status: 'refreshed', models: ['org/a', 'org/a', 'org/b'] } });
  assert.deepEqual(platformModelIds(file, 'huggingface'), ['org/a', 'org/b']);
});

test('platformModelIds returns an empty list for a platform with an empty models list', () => {
  const file = listFile({ huggingface: { status: 'refreshed', models: [] } });
  assert.deepEqual(platformModelIds(file, 'huggingface'), []);
  assert.equal(hasSavedList(file, 'huggingface'), false);
});

test('hasSavedList is true only when the platform has at least one saved id', () => {
  const file = listFile({ huggingface: { status: 'refreshed', models: ['org/a'] } });
  assert.equal(hasSavedList(file, 'huggingface'), true);
  assert.equal(hasSavedList(file, 'openrouter'), false);
  assert.equal(hasSavedList(null, 'huggingface'), false);
});

test('the shipped models.json gives the featherless list with its many ids, and nebius a list too', () => {
  const shipped = readJson('site/data/models.json');
  assert.ok(platformModelIds(shipped, 'featherless').length > 1000);
  assert.ok(platformModelIds(shipped, 'nebius').length > 0);
  assert.deepEqual(platformModelIds(shipped, 'groq'), []);
});


// The names a visitor adds: kept per platform, read and written inside try/catch.

test('addedStorageName gives each platform its own storage key', () => {
  assert.equal(addedStorageName('openrouter'), 'ordeal.added-models.openrouter');
  assert.notEqual(addedStorageName('openrouter'), addedStorageName('groq'));
});

test('writeAddedModels then readAddedModels keeps the names for that platform only', () => {
  const storage = workingStorage();
  const added = [{ id: 'org/new', checked: true }];
  assert.equal(writeAddedModels(storage, 'openrouter', added), true);
  assert.deepEqual(readAddedModels(storage, 'openrouter'), added);
  assert.deepEqual(readAddedModels(storage, 'groq'), []);
});

test('readAddedModels returns an empty list when storage has nothing or holds broken text', () => {
  assert.deepEqual(readAddedModels(workingStorage(), 'openrouter'), []);
  const broken = workingStorage({ [addedStorageName('openrouter')]: '{not json' });
  assert.deepEqual(readAddedModels(broken, 'openrouter'), []);
  const notArray = workingStorage({ [addedStorageName('openrouter')]: '{"id":"x"}' });
  assert.deepEqual(readAddedModels(notArray, 'openrouter'), []);
});

test('readAddedModels skips an entry that has no string id or no checked flag', () => {
  const raw = JSON.stringify([{ id: 'org/ok', checked: false }, { id: 7, checked: true }, 'org/plain', { id: '', checked: true }]);
  const storage = workingStorage({ [addedStorageName('openrouter')]: raw });
  assert.deepEqual(readAddedModels(storage, 'openrouter'), [{ id: 'org/ok', checked: false }]);
});

test('readAddedModels and writeAddedModels never throw when storage is blocked', () => {
  assert.deepEqual(readAddedModels(BLOCKED_STORAGE, 'openrouter'), []);
  assert.equal(writeAddedModels(BLOCKED_STORAGE, 'openrouter', [{ id: 'org/a', checked: true }]), false);
  assert.deepEqual(readAddedModels(null, 'openrouter'), []);
});

test('withAddedModel adds a new name, not ticked as checked unless asked', () => {
  const result = withAddedModel([], 'org/new', false);
  assert.equal(result.duplicate, false);
  assert.deepEqual(result.added, [{ id: 'org/new', checked: false }]);
});

test('withAddedModel does not add a name twice, and reports the duplicate', () => {
  const start = [{ id: 'org/a', checked: true }];
  const result = withAddedModel(start, 'org/a', false);
  assert.equal(result.duplicate, true);
  assert.deepEqual(result.added, start);
});

test('withAddedModel does not change the list it was given', () => {
  const start = [{ id: 'org/a', checked: true }];
  withAddedModel(start, 'org/b', true);
  assert.deepEqual(start, [{ id: 'org/a', checked: true }]);
});

// resolveNewModel: the checks on a typed name, before anything is added.

test('resolveNewModel refuses an empty name with a plain message', () => {
  const result = resolveNewModel(HF, '   ', null);
  assert.equal(result.ok, false);
  assert.match(result.reason, /Give a model id/);
});

test('resolveNewModel refuses a file path, so no path is ever added as a model', () => {
  const result = resolveNewModel(HF, '/etc/passwd', null);
  assert.equal(result.ok, false);
  assert.match(result.reason, /file path/);
});

test('resolveNewModel refuses a name with spaces', () => {
  const result = resolveNewModel(HF, 'org/has space', null);
  assert.equal(result.ok, false);
  assert.match(result.reason, /spaces/);
});

test('resolveNewModel refuses a link to another website', () => {
  const result = resolveNewModel(HF, 'https://evil.example/org/name', null);
  assert.equal(result.ok, false);
});

test('resolveNewModel reads a link on the platform host as the model path', () => {
  const result = resolveNewModel(HF, 'https://huggingface.co/org/name', null);
  assert.deepEqual(result, { ok: true, model: 'org/name', checked: false });
});

test('resolveNewModel says not checked when there is no list to check against', () => {
  assert.deepEqual(resolveNewModel(HF, 'org/fresh', null), { ok: true, model: 'org/fresh', checked: false });
});

test('resolveNewModel accepts a name the platform lists, and marks it checked', () => {
  const result = resolveNewModel(HF, 'org/known', ['org/known', 'org/other']);
  assert.deepEqual(result, { ok: true, model: 'org/known', checked: true });
});

test('resolveNewModel refuses a name the platform does not list, and gives close names', () => {
  const result = resolveNewModel(HF, 'org/knwn', ['org/known', 'org/other']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.suggestions, ['org/known']);
});

// ticksAfterPlatformChange: when the platform changes, no tick from the old platform survives.

test('ticksAfterPlatformChange clears every tick when the platform changes', () => {
  const ticked = new Set(['org/a', 'org/b']);
  const after = ticksAfterPlatformChange('nebius', 'groq', ticked);
  assert.equal(after.size, 0);
});

test('ticksAfterPlatformChange keeps the ticks when the platform is the same', () => {
  const ticked = new Set(['org/a']);
  assert.equal(ticksAfterPlatformChange('nebius', 'nebius', ticked), ticked);
});

test('a tick from one platform does not come back when the visitor switches away and back', () => {
  // The first switch clears the ticks. The second switch starts from the empty set, so nothing returns.
  const ticked = new Set(['org/a']);
  const onGroq = ticksAfterPlatformChange('nebius', 'groq', ticked);
  const backOnNebius = ticksAfterPlatformChange('groq', 'nebius', onGroq);
  assert.equal(backOnNebius.size, 0);
});

// largeRunWarning: one plain line when the planned calls are more than 5,000. It never blocks the run.

test('largeRunWarning is empty at and below 5,000 calls', () => {
  assert.equal(LARGE_RUN_CALLS, 5000);
  assert.equal(largeRunWarning(5000), '');
  assert.equal(largeRunWarning(0), '');
});

test('largeRunWarning gives one plain line above 5,000 calls', () => {
  const text = largeRunWarning(5001);
  assert.match(text, /large/);
  assert.match(text, /long time/);
  assert.equal(text.includes('\n'), false);
});

// platformIdFor: the platform id the key dialog and the batch page both use, with the same fallback.

test('platformIdFor returns the saved platform when it is selectable', () => {
  assert.equal(platformIdFor(ALL, { platformId: 'openrouter', model: '' }), 'openrouter');
});

test('platformIdFor falls back to the default platform for a saved id that is not selectable', () => {
  assert.equal(platformIdFor(ALL, { platformId: 'sambanova', model: '' }), DEFAULT_PLATFORM_ID);
  assert.equal(platformIdFor(ALL, { platformId: 'ollama', model: '' }), DEFAULT_PLATFORM_ID);
  assert.equal(platformIdFor(ALL, { platformId: 'no-such', model: '' }), DEFAULT_PLATFORM_ID);
});

test('platformIdFor returns the default platform when nothing is saved', () => {
  assert.equal(platformIdFor(ALL, null), NEBIUS.id);
});

// withoutAddedModel: remove one added name, never changing the list it was given.

test('withoutAddedModel removes only the named id and leaves the given list unchanged', () => {
  const start = [{ id: 'org/a', checked: true }, { id: 'org/b', checked: false }];
  assert.deepEqual(withoutAddedModel(start, 'org/a'), [{ id: 'org/b', checked: false }]);
  assert.equal(start.length, 2);
});

test('withoutAddedModel gives the same list back when the id is not there', () => {
  const start = [{ id: 'org/a', checked: true }];
  assert.deepEqual(withoutAddedModel(start, 'org/zzz'), start);
});

// addedRows: the added names that are not already on the platform's own list, as rows.

test('addedRows gives a row for each added name that the platform list does not have', () => {
  const rows = addedRows(['org/a'], [{ id: 'org/a', checked: true }, { id: 'org/new', checked: false }]);
  assert.deepEqual(rows, [{ id: 'org/new', note: 'added', unchecked: true, added: true }]);
});

test('addedRows marks a confirmed name as checked, not unchecked', () => {
  assert.deepEqual(addedRows([], [{ id: 'org/ok', checked: true }]), [{ id: 'org/ok', note: 'added', unchecked: false, added: true }]);
});

// addOutcomeText and refusalText: the plain lines the popup shows.

test('addOutcomeText says the name was added and whether the list confirmed it', () => {
  assert.equal(addOutcomeText({ model: 'org/a', checked: true, saved: true }), 'Added org/a. The platform list has it.');
  assert.match(addOutcomeText({ model: 'org/a', checked: false, saved: true }), /not checked/);
});

test('addOutcomeText says the name lasts only for this visit when storage is blocked', () => {
  assert.match(addOutcomeText({ model: 'org/a', checked: false, saved: false }), /only for this page visit/);
});

test('refusalText gives the reason, and the close names when there are some', () => {
  assert.equal(refusalText('Nope.', []), 'Nope.');
  assert.equal(refusalText('Nope.', ['org/known', 'org/other']), 'Nope. Did you mean: org/known, org/other?');
});

// entryNote: the small note after a model's name in the popup card.

test('entryNote joins the row note and "not checked", and is empty for a plain confirmed row', () => {
  assert.equal(entryNote({ note: '', unchecked: false }), '');
  assert.equal(entryNote({ note: 'added', unchecked: true }), 'added, not checked');
  assert.equal(entryNote({ note: 'custom endpoint', unchecked: false }), 'custom endpoint');
});

// keyFitsPlatform: a key is only ever sent to the platform it was entered for.

test('keyFitsPlatform is true only when the key was entered for this platform', () => {
  assert.equal(keyFitsPlatform('nebius', 'nebius'), true);
  assert.equal(keyFitsPlatform('nebius', 'groq'), false);
  assert.equal(keyFitsPlatform(null, 'nebius'), false);
  assert.equal(keyFitsPlatform('', ''), false);
});

// The run lock: the platform choice is refused while a run or its confirmation is open.

test('the run lock is off by default and only true turns it on', () => {
  setRunLocked(false);
  assert.equal(isRunLocked(), false);
  setRunLocked(true);
  assert.equal(isRunLocked(), true);
  setRunLocked('yes');
  assert.equal(isRunLocked(), false);
  setRunLocked(false);
});

test('MAX_POPUP_ROWS is 300, the limit of ticked lines the plan draws', () => {
  assert.equal(MAX_POPUP_ROWS, 300);
});

// allCards: the plain picker path (the question picker) gives a plain array of cards that the grid can draw.

test('allCards gives one card per matching item, as a plain array', () => {
  const fakeCard = (item) => ({ textContent: item });
  const cards = allCards(['org/a', 'org/b'], 'b', fakeCard, () => false);
  assert.equal(Array.isArray(cards), true);
  assert.deepEqual(cards.map((card) => card.item), ['org/b']);
});

