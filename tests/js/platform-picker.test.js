// Tests for the platform picker helpers in frontend/js/platforms.js: which platforms a visitor may choose, the facts
// shown on each card, the sign-up link, and the fallback when the saved choice is missing or unusable.
// The platform list is the shared site copy of providers.json. Every test is pure: a fake storage object stands in
// for the browser's local storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PLATFORM_ID,
  platformList,
  findPlatform,
  selectablePlatforms,
  signupLink,
  currentPlatform,
  readChoice,
  CHOICE_STORAGE_NAME,
} from '../../frontend/js/platforms.js';
import { readJson } from './helpers.js';

const ALL = platformList(readJson('frontend/data/providers.json'));
const SELECTABLE = selectablePlatforms(ALL);
const SELECTABLE_IDS = SELECTABLE.map((platform) => platform.id);

/** A fake storage with one saved text entry, so the tests never touch real browser storage. */
function storageHolding(text) {
  return { getItem: (name) => (name === CHOICE_STORAGE_NAME ? text : null) };
}

test('selectablePlatforms keeps only inference platforms marked for the browser, with a fixed address', () => {
  assert.ok(SELECTABLE.length > 0);
  for (const platform of SELECTABLE) {
    assert.equal(platform.kind, 'inference');
    assert.equal(platform.browser, true);
    assert.equal(typeof platform.base_url, 'string');
  }
});

test('selectablePlatforms leaves out single-vendor APIs, local servers and the custom entry', () => {
  for (const id of ['deepseek', 'moonshot', 'minimax', 'zai', 'mistral', 'ollama', 'vllm', 'custom']) {
    assert.equal(SELECTABLE_IDS.includes(id), false, `${id} should not be selectable`);
  }
});

test('selectablePlatforms leaves out inference platforms that are not marked for the browser', () => {
  assert.equal(SELECTABLE_IDS.includes('sambanova'), false);
});

test('selectablePlatforms returns an empty list when given no platforms', () => {
  assert.deepEqual(selectablePlatforms([]), []);
});

test('every selectable platform has a non-empty summary sentence', () => {
  for (const platform of SELECTABLE) {
    assert.equal(typeof platform.summary, 'string', `${platform.id} summary`);
    assert.ok(platform.summary.trim().length > 0, `${platform.id} summary is empty`);
  }
});

test('the default platform is one the visitor can choose', () => {
  assert.ok(SELECTABLE_IDS.includes(DEFAULT_PLATFORM_ID));
});

test('signupLink returns an https sign-up address', () => {
  assert.equal(signupLink({ signup: 'https://openrouter.ai/keys' }), 'https://openrouter.ai/keys');
});

test('signupLink returns null for a missing, empty or non-https sign-up address', () => {
  assert.equal(signupLink({ signup: '' }), null);
  assert.equal(signupLink({}), null);
  assert.equal(signupLink({ signup: 'http://example.com/keys' }), null);
  assert.equal(signupLink({ signup: 'javascript:alert(1)' }), null);
});

test('currentPlatform falls back to the default when nothing is saved', () => {
  assert.equal(currentPlatform(ALL, null).id, DEFAULT_PLATFORM_ID);
});

test('currentPlatform falls back to the default when the saved platform is not selectable', () => {
  assert.equal(currentPlatform(ALL, { platformId: 'deepseek', model: 'x' }).id, DEFAULT_PLATFORM_ID);
});

test('currentPlatform falls back to the default when the saved choice is missing or corrupt', () => {
  const missing = currentPlatform(ALL, readChoice(storageHolding(null)));
  const corrupt = currentPlatform(ALL, readChoice(storageHolding('{not json')));
  assert.equal(missing.id, DEFAULT_PLATFORM_ID);
  assert.equal(corrupt.id, DEFAULT_PLATFORM_ID);
});

test('currentPlatform returns null when no platform can be chosen', () => {
  assert.equal(currentPlatform([], null), null);
});
