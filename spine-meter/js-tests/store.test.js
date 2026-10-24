// Tests for the saved-run store in site/js/store/. Storage is the memory adapter, so nothing touches a
// browser or the network. The IndexedDB adapter is only checked for its available() false path, using fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryAdapter } from '../site/js/store/memory-adapter.js';
import { createIdbAdapter, IDB_NAME, IDB_VERSION, IDB_STORE } from '../site/js/store/idb-adapter.js';
import {
  RUNS_STORE,
  STATUSES,
  MAX_RESULTS,
  MAX_RECORD_BYTES,
  createRun,
  saveResult,
  setStatus,
  resumeRun,
  pendingUnits,
  listRuns,
  getRun,
  deleteRun,
  exportRun,
  interruptedRuns,
  assertNoSecrets,
  openRunStorage,
} from '../site/js/store/run-store.js';

// The fixed messages, as the store words them. A test fails if the wording changes by accident.
const TRANSITION_MESSAGE = 'That status change is not allowed for this run.';
const FINISHED_MESSAGE = 'This run is finished, so it cannot be changed.';
const NOT_FOUND_MESSAGE = 'No saved run has that id.';
const UNKNOWN_UNIT_MESSAGE = 'That unit is not part of this run.';
const SECRET_MESSAGE = 'The data holds a key or a token, so it was refused and not saved.';
const RUN_SIZE_MESSAGE = 'This run has 10,000 saved results, so no more can be saved.';
const RECORD_SIZE_MESSAGE = 'A record is over 200 KB, so it was refused and not saved.';
const UNITS_MESSAGE = 'The planned units must be unique, non-empty text.';
const LABEL_MESSAGE = 'The run needs a label of 1 to 80 characters.';

// Fake values, not real keys.
const FAKE_BEARER = 'Bearer abcdefghijklmnop1234';
const FAKE_V1 = 'v1.' + 'a'.repeat(40);

const UNITS = ['m1|q1|0|baseline', 'm1|q1|0|level_1', 'm1|q2|0|baseline'];

/** Create a planned run with the standard label and config. */
function makeRun(adapter, plannedUnits = UNITS) {
  return createRun(adapter, {
    label: 'Test run',
    config: { temperature: 0, max_tokens: 512, concurrency: 2 },
    plannedUnits,
  });
}

/** Create a run and move it to the given status by the allowed route. */
async function runAt(adapter, status) {
  const run = await makeRun(adapter);
  if (status === 'planned') return run;
  await setStatus(adapter, run.id, 'running');
  if (status === 'running') return getRun(adapter, run.id);
  await setStatus(adapter, run.id, status);
  return getRun(adapter, run.id);
}

/** Return a fake indexedDB whose open() reports an error, the way some private windows do. Calls are recorded. */
function failingIndexedDb(calls) {
  return {
    open(name, version) {
      calls.push({ name, version });
      const request = {};
      setTimeout(() => request.onerror && request.onerror({}), 0);
      return request;
    },
  };
}

test('a new run is planned, has an id and timestamps, and is saved', async () => {
  const adapter = createMemoryAdapter();
  const run = await makeRun(adapter);
  assert.equal(run.status, 'planned');
  assert.equal(run.label, 'Test run');
  assert.deepEqual(run.plannedUnits, UNITS);
  assert.deepEqual(run.results, {});
  assert.equal(typeof run.createdAt, 'string');
  assert.equal(run.createdAt, run.updatedAt);
  assert.deepEqual(await getRun(adapter, run.id), run);
});

test('run ids come from crypto.randomUUID and are different for each run', async () => {
  const adapter = createMemoryAdapter();
  const first = await makeRun(adapter);
  const second = await makeRun(adapter);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(first.id, uuid);
  assert.notEqual(first.id, second.id);
});

test('createRun refuses a bad label, duplicate units and empty unit keys', async () => {
  const adapter = createMemoryAdapter();
  await assert.rejects(createRun(adapter, { label: '   ', plannedUnits: UNITS }), { message: LABEL_MESSAGE });
  await assert.rejects(createRun(adapter, { label: 'x'.repeat(81), plannedUnits: UNITS }), { message: LABEL_MESSAGE });
  await assert.rejects(makeRun(adapter, [UNITS[0], UNITS[0]]), { message: UNITS_MESSAGE });
  await assert.rejects(makeRun(adapter, ['  ']), { message: UNITS_MESSAGE });
  assert.deepEqual(await listRuns(adapter), []);
});

test('saving a result checkpoints it: the run keeps its status and gets a newer updatedAt', async () => {
  const adapter = createMemoryAdapter();
  const run = await runAt(adapter, 'running');
  const saved = await saveResult(adapter, run.id, UNITS[0], { reply: 'Answer: B', grade: 'correct' });
  assert.equal(saved.status, 'running');
  assert.deepEqual(saved.results[UNITS[0]], { reply: 'Answer: B', grade: 'correct' });
  assert.ok(saved.updatedAt > run.updatedAt);
  assert.deepEqual((await getRun(adapter, run.id)).results, saved.results);
});

