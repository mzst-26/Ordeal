// Tests for the operation log of a batch run (engine/batch-log.js), the remembered key (engine/token.js),
// and the request and stop events that are written to the log (engine/api.js and engine/runner.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBatchLog, LOG_LIMIT } from '../frontend/js/engine/batch-log.js';
import { createTokenVault, REMEMBER_STORAGE_NAME } from '../frontend/js/engine/token.js';
import { createChatClient, createBudget } from '../frontend/js/engine/api.js';

// A fake key of exactly 40 characters. It is not a real key.
const FAKE_KEY = 'test-key-' + '0'.repeat(31);
const BASE_URL = 'https://api.tokenfactory.nebius.com/v1/';

/** A Map that behaves like localStorage for the tests. */
function memoryStorage() {
  const items = new Map();
  return {
    getItem: (name) => (items.has(name) ? items.get(name) : null),
    setItem: (name, value) => items.set(name, String(value)),
    removeItem: (name) => items.delete(name),
    items,
  };
}

/** A log that stamps every entry with the same time, so tests do not depend on the clock. */
function fixedLog(options = {}) {
  return createBatchLog({ now: () => '2026-10-25T00:00:00.000Z', ...options });
}

test('a log entry has a time, a kind and the fields given', () => {
  const log = fixedLog();
  const entry = log.record('step-start', { model: 'm', step: 'level_1' });
  assert.deepEqual(entry, { time: '2026-10-25T00:00:00.000Z', kind: 'step-start', model: 'm', step: 'level_1' });
});

test('fields that could hold a reply, a request body or the key are never kept', () => {
  const log = fixedLog();
  log.record('step-done', { step: 'level_1', reply: 'Answer: C', messages: [{ role: 'user' }], token: FAKE_KEY });
  const [entry] = log.entries();
  assert.equal('reply' in entry, false);
  assert.equal('messages' in entry, false);
  assert.equal('token' in entry, false);
  assert.equal(log.toJsonl().includes(FAKE_KEY), false);
});

test('the log keeps at most the limit, drops the oldest entries first and says how many', () => {
  const log = fixedLog({ limit: 3 });
  for (let index = 1; index <= 5; index += 1) log.record('tick', { index });
  assert.deepEqual(log.entries().map((entry) => entry.index), [3, 4, 5]);
  assert.equal(log.dropped(), 2);
  const [header] = log.toJsonl().split('\n');
  assert.deepEqual(JSON.parse(header), { time: '2026-10-25T00:00:00.000Z', kind: 'log-truncated', dropped: 2 });
});

test('the default limit is 5000 entries', () => {
  assert.equal(LOG_LIMIT, 5000);
});

test('an empty log writes no text, and each entry is one JSON line', () => {
  assert.equal(fixedLog().toJsonl(), '');
  const log = fixedLog();
  log.record('a', { n: 1 });
  log.record('b', { n: 2 });
  const lines = log.toJsonl().trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[1]), { time: '2026-10-25T00:00:00.000Z', kind: 'b', n: 2 });
});

test('a remembered key is written to storage and read back by a new vault', () => {
  const storage = memoryStorage();
  createTokenVault({ storage }).set(FAKE_KEY, { remember: true, platform: 'test' });
  assert.equal(storage.items.get(REMEMBER_STORAGE_NAME), FAKE_KEY);

  const later = createTokenVault({ storage });
  assert.equal(later.has(), true);
  assert.equal(later.get(), FAKE_KEY);
  assert.equal(later.remembered(), true);
});

test('a key set without Remember is not written to storage, and removes an older copy', () => {
  const storage = memoryStorage();
  const vault = createTokenVault({ storage });
  vault.set(FAKE_KEY, { remember: true, platform: 'test' });
  vault.set('other-key-' + '1'.repeat(30), { remember: false, platform: 'test' });
  assert.equal(storage.items.has(REMEMBER_STORAGE_NAME), false);
  assert.equal(vault.get(), 'other-key-' + '1'.repeat(30));
});

test('clear forgets the key in memory and in storage', () => {
  const storage = memoryStorage();
  const vault = createTokenVault({ storage });
  vault.set(FAKE_KEY, { remember: true, platform: 'test' });
  vault.clear();
  assert.equal(vault.has(), false);
  assert.equal(createTokenVault({ storage }).has(), false);
});

test('a stored value that is not a plausible key is ignored', () => {
  const storage = memoryStorage();
  storage.setItem(REMEMBER_STORAGE_NAME, 'not a key');
  const vault = createTokenVault({ storage });
  assert.equal(vault.has(), false);
  assert.equal(vault.get(), null);
});

test('a storage that throws never breaks the vault, and the key still works for this tab', () => {
  const broken = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  const vault = createTokenVault({ storage: broken });
  vault.set(FAKE_KEY, { remember: true, platform: 'test' });
  assert.equal(vault.get(), FAKE_KEY);
  vault.clear();
  assert.equal(vault.has(), false);
});

test('without storage the vault behaves as before and remembers nothing', () => {
  const vault = createTokenVault();
  vault.set(FAKE_KEY, { remember: true, platform: 'test' });
  assert.equal(vault.get(), FAKE_KEY);
  assert.equal(vault.remembered(), false);
});

test('a retried request logs each attempt, the wait and the result, and never the key', async () => {
  const log = fixedLog();
  const vault = createTokenVault();
  vault.set(FAKE_KEY, { platform: 'test' });
  const replies = [{ status: 429 }, { status: 200, json: async () => ({ choices: [{ message: { content: 'Answer: C' } }] }) }];
  const client = createChatClient({
    platform: { id: 'test', base_url: BASE_URL, browser: true },
    vault,
    budget: createBudget(null),
    fetchImpl: async () => {
      const next = replies.shift();
      return { status: next.status, json: next.json ?? (async () => ({})) };
    },
    sleep: async () => {},
    log,
  });
  const reply = await client.complete({ model: 'm', messages: [], temperature: 0.7, maxTokens: 16 });
  assert.equal(reply, 'Answer: C');

  const kinds = log.entries().map((entry) => entry.kind);
  assert.deepEqual(kinds, ['request-attempt', 'request-result', 'retry-wait', 'request-attempt', 'request-result']);
  const [first] = log.entries().filter((entry) => entry.kind === 'request-result');
  assert.equal(first.status, 429);
  assert.equal(first.retryable, true);
  assert.equal(log.toJsonl().includes(FAKE_KEY), false);
  assert.equal(log.toJsonl().includes('Answer: C'), false);
});

test('a refused key is logged as refused, with its status', async () => {
  const log = fixedLog();
  const vault = createTokenVault();
  vault.set(FAKE_KEY, { platform: 'test' });
  const client = createChatClient({
    platform: { id: 'test', base_url: BASE_URL, browser: true },
    vault,
    budget: createBudget(null),
    fetchImpl: async () => ({ status: 401, json: async () => ({}) }),
    sleep: async () => {},
    log,
  });
  await assert.rejects(client.complete({ model: 'm', messages: [], temperature: 0.7, maxTokens: 16 }));
  const refused = log.entries().find((entry) => entry.kind === 'request-refused');
  assert.equal(refused.status, 401);
});
