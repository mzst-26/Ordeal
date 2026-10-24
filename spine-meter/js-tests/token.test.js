// Tests for the memory-only key vault in site/js/engine/token.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPlausibleToken,
  maskToken,
  createTokenVault,
  vault,
  MIN_KEY_LENGTH,
  MAX_KEY_LENGTH,
  KEY_CHARACTERS_PATTERN,
} from '../site/js/engine/token.js';

// A fake key of exactly 40 characters. It is not a real key.
const FAKE_KEY = 'test-key-' + '0'.repeat(31);
const BAD_KEY_MESSAGE = 'That does not look like an API key. Check it and try again.';

test('the length limits are 20 to 512 characters', () => {
  assert.equal(MIN_KEY_LENGTH, 20);
  assert.equal(MAX_KEY_LENGTH, 512);
});

test('the key pattern allows letters, digits and - _ . + / = and nothing else', () => {
  assert.equal(KEY_CHARACTERS_PATTERN.test('abcXYZ019-_.+/='), true);
  assert.equal(KEY_CHARACTERS_PATTERN.test('abc def'), false);
});

test('a 40-character key-like string is plausible', () => {
  assert.equal(FAKE_KEY.length, 40);
  assert.equal(isPlausibleToken(FAKE_KEY), true);
});

test('surrounding spaces and a line break are trimmed before the check', () => {
  assert.equal(isPlausibleToken('  ' + FAKE_KEY + '\n'), true);
});

test('blank values are not plausible', () => {
  assert.equal(isPlausibleToken(''), false);
  assert.equal(isPlausibleToken('      '), false);
  assert.equal(isPlausibleToken(null), false);
});

test('a pasted sentence with spaces is not plausible', () => {
  assert.equal(isPlausibleToken('please paste your key here and press the button'), false);
});

test('a key with a space inside it is not plausible', () => {
  assert.equal(isPlausibleToken('abcdefghij klmnopqrstu'), false);
});

test('19 characters is too short', () => {
  assert.equal(isPlausibleToken('a'.repeat(19)), false);
});

test('20 characters is the shortest plausible length', () => {
  assert.equal(isPlausibleToken('a'.repeat(20)), true);
});

test('a 20-character key with +, / and = is plausible', () => {
  const key = 'ab+/='.repeat(4);
  assert.equal(key.length, 20);
  assert.equal(isPlausibleToken(key), true);
});

test('512 characters is the longest plausible length', () => {
  assert.equal(isPlausibleToken('a'.repeat(512)), true);
});

test('513 characters is too long', () => {
  assert.equal(isPlausibleToken('a'.repeat(513)), false);
});

test('characters outside letters, digits and - _ . + / = are rejected', () => {
  assert.equal(isPlausibleToken('abc!def' + 'a'.repeat(20)), false);
  assert.equal(isPlausibleToken('abc#def' + 'a'.repeat(20)), false);
});

test('maskToken shows the first 3 and last 4 characters of a long value', () => {
  assert.equal(maskToken('abcdefghijklmnop'), 'abc…mnop');
});

test('maskToken uses the mask for a 12-character value', () => {
  assert.equal(maskToken('abcdefghijkl'), 'abc…ijkl');
});

test('maskToken shows only dots for a value shorter than 12 characters', () => {
  assert.equal(maskToken('abcdefghijk'), '••••••');
  assert.equal(maskToken('short'), '••••••');
});

test('a new vault has no key', () => {
  const keyVault = createTokenVault();
  assert.equal(keyVault.has(), false);
  assert.equal(keyVault.get(), null);
  assert.equal(keyVault.masked(), '');
});

test('set then get returns the stored key, and has is true', () => {
  const keyVault = createTokenVault();
  keyVault.set(FAKE_KEY);
  assert.equal(keyVault.has(), true);
  assert.equal(keyVault.get(), FAKE_KEY);
});

test('clear forgets the key', () => {
  const keyVault = createTokenVault();
  keyVault.set(FAKE_KEY);
  keyVault.clear();
  assert.equal(keyVault.has(), false);
  assert.equal(keyVault.get(), null);
  assert.equal(keyVault.masked(), '');
});

test('setting an implausible value throws a plain message and stores nothing', () => {
  const keyVault = createTokenVault();
  assert.throws(() => keyVault.set('not a key'), { name: 'Error', message: BAD_KEY_MESSAGE });
  assert.equal(keyVault.has(), false);
});

test('the error for a bad value does not repeat the value', () => {
  const keyVault = createTokenVault();
  const badValue = 'secret sentence with spaces in it';
  let thrown = null;
  try {
    keyVault.set(badValue);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message.includes(badValue), false);
});

test('masked never returns the whole key or its middle part', () => {
  const keyVault = createTokenVault();
  keyVault.set(FAKE_KEY);
  const shown = keyVault.masked();
  assert.equal(shown, maskToken(FAKE_KEY));
  assert.notEqual(shown, FAKE_KEY);
  assert.equal(shown.includes(FAKE_KEY.slice(3, -4)), false);
});

test('the shared vault instance has the vault methods', () => {
  assert.equal(typeof vault.set, 'function');
  assert.equal(typeof vault.get, 'function');
  assert.equal(typeof vault.has, 'function');
  assert.equal(typeof vault.clear, 'function');
  assert.equal(typeof vault.masked, 'function');
});