test('saving the same unit twice keeps one copy: the first record stays', async () => {
  const adapter = createMemoryAdapter();
  const run = await runAt(adapter, 'running');
  await saveResult(adapter, run.id, UNITS[0], { reply: 'first' });
  const again = await saveResult(adapter, run.id, UNITS[0], { reply: 'second' });
  assert.deepEqual(Object.keys(again.results), [UNITS[0]]);
  assert.equal(again.results[UNITS[0]].reply, 'first');
});

test('saving a result for a unit that is not in the run is refused', async () => {
  const adapter = createMemoryAdapter();
  const run = await runAt(adapter, 'running');
  await assert.rejects(saveResult(adapter, run.id, 'not-a-unit', { reply: 'x' }), { message: UNKNOWN_UNIT_MESSAGE });
});

test('pending units after a reload are the planned units with no saved result, in order', async () => {
  const adapter = createMemoryAdapter();
  const run = await runAt(adapter, 'running');
  await saveResult(adapter, run.id, UNITS[1], { reply: 'a' });
  // Simulated reload: the page forgets its copy and reads the run again through the same adapter.
  const afterReload = await getRun(adapter, run.id);
  assert.deepEqual(pendingUnits(afterReload), [UNITS[0], UNITS[2]]);
  await saveResult(adapter, run.id, UNITS[0], { reply: 'b' });
  await saveResult(adapter, run.id, UNITS[2], { reply: 'c' });
  assert.deepEqual(pendingUnits(await getRun(adapter, run.id)), []);
});

test('the status changes that are allowed all work', async () => {
  const allowed = [
    ['planned', 'running'],
    ['running', 'paused'],
    ['running', 'stopped'],
    ['running', 'done'],
    ['running', 'failed'],
    ['paused', 'running'],
    ['stopped', 'running'],
    ['failed', 'running'],
  ];
  for (const [from, to] of allowed) {
    const adapter = createMemoryAdapter();
    const run = await runAt(adapter, from);
    const changed = await setStatus(adapter, run.id, to);
    assert.equal(changed.status, to, `${from} to ${to} should be allowed`);
  }
});

test('every other status change is refused with a fixed message, and the run does not change', async () => {
  const allowed = new Set(['planned>running', 'running>paused', 'running>stopped', 'running>done',
    'running>failed', 'paused>running', 'stopped>running', 'failed>running']);
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (allowed.has(`${from}>${to}`)) continue;
      const adapter = createMemoryAdapter();
      const run = await runAt(adapter, from);
      await assert.rejects(setStatus(adapter, run.id, to), { message: TRANSITION_MESSAGE }, `${from} to ${to}`);
      assert.equal((await getRun(adapter, run.id)).status, from, `${from} to ${to} must not change the run`);
    }
  }
});

test('a done run cannot change: no status change and no new result', async () => {
  const adapter = createMemoryAdapter();
  const run = await runAt(adapter, 'done');
  for (const status of STATUSES) {
    await assert.rejects(setStatus(adapter, run.id, status), { message: TRANSITION_MESSAGE });
  }
  await assert.rejects(saveResult(adapter, run.id, UNITS[0], { reply: 'x' }), { message: FINISHED_MESSAGE });
  assert.deepEqual((await getRun(adapter, run.id)).results, {});
});

test('an unknown run id gives a fixed not-found message, and getRun returns null', async () => {
  const adapter = createMemoryAdapter();
  assert.equal(await getRun(adapter, 'missing'), null);
  await assert.rejects(setStatus(adapter, 'missing', 'running'), { message: NOT_FOUND_MESSAGE });
  await assert.rejects(saveResult(adapter, 'missing', UNITS[0], {}), { message: NOT_FOUND_MESSAGE });
});

test('an interrupted run is one that is still marked running when it is listed after a reload', async () => {
  const adapter = createMemoryAdapter();
  const cutOff = await runAt(adapter, 'running');
  const paused = await runAt(adapter, 'paused');
  await makeRun(adapter);
  const found = await interruptedRuns(adapter);
  assert.deepEqual(found.map((run) => run.id), [cutOff.id]);
  // Finding an interrupted run changes nothing: it is still running.
  assert.equal((await getRun(adapter, cutOff.id)).status, 'running');
  assert.deepEqual(await interruptedRuns(adapter, [cutOff.id]), [], 'active runs are left out');
  assert.equal(paused.status, 'paused');
});

