// Tests for frontend/js/models/platforms.js. The platform list is the shared file frontend/data/providers.json, which the
// export script copies from ordeal/data/providers.json. Every test is pure: no network and no browser storage,
// except the storage tests, which use a small fake storage object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  platformList,
  browserPlatforms,
  findPlatform,
  currentPlatform,
  usablePlatforms,
  parseModelReference,
  findModel,
  readChoice,
  writeChoice,
} from '../../frontend/js/models/platforms.js';
import { readJson } from './helpers.js';

const PROVIDERS = readJson('frontend/data/providers.json');
const ALL = platformList(PROVIDERS);
const HF = findPlatform(ALL, 'huggingface');
const LOCAL = findPlatform(ALL, 'ollama');

test('platformList returns the platforms from the shared list, one entry per platform', () => {
  assert.equal(ALL.length, PROVIDERS.platforms.length);
  assert.ok(ALL.length > 0);
});

test('platformList refuses a file with no platforms array, with a plain message', () => {
  assert.throws(() => platformList({ version: 1 }), { message: 'The platform list could not be read.' });
});

test('browserPlatforms keeps only platforms marked browser: true', () => {
  const browser = browserPlatforms(ALL);
  assert.ok(browser.length > 0);
  assert.ok(browser.every((platform) => platform.browser === true));
});

test('browserPlatforms leaves out a hosted platform that is marked not for the browser', () => {
  const ids = browserPlatforms(ALL).map((platform) => platform.id);
  assert.equal(ids.includes('sambanova'), false);
});

test('browserPlatforms leaves out local platforms, which need a server on this computer', () => {
  const ids = browserPlatforms(ALL).map((platform) => platform.id);
  assert.equal(ids.includes('ollama'), false);
  assert.equal(ids.includes('vllm'), false);
});

test('findPlatform returns the platform with that id', () => {
  assert.equal(findPlatform(ALL, 'openrouter').name, 'OpenRouter');
});

test('findPlatform returns null for an id that is not in the list', () => {
  assert.equal(findPlatform(ALL, 'no-such-platform'), null);
});

test('parseModelReference accepts a plain id such as org/name', () => {
  assert.deepEqual(parseModelReference(HF, 'meta-llama/Llama-3.1-8B'), { ok: true, model: 'meta-llama/Llama-3.1-8B' });
});

test('parseModelReference strips the hf: prefix', () => {
  assert.deepEqual(parseModelReference(HF, 'hf:org/name'), { ok: true, model: 'org/name' });
});

test('parseModelReference reads a link on the platform host and keeps only the model path', () => {
  const link = 'https://huggingface.co/org/name/?x=1#top';
  assert.deepEqual(parseModelReference(HF, link), { ok: true, model: 'org/name' });
});

test('parseModelReference drops trailing slashes from a link', () => {
  assert.deepEqual(parseModelReference(HF, 'https://huggingface.co/org/name///'), { ok: true, model: 'org/name' });
});

test('parseModelReference refuses empty or blank text', () => {
  assert.equal(parseModelReference(HF, '').ok, false);
  assert.equal(parseModelReference(HF, '   ').ok, false);
});

test('parseModelReference refuses file paths, with a hint to give a model id', () => {
  for (const path of ['/home/me/model.gguf', './models/x', '../x', '~/models/x', 'C:\\models\\x', 'a\\b']) {
    const result = parseModelReference(HF, path);
    assert.equal(result.ok, false, 'should refuse ' + path);
    assert.match(result.reason, /file path/);
  }
});

test('parseModelReference refuses a link to a host other than the platform host', () => {
  const result = parseModelReference(HF, 'https://evil.example/org/name');
  assert.equal(result.ok, false);
  assert.match(result.reason, /huggingface\.co/);
});

test('parseModelReference refuses a link that names no model', () => {
  assert.equal(parseModelReference(HF, 'https://huggingface.co/').ok, false);
});

test('parseModelReference refuses an id with spaces', () => {
  assert.equal(parseModelReference(HF, 'org/name with spaces').ok, false);
});

test('parseModelReference refuses a link for a local platform, which has no model web page', () => {
  assert.equal(parseModelReference(LOCAL, 'https://ollama.com/library/llama3').ok, false);
});

test('findModel returns the exact id when the list has it', () => {
  const available = ['org/name', 'org/other'];
  assert.deepEqual(findModel(HF, 'org/name', available), { ok: true, model: 'org/name' });
});

test('findModel accepts one case-insensitive match and returns the platform spelling', () => {
  const result = findModel(HF, 'ORG/NAME', ['org/name', 'org/other']);
  assert.deepEqual(result, { ok: true, model: 'org/name' });
});

test('findModel reports a missing id with up to five close suggestions', () => {
  const available = ['org/llama-3-8b', 'org/llama-3-70b', 'org/llama-3-8b-instruct', 'org/qwen', 'org/llama-2-7b',
    'org/llama-3-8b-base', 'org/llama-3-13b'];
  const result = findModel(HF, 'org/llama-3-8', available);
  assert.equal(result.ok, false);
  assert.equal(result.suggestions.length, 5);
  assert.ok(result.suggestions.includes('org/llama-3-8b'));
  assert.equal(result.suggestions.includes('org/qwen'), false);
});

test('currentPlatform returns the default platform when nothing is saved', () => {
  assert.equal(currentPlatform(ALL, null).id, 'nebius');
});

test('currentPlatform returns the saved platform when it is a browser platform', () => {
  assert.equal(currentPlatform(ALL, { platformId: 'openrouter', model: 'x' }).id, 'openrouter');
});

test('currentPlatform ignores a saved id that is not a browser platform', () => {
  assert.equal(currentPlatform(ALL, { platformId: 'sambanova', model: 'x' }).id, 'nebius');
});

test('currentPlatform ignores the custom platform, which has no fixed address', () => {
  assert.equal(currentPlatform(ALL, { platformId: 'custom', model: 'x' }).id, 'nebius');
});

test('usablePlatforms keeps browser platforms that have a fixed base URL', () => {
  const ids = usablePlatforms(ALL).map((platform) => platform.id);
  assert.equal(ids.includes('custom'), false);
  assert.equal(ids.includes('nebius'), true);
});

test('readChoice returns null when nothing is saved, or the saved text is not JSON', () => {
  assert.equal(readChoice(fakeStorage({})), null);
  assert.equal(readChoice(fakeStorage({ 'ordeal.platform-choice': 'not json' })), null);
});

test('writeChoice then readChoice gives back the platform id and model', () => {
  const storage = fakeStorage({});
  writeChoice(storage, { platformId: 'openrouter', model: 'org/name' });
  assert.deepEqual(readChoice(storage), { platformId: 'openrouter', model: 'org/name' });
});

test('writeChoice does not throw when storage is blocked', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.doesNotThrow(() => writeChoice(blocked, { platformId: 'openrouter', model: 'x' }));
  assert.equal(readChoice(blocked), null);
});

/** Build a fake storage object backed by a plain object. */
function fakeStorage(initial) {
  const items = { ...initial };
  return {
    getItem: (key) => (key in items ? items[key] : null),
    setItem: (key, value) => { items[key] = String(value); },
  };
}
