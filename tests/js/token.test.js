// Tests for the key helpers in frontend/js/engine/token.js: the plausibility rules and the masked display. The keys
// themselves are kept by the per-provider store, which has its own tests in provider-keys.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPlausibleToken,
  maskToken,
  MIN_KEY_LENGTH,
  MAX_KEY_LENGTH,
  KEY_CHARACTERS_PATTERN,
} from '../../frontend/js/engine/token.js';

// A fake key of exactly 40 characters. It is not a real key.
const FAKE_KEY = 'test-key-' + '0'.repeat(31);

// Plausibility check: a quick format check on what a user pasted, not proof that the key works.
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

// Masking: only the ends of a long value are shown, and short values show dots only so little of the key leaks.
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