test('resuming an interrupted run moves it back to running, and the page can leave it out as active', async () => {
  const adapter = createMemoryAdapter();
  const run = await runAt(adapter, 'running');
  const resumed = await resumeRun(adapter, run.id);
  assert.equal(resumed.status, 'running');
  // While the page runs it, the page passes its own run ids, so it is not offered again.
  assert.deepEqual(await interruptedRuns(adapter, [run.id]), []);
  // A later reload with no active run reports it again, which is correct: it was cut off again.
  assert.deepEqual((await interruptedRuns(adapter)).map((found) => found.id), [run.id]);
});

test('resuming a stopped run moves it to running', async () => {
  const adapter = createMemoryAdapter();
  const run = await runAt(adapter, 'stopped');
  assert.equal((await resumeRun(adapter, run.id)).status, 'running');
});

test('deleteRun removes the run and its results, and deleting twice does nothing', async () => {
  const adapter = createMemoryAdapter();
  const run = await runAt(adapter, 'running');
  await saveResult(adapter, run.id, UNITS[0], { reply: 'x' });
  await deleteRun(adapter, run.id);
  assert.equal(await getRun(adapter, run.id), null);
  assert.deepEqual(await listRuns(adapter), []);
  await deleteRun(adapter, run.id);
});

test('listRuns returns runs newest first', async () => {
  const adapter = createMemoryAdapter();
  const first = await makeRun(adapter);
  const second = await makeRun(adapter);
  const third = await makeRun(adapter);
  assert.deepEqual((await listRuns(adapter)).map((run) => run.id), [third.id, second.id, first.id]);
});

test('exportRun gives a JSON string with only the visible fields', async () => {
  const adapter = createMemoryAdapter();
  const run = await runAt(adapter, 'running');
  await saveResult(adapter, run.id, UNITS[0], { reply: 'Answer: B' });
  const text = exportRun(await getRun(adapter, run.id));
  assert.equal(typeof text, 'string');
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed).sort(),
    ['config', 'createdAt', 'id', 'label', 'plannedUnits', 'results', 'status', 'updatedAt']);
  assert.equal(parsed.results[UNITS[0]].reply, 'Answer: B');
  assert.equal(exportRun({ ...run, extra: 'not exported' }).includes('not exported'), false);
});

test('exportRun runs the key check again and refuses output that holds a token', async () => {
  const adapter = createMemoryAdapter();
  const run = await runAt(adapter, 'running');
  assert.throws(() => exportRun({ ...run, config: { nested: { apiKey: 'x' } } }), { message: SECRET_MESSAGE });
  assert.throws(() => exportRun({ ...run, label: FAKE_BEARER }), { message: SECRET_MESSAGE });
});

test('the key check refuses a key field at any depth', () => {
  assert.throws(() => assertNoSecrets({ a: { b: [{ c: { apiKey: 'x' } }] } }), { message: SECRET_MESSAGE });
  for (const name of ['key', 'apiKey', 'api_key', 'token', 'authorization', 'secret', 'Token']) {
    assert.throws(() => assertNoSecrets({ [name]: 'harmless' }), { message: SECRET_MESSAGE }, name);
  }
});

test('the key check refuses api-key, x-api-key and API_KEY in any spelling, even with a plain value', () => {
  for (const name of ['api-key', 'x-api-key', 'API_KEY', 'Api Key', 'X_API_KEY', 'openai-apikey']) {
    assert.throws(() => assertNoSecrets({ [name]: 'plain value' }), { message: SECRET_MESSAGE }, name);
    assert.throws(() => assertNoSecrets({ nested: [{ [name]: 'plain value' }] }), { message: SECRET_MESSAGE }, name);
  }
  assert.doesNotThrow(() => assertNoSecrets({ monkey: 'banana', keyboard: 'qwerty', maxTokens: 512 }));
});

test('the key check refuses a Bearer-looking string and a v1. key-looking string', () => {
  assert.throws(() => assertNoSecrets({ note: 'Sent with ' + FAKE_BEARER }), { message: SECRET_MESSAGE });
  assert.throws(() => assertNoSecrets({ note: FAKE_V1 }), { message: SECRET_MESSAGE });
  assert.throws(() => assertNoSecrets(['ok', FAKE_V1]), { message: SECRET_MESSAGE });
});

test('the v1. check needs 40 or more characters after v1.', () => {
  assert.doesNotThrow(() => assertNoSecrets({ note: 'v1.' + 'a'.repeat(39) }));
  assert.throws(() => assertNoSecrets({ note: 'v1.' + 'a'.repeat(40) }), { message: SECRET_MESSAGE });
});

test('the key check accepts a normal record and prose that mentions bearers', () => {
  const record = {
    reply: 'Answer: B',
    grade: { correct: true, flipped: false },
    note: 'Use bearer of news carefully',
    steps: ['level_1', 'level_2'],
  };
  assert.equal(assertNoSecrets(record), record);
});

