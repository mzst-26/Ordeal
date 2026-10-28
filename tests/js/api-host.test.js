// Tests for where the API key is sent. The key must only ever go to the chosen platform's own host, and any other
// address must be refused before the key is read. Every call uses a fake fetch, so no test touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBudget,
  createChatClient,
  fetchModelIds,
  platformAddressFor,
} from '../../frontend/js/engine/api.js';
import { platformList, browserPlatforms, findPlatform } from '../../frontend/js/models/platforms.js';
import { readJson } from './helpers.js';

// A fake key used only by these tests. Tests never print it.
const FAKE_KEY = 'test-key-' + '0'.repeat(31);
const WRONG_ADDRESS = 'The API address is not the one this site is allowed to use.';
const ALL = platformList(readJson('frontend/data/providers.json'));
const OPENROUTER = findPlatform(browserPlatforms(ALL), 'openrouter');
const NEBIUS = findPlatform(browserPlatforms(ALL), 'nebius');

/** Build a fake HTTP response with a status and a JSON body. */
function fakeResponse(status, body) {
  return { status, json: async () => body };
}

/** Build a fake fetch that records each call and returns the given response. */
function recordingFetch(response) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  return { calls, fetchImpl };
}

/** Build a vault that counts how often the key is read. The key is never printed. */
function countingVault() {
  const counts = { reads: 0 };
  return {
    counts,
    has: () => true,
    platformId: () => 'openrouter',
    get: () => {
      counts.reads += 1;
      return FAKE_KEY;
    },
  };
}

/** Return the host part of a URL, such as "openrouter.ai". */
function hostOf(url) {
  return new URL(url).hostname;
}

/** Return the error from a call that must fail. Fails the test if the call succeeds. */
function syncErrorFrom(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw, but it did not.');
}

test('the chat key goes only to the chosen platform: every request host is that platform host', async () => {
  const fake = recordingFetch(fakeResponse(200, { choices: [{ message: { content: 'ok' } }] }));
  const client = createChatClient({
    platform: OPENROUTER,
    vault: countingVault(),
    budget: createBudget(null),
    fetchImpl: fake.fetchImpl,
    sleep: async () => {},
  });
  await client.complete({ model: 'org/name', messages: [], temperature: 0, maxTokens: 1 });
  assert.equal(fake.calls.length, 1);
  assert.equal(hostOf(fake.calls[0].url), 'openrouter.ai');
  assert.equal(fake.calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
});

test('the models check sends the key only to the chosen platform /models address', async () => {
  const fake = recordingFetch(fakeResponse(200, { data: [{ id: 'org/name' }] }));
  await fetchModelIds({ platform: OPENROUTER, token: FAKE_KEY, fetchImpl: fake.fetchImpl });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, 'https://openrouter.ai/api/v1/models');
  assert.equal(fake.calls[0].options.method, 'GET');
  assert.equal(fake.calls[0].options.redirect, 'error');
  assert.equal(fake.calls[0].options.headers.Authorization === 'Bearer ' + FAKE_KEY, true);
});

test('the models check returns the ids sorted, and skips entries with no id', async () => {
  const body = { data: [{ id: 'zeta/one' }, { id: 'alpha/two' }, {}, { id: 3 }] };
  const fake = recordingFetch(fakeResponse(200, body));
  const ids = await fetchModelIds({ platform: NEBIUS, token: FAKE_KEY, fetchImpl: fake.fetchImpl });
  assert.deepEqual(ids, ['alpha/two', 'zeta/one']);
});

test('a model list with no data array is refused with a plain message', async () => {
  const fake = recordingFetch(fakeResponse(200, { models: [] }));
  await assert.rejects(
    fetchModelIds({ platform: NEBIUS, token: FAKE_KEY, fetchImpl: fake.fetchImpl }),
    { message: 'The service sent no model list.' },
  );
});

test('the models check treats 401 as a refused key and does not retry', async () => {
  const fake = recordingFetch(fakeResponse(401, {}));
  await assert.rejects(
    fetchModelIds({ platform: NEBIUS, token: FAKE_KEY, fetchImpl: fake.fetchImpl }),
    { name: 'KeyRefused' },
  );
  assert.equal(fake.calls.length, 1);
});

test('the models check refuses to run without a key, before any request', async () => {
  const fake = recordingFetch(fakeResponse(200, { data: [] }));
  await assert.rejects(
    fetchModelIds({ platform: NEBIUS, token: '', fetchImpl: fake.fetchImpl }),
    { message: 'No API key is set. Add your key first.' },
  );
  assert.equal(fake.calls.length, 0);
});

test('a platform that is not marked for the browser is refused before the key is read', () => {
  const vault = countingVault();
  const notForBrowser = { id: 'sambanova', base_url: 'https://api.sambanova.ai/v1', browser: false };
  const error = syncErrorFrom(() => createChatClient({ platform: notForBrowser, vault, budget: createBudget(null) }));
  assert.equal(error.message, WRONG_ADDRESS);
  assert.equal(vault.counts.reads, 0);
});

test('a platform with a plain http address is refused', () => {
  const plain = { id: 'x', base_url: 'http://api.example.com/v1', browser: true };
  assert.throws(() => platformAddressFor(plain, 'models'), { message: WRONG_ADDRESS });
});

test('a platform with a user name in its address is refused', () => {
  const withUser = { id: 'x', base_url: 'https://user:pass@api.example.com/v1/', browser: true };
  assert.throws(() => platformAddressFor(withUser, 'models'), { message: WRONG_ADDRESS });
});

test('a platform with no base URL (the custom platform) is refused', () => {
  const custom = { id: 'custom', base_url: null, browser: true };
  assert.throws(() => platformAddressFor(custom, 'models'), { message: WRONG_ADDRESS });
});

test('a missing platform is refused', () => {
  assert.throws(() => platformAddressFor(null, 'models'), { message: WRONG_ADDRESS });
});

test('every browser platform with a fixed base URL gets an https address on its own host', () => {
  // The custom platform is marked for the browser but has no fixed base URL, so it is left out here.
  for (const platform of browserPlatforms(ALL).filter((item) => typeof item.base_url === 'string')) {
    const chat = platformAddressFor(platform, 'chat/completions');
    assert.equal(new URL(chat).protocol, 'https:', platform.id + ' must use https');
    assert.equal(hostOf(chat), new URL(platform.base_url).hostname, platform.id + ' must keep its own host');
  }
});

test('a key saved for another platform is refused before any request is made', async () => {
  // The vault says the key belongs to Nebius, but the client is for OpenRouter, so no request may be sent.
  const fake = recordingFetch(fakeResponse(200, { choices: [{ message: { content: 'ok' } }] }));
  const otherPlatformVault = { ...countingVault(), platformId: () => 'nebius' };
  const client = createChatClient({
    platform: OPENROUTER,
    vault: otherPlatformVault,
    budget: createBudget(null),
    fetchImpl: fake.fetchImpl,
    sleep: async () => {},
  });
  await assert.rejects(
    client.complete({ model: 'org/name', messages: [], temperature: 0, maxTokens: 1 }),
    { message: 'The saved key belongs to another platform. Enter the key for this platform.' },
  );
  assert.equal(fake.calls.length, 0);
});
