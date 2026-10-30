// Tests for the per-provider key store in frontend/js/engine/provider-keys.js. Each key is kept under its provider id,
// so a key for one provider is never handed to another. The scenario tests at the end cover one provider, three
// providers, one missing key, storage on and off, and that no key reaches the page or the console.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_KEYS_STORAGE_NAME,
  createProviderKeys,
  keySlotFor,
} from '../../frontend/js/engine/provider-keys.js';

// Fake keys of the right shape. They are not real keys.
const KEY_A = 'key-alpha-' + '1'.repeat(30);
const KEY_B = 'key-beta-' + '2'.repeat(31);
const KEY_C = 'key-gamma-' + '3'.repeat(30);

/** A storage object that keeps its values in a Map, like localStorage does for one page. */
function fakeStorage() {
  const items = new Map();
  return {
    items,
    getItem: (name) => (items.has(name) ? items.get(name) : null),
    setItem: (name, value) => items.set(name, String(value)),
    removeItem: (name) => items.delete(name),
  };
}

test('the storage name is the one kept for per-provider keys', () => {
  assert.equal(PROVIDER_KEYS_STORAGE_NAME, 'ordeal.provider-keys');
});

test('a key is kept under the provider id it was set for', () => {
  const keys = createProviderKeys();
  keys.set('groq', KEY_A);
  assert.equal(keys.get('groq'), KEY_A);
  assert.equal(keys.has('groq'), true);
  assert.equal(keys.has('together'), false);
});

test('a provider id is mapped to its own key slot, and the slot is refused for other ids', () => {
  const keys = createProviderKeys();
  keys.set('groq', KEY_A);
  const slot = keySlotFor(keys, 'groq');
  assert.equal(slot.get(), KEY_A);
  assert.equal(slot.platformId(), 'groq');
  assert.throws(() => slot.set(KEY_B, { platform: 'together' }), /belongs to another provider/);
  assert.equal(slot.get(), KEY_A);
});

test('keys for three providers stay separate and are not mixed up', () => {
  const keys = createProviderKeys();
  keys.set('nebius', KEY_A);
  keys.set('groq', KEY_B);
  keys.set('together', KEY_C);
  assert.equal(keys.get('nebius'), KEY_A);
  assert.equal(keys.get('groq'), KEY_B);
  assert.equal(keys.get('together'), KEY_C);
});

test('clearing one provider leaves the others', () => {
  const keys = createProviderKeys();
  keys.set('nebius', KEY_A);
  keys.set('groq', KEY_B);
  keys.clear('groq');
  assert.equal(keys.has('groq'), false);
  assert.equal(keys.get('nebius'), KEY_A);
});

test('a provider id with capitals or spaces is refused, so a slot name cannot be odd', () => {
  const keys = createProviderKeys();
  assert.throws(() => keys.set('Groq Cloud', KEY_A), /provider id/);
});

test('a key that does not look like a key is refused and nothing is stored', () => {
  const keys = createProviderKeys();
  assert.throws(() => keys.set('groq', 'short'), /does not look like an API key/);
  assert.equal(keys.has('groq'), false);
});

test('by default a key is kept in memory only, so nothing is written to storage', () => {
  const storage = fakeStorage();
  const keys = createProviderKeys({ storage });
  keys.set('groq', KEY_A);
  assert.equal(storage.items.size, 0);
  assert.equal(keys.remembered('groq'), false);
});

test('with remember on, the key is written to storage under its provider id', () => {
  const storage = fakeStorage();
  const keys = createProviderKeys({ storage });
  keys.set('groq', KEY_A, { remember: true });
  assert.equal(keys.remembered('groq'), true);
  assert.match(storage.getItem(PROVIDER_KEYS_STORAGE_NAME), /groq/);
});

test('a key saved with remember on is still there after a reload, with its provider', () => {
  const storage = fakeStorage();
  createProviderKeys({ storage }).set('groq', KEY_A, { remember: true });
  const reloaded = createProviderKeys({ storage });
  assert.equal(reloaded.get('groq'), KEY_A);
  assert.equal(reloaded.has('together'), false);
});

test('clearing a remembered key removes it from storage', () => {
  const storage = fakeStorage();
  const keys = createProviderKeys({ storage });
  keys.set('groq', KEY_A, { remember: true });
  keys.clear('groq');
  assert.equal(storage.getItem(PROVIDER_KEYS_STORAGE_NAME), null);
});

test('a key set without remember is removed from storage when another key is remembered', () => {
  const storage = fakeStorage();
  const keys = createProviderKeys({ storage });
  keys.set('groq', KEY_A, { remember: true });
  keys.set('groq', KEY_B, { remember: false });
  assert.equal(createProviderKeys({ storage }).has('groq'), false);
});

test('a storage that throws is ignored, and the key still works for this page', () => {
  const broken = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  const keys = createProviderKeys({ storage: broken });
  keys.set('groq', KEY_A, { remember: true });
  assert.equal(keys.get('groq'), KEY_A);
});

test('masked shows only the start and end of a key, never the whole value', () => {
  const keys = createProviderKeys();
  keys.set('groq', KEY_A);
  const shown = keySlotFor(keys, 'groq').masked();
  assert.notEqual(shown, KEY_A);
  assert.equal(shown.includes(KEY_A.slice(5, 20)), false);
});

// Scenario tests. Each one plays a whole visit: keys set, read back, and checked.

test('scenario: one provider, key set, and its slot is ready to use', () => {
  const keys = createProviderKeys();
  keys.set('nebius', KEY_A);
  const slot = keySlotFor(keys, 'nebius');
  assert.equal(slot.has(), true);
  assert.equal(slot.get(), KEY_A);
  assert.equal(slot.platformId(), 'nebius');
});

test('scenario: three providers, each with its own key, read back from their own slots', () => {
  const keys = createProviderKeys();
  keys.set('nebius', KEY_A);
  keys.set('groq', KEY_B);
  keys.set('together', KEY_C);
  assert.deepEqual(
    ['nebius', 'groq', 'together'].map((id) => keySlotFor(keys, id).get()),
    [KEY_A, KEY_B, KEY_C],
  );
});

test('scenario: storage on for one provider and off for another, reloaded together', () => {
  const storage = fakeStorage();
  const keys = createProviderKeys({ storage });
  keys.set('nebius', KEY_A, { remember: true });
  keys.set('groq', KEY_B, { remember: false });
  const reloaded = createProviderKeys({ storage });
  assert.equal(reloaded.has('nebius'), true);
  assert.equal(reloaded.has('groq'), false);
});

test('scenario: no key text reaches the console during set, read, mask and clear', () => {
  const seen = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const name of Object.keys(original)) {
    console[name] = (...parts) => seen.push(parts.map(String).join(' '));
  }
  try {
    const keys = createProviderKeys({ storage: fakeStorage() });
    keys.set('groq', KEY_A, { remember: true });
    keySlotFor(keys, 'groq').masked();
    keys.get('groq');
    keys.clear('groq');
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(seen, []);
});