test('createRun refuses a config that holds a key, and nothing is saved', async () => {
  const adapter = createMemoryAdapter();
  await assert.rejects(createRun(adapter, {
    label: 'Leaky',
    config: { headers: { authorization: 'Bearer x' } },
    plannedUnits: UNITS,
  }), { message: SECRET_MESSAGE });
  assert.deepEqual(await listRuns(adapter), []);
});

test('saveResult refuses a record that holds a token, and the run gets no result', async () => {
  const adapter = createMemoryAdapter();
  const run = await runAt(adapter, 'running');
  await assert.rejects(saveResult(adapter, run.id, UNITS[0], { reply: 'ok', token: 'abc' }), { message: SECRET_MESSAGE });
  await assert.rejects(saveResult(adapter, run.id, UNITS[1], { reply: FAKE_BEARER }), { message: SECRET_MESSAGE });
  assert.deepEqual((await getRun(adapter, run.id)).results, {});
});

test('a record over 200 KB is refused and a record just under it is saved', async () => {
  const adapter = createMemoryAdapter();
  const run = await runAt(adapter, 'running');
  await assert.rejects(saveResult(adapter, run.id, UNITS[0], { reply: 'x'.repeat(MAX_RECORD_BYTES) }),
    { message: RECORD_SIZE_MESSAGE });
  assert.deepEqual((await getRun(adapter, run.id)).results, {});
  const saved = await saveResult(adapter, run.id, UNITS[0], { reply: 'x'.repeat(150 * 1024) });
  assert.equal(saved.results[UNITS[0]].reply.length, 150 * 1024);
});

test('a run refuses a result once it holds 10,000 saved results', async () => {
  const adapter = createMemoryAdapter();
  const unitKeys = Array.from({ length: MAX_RESULTS + 1 }, (_, index) => `unit-${index}`);
  const created = await makeRun(adapter, unitKeys);
  // Fill 9,999 results directly, so the test does not run 9,999 slow saves.
  const filled = { ...created, results: {} };
  for (let index = 0; index < MAX_RESULTS - 1; index += 1) {
    filled.results[unitKeys[index]] = { reply: 'x' };
  }
  await adapter.put(RUNS_STORE, filled);
  const tenThousandth = await saveResult(adapter, created.id, unitKeys[MAX_RESULTS - 1], { reply: 'y' });
  assert.equal(Object.keys(tenThousandth.results).length, MAX_RESULTS);
  await assert.rejects(saveResult(adapter, created.id, unitKeys[MAX_RESULTS], { reply: 'z' }),
    { message: RUN_SIZE_MESSAGE });
});

test('the IndexedDB adapter is named for the sycophancy-meter database, version 1, store runs', () => {
  assert.equal(IDB_NAME, 'sycophancy-meter');
  assert.equal(IDB_VERSION, 1);
  assert.equal(IDB_STORE, 'runs');
  assert.equal(RUNS_STORE, 'runs');
});

test('openRunStorage falls back to memory and says so when the global indexedDB is missing', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  if (saved) delete globalThis.indexedDB;
  try {
    assert.equal('indexedDB' in globalThis, false);
    const { adapter, fallback } = await openRunStorage();
    assert.equal(fallback, true);
    assert.equal(adapter.kind, 'memory');
    assert.equal(await adapter.available(), true);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'indexedDB', saved);
  }
});

test('openRunStorage falls back to memory when the IndexedDB open fails (private browsing)', async () => {
  const calls = [];
  const { adapter, fallback } = await openRunStorage({ getIndexedDb: () => failingIndexedDb(calls) });
  assert.equal(fallback, true);
  assert.equal(adapter.kind, 'memory');
  assert.deepEqual(calls, [{ name: IDB_NAME, version: IDB_VERSION }]);
});

test('the IndexedDB adapter reports available() false when indexedDB is missing or the open fails', async () => {
  assert.equal(await createIdbAdapter({ getIndexedDb: () => undefined }).available(), false);
  assert.equal(await createIdbAdapter({ getIndexedDb: () => failingIndexedDb([]) }).available(), false);
  const adapter = createIdbAdapter({ getIndexedDb: () => undefined });
  await assert.rejects(adapter.list(RUNS_STORE), { message: 'Saved runs are not available in this browser, so runs last only until the page is closed.' });
});

test('the memory adapter returns copies, so a change to a copy does not change the store', async () => {
  const adapter = createMemoryAdapter();
  await adapter.put(RUNS_STORE, { id: 'r1', label: 'one' });
  const copy = await adapter.get(RUNS_STORE, 'r1');
  copy.label = 'changed';
  assert.equal((await adapter.get(RUNS_STORE, 'r1')).label, 'one');
  assert.equal(await adapter.get(RUNS_STORE, 'missing'), null);
  await assert.rejects(adapter.put(RUNS_STORE, { label: 'no id' }));
});
