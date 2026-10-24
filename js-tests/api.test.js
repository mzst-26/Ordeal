// Tests for the chat client in site/js/engine/api.js. Every call uses a fake fetch, so no test
// touches the network or spends money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_BASE_URL,
  BudgetExhausted,
  KeyRefused,
  MAX_ATTEMPTS_PER_STEP,
  MAX_RETRIES,
  createBudget,
  backoffSeconds,
  isRetryable,
  createChatClient,
  defaultSleep,
  apiModelFor,
  chatBody,
} from '../site/js/engine/api.js';
import { CUSTOM_MODEL_REASONS } from '../site/js/engine/custom-model.js';
import { createTokenVault } from '../site/js/engine/token.js';
import { readJson } from './helpers.js';

// A fake key used only by these tests. Tests never print it.
const FAKE_KEY = 'test-key-' + '0'.repeat(31);
const BASE_URL = ALLOWED_BASE_URL;
const CHAT_URL = ALLOWED_BASE_URL + 'chat/completions';
const KEY_REFUSED = 'The key was refused. Check the key and try again.';
const STOPPED = 'Stopped by you.';
const NO_KEY = 'No API key is set. Add your key first.';
const NO_TEXT = 'The reply had no text.';
const WRONG_ADDRESS = 'The API address is not the one this site is allowed to use.';
const CUSTOM_REFUSED = 'Custom endpoints cannot be used yet. Each one needs its own key first.';
// A custom model used only by these tests. Its host is an example name, and no test calls it.
const CUSTOM_MODEL = { name: 'my-model', base_url: 'https://llm.example.org/v1', model: 'remote-model' };

/** Build a fake HTTP response with a status and a JSON body. */
function fakeResponse(status, body) {
  return { status, json: async () => body };
}

/** Build a successful chat reply that contains the given text. */
function replyWith(text) {
  return fakeResponse(200, { choices: [{ message: { content: text } }] });
}

/** Build an error shaped like the one fetch throws when a request is aborted. */
function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * Build a fake fetch. Each script entry is a response object, an Error to throw, or a function
 * (url, options) that returns a response or throws. Every call is recorded.
 */
function makeFakeFetch(script) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const entry = script[calls.length - 1];
    if (entry === undefined) throw new Error('The test script ran out of responses.');
    if (entry instanceof Error) throw entry;
    if (typeof entry === 'function') return entry(url, options);
    return entry;
  };
  return { calls, fetchImpl };
}

/** Build a client wired to a fake fetch and a fake sleep that only records the waits. */
function makeClient({
  script,
  baseUrl = BASE_URL,
  customModels = [],
  budget = createBudget(null),
  maxRetries = 5,
  timeoutMs = 120000,
  hasKey = true,
  sleepImpl = null,
}) {
  const vault = createTokenVault();
  if (hasKey) vault.set(FAKE_KEY);
  const fake = makeFakeFetch(script);
  const sleeps = [];
  const recordingSleep = async (seconds) => {
    sleeps.push(seconds);
  };
  const client = createChatClient({
    baseUrl,
    customModels,
    vault,
    budget,
    maxRetries,
    timeoutMs,
    fetchImpl: fake.fetchImpl,
    sleep: sleepImpl ?? recordingSleep,
  });
  return { client, calls: fake.calls, sleeps };
}

/** Build the fields that complete() takes, with sensible defaults. */
function sampleRequest(extra = {}) {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'Hello' }],
    temperature: 0.7,
    maxTokens: 2048,
    ...extra,
  };
}

/** Wait for a call that should fail and return its error. Fails the test if it succeeds. */
async function errorFrom(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to fail, but it succeeded.');
}

// Happy path: what a good call returns and exactly what it sends (URL, headers, JSON body).
test('a successful call returns the reply text', async () => {
  const { client } = makeClient({ script: [replyWith('Answer: B')] });
  const text = await client.complete(sampleRequest());
  assert.equal(text, 'Answer: B');
});

test('a successful call posts JSON with the Bearer header to the chat endpoint', async () => {
  const { client, calls } = makeClient({ script: [replyWith('ok')] });
  await client.complete(sampleRequest());
  const call = calls[0];
  assert.equal(call.url, CHAT_URL);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['Content-Type'], 'application/json');
  // Compare to a boolean so a failed check never prints the key.
  assert.equal(call.options.headers.Authorization === 'Bearer ' + FAKE_KEY, true);
  assert.deepEqual(JSON.parse(call.options.body), {
    model: 'test-model',
    messages: [{ role: 'user', content: 'Hello' }],
    temperature: 0.7,
    max_tokens: 2048,
  });
});

test('the endpoint is the same whether or not baseUrl ends with a slash', async () => {
  for (const baseUrl of [ALLOWED_BASE_URL, ALLOWED_BASE_URL.slice(0, -1)]) {
    const { client, calls } = makeClient({ script: [replyWith('ok')], baseUrl });
    await client.complete(sampleRequest());
    assert.equal(calls[0].url, CHAT_URL);
  }
});

test('a client made with the allowed API address works', async () => {
  const { client, calls } = makeClient({ script: [replyWith('ok')], baseUrl: ALLOWED_BASE_URL });
  const text = await client.complete(sampleRequest());
  assert.equal(text, 'ok');
  assert.equal(calls[0].url, CHAT_URL);
});

test('a client made with the allowed API address without a trailing slash works', async () => {
  const { client, calls } = makeClient({
    script: [replyWith('ok')],
    baseUrl: ALLOWED_BASE_URL.slice(0, -1),
  });
  const text = await client.complete(sampleRequest());
  assert.equal(text, 'ok');
  assert.equal(calls[0].url, CHAT_URL);
});

// Host lock: the client only talks to the one allowed API address, and refuses anything else at construction time.
test('a client made for any other host throws before any fetch or key read', () => {
  const fake = makeFakeFetch([replyWith('ok')]);
  let keyReads = 0;
  const vault = {
    get() {
      keyReads += 1;
      return FAKE_KEY;
    },
  };
  assert.throws(
    () => createChatClient({
      baseUrl: 'https://example.com/v1/',
      vault,
      budget: createBudget(null),
      fetchImpl: fake.fetchImpl,
    }),
    { message: WRONG_ADDRESS },
  );
  assert.equal(fake.calls.length, 0);
  assert.equal(keyReads, 0);
});

// Retry rules: 429, 5xx, network errors and timeouts are retried with back-off; 400, 401 and 403 fail at once.
// The fake sleep records the waits so the back-off schedule can be checked without real delays.
test('a 429 is retried once and then the call succeeds', async () => {
  const { client, calls, sleeps } = makeClient({
    script: [fakeResponse(429, {}), replyWith('ok')],
  });
  const text = await client.complete(sampleRequest());
  assert.equal(text, 'ok');
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [1]);
});

test('three 500 errors in a row give up and name the status', async () => {
  const script = [fakeResponse(500, {}), fakeResponse(500, {}), fakeResponse(500, {})];
  const { client, calls, sleeps } = makeClient({ script, maxRetries: 2 });
  const error = await errorFrom(client.complete(sampleRequest()));
  assert.match(error.message, /500/);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [1, 2]);
});

test('a 401 fails at once with the key message and no retry', async () => {
  const { client, calls, sleeps } = makeClient({ script: [fakeResponse(401, {})] });
  const error = await errorFrom(client.complete(sampleRequest()));
  assert.equal(error.message, KEY_REFUSED);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('a 403 is treated like a 401 and is not retried', async () => {
  const { client, calls } = makeClient({ script: [fakeResponse(403, {})] });
  const error = await errorFrom(client.complete(sampleRequest()));
  assert.equal(error.message, KEY_REFUSED);
  assert.equal(calls.length, 1);
});

test('a 400 fails at once and is not retried', async () => {
  const { client, calls } = makeClient({ script: [fakeResponse(400, {})] });
  const error = await errorFrom(client.complete(sampleRequest()));
  assert.match(error.message, /400/);
  assert.equal(calls.length, 1);
});

test('a network error (fetch throws TypeError) is retried', async () => {
  const { client, calls, sleeps } = makeClient({
    script: [new TypeError('fetch failed'), replyWith('ok')],
  });
  const text = await client.complete(sampleRequest());
  assert.equal(text, 'ok');
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [1]);
});

test('a persistent network error gives up with a network message', async () => {
  const script = [new TypeError('fetch failed'), new TypeError('fetch failed')];
  const { client } = makeClient({ script, maxRetries: 1 });
  const error = await errorFrom(client.complete(sampleRequest()));
  assert.match(error.message, /network/i);
});

test('a timeout is retried and the next attempt can succeed', async () => {
  // This fake only ends when the client's timer aborts the signal, as a slow request would.
  const hangUntilAborted = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(abortError()));
  });
  const { client, calls } = makeClient({
    script: [hangUntilAborted, replyWith('ok')],
    timeoutMs: 5,
  });
  const text = await client.complete(sampleRequest());
  assert.equal(text, 'ok');
  assert.equal(calls.length, 2);
});

// Budget: every attempt, including retries, spends from a shared limit and stops the call when it runs out.
test('a budget of 2 allows two attempts, then the third throws BudgetExhausted', async () => {
  const budget = createBudget(2);
  const script = [fakeResponse(500, {}), fakeResponse(500, {}), fakeResponse(500, {})];
  const { client, calls } = makeClient({ script, budget });
  const error = await errorFrom(client.complete(sampleRequest()));
  assert.ok(error instanceof BudgetExhausted);
  assert.equal(calls.length, 2);
  assert.equal(budget.used(), 2);
});

// Cancellation: an abort from the caller surfaces as "Stopped by you." and is never retried.
test('a caller abort during a request throws "Stopped by you." and is not retried', async () => {
  const controller = new AbortController();
  const abortThenFail = () => {
    controller.abort();
    return Promise.reject(abortError());
  };
  const { client, calls, sleeps } = makeClient({ script: [abortThenFail, replyWith('ok')] });
  const error = await errorFrom(client.complete(sampleRequest({ signal: controller.signal })));
  assert.equal(error.message, STOPPED);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('a signal that is already aborted stops the call before any fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  const { client, calls } = makeClient({ script: [replyWith('ok')] });
  const error = await errorFrom(client.complete(sampleRequest({ signal: controller.signal })));
  assert.equal(error.message, STOPPED);
  assert.equal(calls.length, 0);
});

test('a 200 reply with no text throws the no-text message', async () => {
  const { client } = makeClient({ script: [fakeResponse(200, { choices: [] })] });
  const error = await errorFrom(client.complete(sampleRequest()));
  assert.equal(error.message, NO_TEXT);
});

// Secret safety: no error text may ever contain the API key or the Authorization header.
test('no thrown message contains the key or the word Bearer', async () => {
  const scenarios = [
    { script: [fakeResponse(401, {})] },
    { script: [fakeResponse(500, {}), fakeResponse(500, {})], maxRetries: 1 },
    { script: [new TypeError('leaked ' + FAKE_KEY)], maxRetries: 0 },
    { script: [fakeResponse(200, { choices: [] })] },
    { script: [fakeResponse(400, {})] },
  ];
  for (const scenario of scenarios) {
    const { client } = makeClient(scenario);
    const error = await errorFrom(client.complete(sampleRequest()));
    const shown = String(error.message) + ' ' + String(error);
    assert.equal(shown.includes(FAKE_KEY), false, 'an error message contains the key');
    assert.equal(shown.includes('Bearer'), false, 'an error message contains the Bearer header');
  }
});

test('complete throws before any fetch when no key is set', async () => {
  const { client, calls } = makeClient({ script: [], hasKey: false });
  const error = await errorFrom(client.complete(sampleRequest()));
  assert.equal(error.message, NO_KEY);
  assert.equal(calls.length, 0);
});

// Pure helpers: back-off timing, the retry decision, and the budget counter.
test('backoffSeconds doubles each attempt and is capped at 60', () => {
  const seconds = [0, 1, 2, 3, 4, 5, 6, 7].map((attempt) => backoffSeconds(attempt));
  assert.deepEqual(seconds, [1, 2, 4, 8, 16, 32, 60, 60]);
});

test('isRetryable is true for 429, 5xx and network problems', () => {
  assert.equal(isRetryable(429, false), true);
  assert.equal(isRetryable(500, false), true);
  assert.equal(isRetryable(503, false), true);
  assert.equal(isRetryable(599, false), true);
  assert.equal(isRetryable(undefined, true), true);
});

test('isRetryable is false for 400, 401, 403, 404 and other 4xx', () => {
  assert.equal(isRetryable(400, false), false);
  assert.equal(isRetryable(401, false), false);
  assert.equal(isRetryable(403, false), false);
  assert.equal(isRetryable(404, false), false);
  assert.equal(isRetryable(422, false), false);
});

test('a budget with no limit has no remaining count and never runs out', () => {
  const budget = createBudget(null);
  for (let i = 0; i < 100; i += 1) budget.spend();
  assert.equal(budget.used(), 100);
  assert.equal(budget.remaining(), null);
  assert.equal(budget.limit, null);
});

test('a budget of 2 reports remaining counts and throws on the third spend', () => {
  const budget = createBudget(2);
  budget.spend();
  assert.equal(budget.remaining(), 1);
  budget.spend();
  assert.equal(budget.remaining(), 0);
  assert.throws(() => budget.spend(), BudgetExhausted);
  assert.equal(budget.used(), 2);
});

// Sleeping and aborting: the real sleep must end at once on abort, including during a retry back-off.
test('defaultSleep resolves after its wait', async () => {
  const result = await defaultSleep(0);
  assert.equal(result, undefined);
});

test('aborting during the retry back-off ends the call at once, with no further fetch', async () => {
  // This sleep never ends on its own, so only the abort can end the wait.
  let backoffStarted;
  const backoffHasStarted = new Promise((resolve) => {
    backoffStarted = resolve;
  });
  const neverEndingSleep = () => {
    backoffStarted();
    return new Promise(() => {});
  };
  const controller = new AbortController();
  const { client, calls } = makeClient({
    script: [fakeResponse(500, {}), replyWith('ok')],
    sleepImpl: neverEndingSleep,
  });
  const pending = errorFrom(client.complete(sampleRequest({ signal: controller.signal })));
  await backoffHasStarted;
  controller.abort();
  const error = await Promise.race([
    pending,
    delay(1000).then(() => new Error('The call did not end after the abort.')),
  ]);
  assert.equal(error.message, STOPPED);
  assert.equal(calls.length, 1);
});

test('defaultSleep rejects at once when its signal aborts', async () => {
  const controller = new AbortController();
  const pending = errorFrom(defaultSleep(60, controller.signal));
  controller.abort();
  const error = await Promise.race([
    pending,
    delay(1000).then(() => new Error('defaultSleep did not end after the abort.')),
  ]);
  assert.equal(error.message, STOPPED);
});

// KeyRefused is a distinct error type so a batch run can stop immediately instead of retrying every step.
test('a 401 or 403 throws KeyRefused, the error the batch uses to stop at once', async () => {
  for (const status of [401, 403]) {
    const { client, calls } = makeClient({ script: [fakeResponse(status, {})] });
    const error = await errorFrom(client.complete(sampleRequest()));
    assert.ok(error instanceof KeyRefused, `status ${status} should throw KeyRefused`);
    assert.equal(error.message, KEY_REFUSED);
    assert.equal(calls.length, 1);
  }
});

/** Return the error a synchronous call throws, or null when it does not throw. */
function syncErrorFrom(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

// Custom models: this client refuses to call them at all (no key is sent to a user-supplied URL),
// and it validates the custom list up front. Built-in models still work as normal.
test('a custom model is refused with a fixed message before any fetch or key read', async () => {
  const fake = makeFakeFetch([replyWith('custom')]);
  let keyReads = 0;
  const vault = {
    get() {
      keyReads += 1;
      return FAKE_KEY;
    },
  };
  const client = createChatClient({
    baseUrl: BASE_URL,
    customModels: [CUSTOM_MODEL],
    vault,
    budget: createBudget(null),
    fetchImpl: fake.fetchImpl,
  });
  const error = await errorFrom(client.complete(sampleRequest({ model: 'my-model' })));
  assert.equal(error.message, CUSTOM_REFUSED);
  assert.equal(fake.calls.length, 0, 'a request was made for a custom model');
  assert.equal(keyReads, 0, 'the key was read for a custom model');
});

test('the key is never sent to a custom URL, and the built-in model gets the key on the built-in URL', async () => {
  const otherCustom = { name: 'second', base_url: 'https://other.example.net/v1/', model: 'x' };
  const { client, calls } = makeClient({
    script: [replyWith('built-in')],
    customModels: [CUSTOM_MODEL, otherCustom],
  });
  for (const model of ['my-model', 'second']) {
    await errorFrom(client.complete(sampleRequest({ model })));
  }
  assert.equal(calls.length, 0, 'a custom model caused a request');
  assert.equal(await client.complete(sampleRequest({ model: 'test-model' })), 'built-in');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CHAT_URL);
  assert.equal(calls[0].options.headers.Authorization === 'Bearer ' + FAKE_KEY, true);
});

test('a custom entry whose display name differs from its API model id gives the API id in the body', () => {
  const entry = { name: 'Display Name', base_url: 'https://llm.example.org/v1', model: 'org/api-id' };
  const apiModel = apiModelFor('Display Name', [entry]);
  assert.equal(apiModel, 'org/api-id');
  const messages = [{ role: 'user', content: 'Hi' }];
  const body = JSON.parse(chatBody(apiModel, { messages, temperature: 0.5, maxTokens: 9 }));
  assert.deepEqual(body, { model: 'org/api-id', messages, temperature: 0.5, max_tokens: 9 });
  assert.equal(apiModelFor('test-model', [entry]), 'test-model');
});

test('a built-in model sends its name as the model id, exactly as before', async () => {
  for (const name of readJson('config.json').models) {
    const { client, calls } = makeClient({ script: [replyWith('ok')] });
    await client.complete(sampleRequest({ model: name }));
    assert.equal(JSON.parse(calls[0].options.body).model, name);
  }
});

test('a custom model that fails the custom-model checks throws a fixed message before any fetch or key read', () => {
  const badEntries = [
    { ...CUSTOM_MODEL, base_url: 'http://llm.example.org/v1' },
    { ...CUSTOM_MODEL, base_url: 'https://user:secret@llm.example.org/v1' },
    { ...CUSTOM_MODEL, base_url: 'https://llm.example.org/v1?key=1' },
    { ...CUSTOM_MODEL, base_url: 'https:///v1' },
    { ...CUSTOM_MODEL, name: '  ' },
  ];
  for (const entry of badEntries) {
    const fake = makeFakeFetch([replyWith('ok')]);
    let keyReads = 0;
    const vault = {
      get() {
        keyReads += 1;
        return FAKE_KEY;
      },
    };
    const error = syncErrorFrom(() => createChatClient({
      baseUrl: BASE_URL,
      customModels: [entry],
      vault,
      budget: createBudget(null),
      fetchImpl: fake.fetchImpl,
    }));
    assert.ok(error instanceof Error, 'a bad custom model was accepted');
    assert.equal(Object.values(CUSTOM_MODEL_REASONS).includes(error.message), true);
    assert.equal(fake.calls.length, 0);
    assert.equal(keyReads, 0);
  }
});

test('two custom models with the same name are refused before any fetch', () => {
  const twin = { ...CUSTOM_MODEL, base_url: 'https://other.example.net/v1' };
  const fake = makeFakeFetch([replyWith('ok')]);
  const error = syncErrorFrom(() => createChatClient({
    baseUrl: BASE_URL,
    customModels: [CUSTOM_MODEL, twin],
    vault: createTokenVault(),
    budget: createBudget(null),
    fetchImpl: fake.fetchImpl,
  }));
  assert.equal(error.message, CUSTOM_MODEL_REASONS.duplicateName);
  assert.equal(fake.calls.length, 0);
});

test('a custom model named like a built-in model is refused before any fetch or key read', () => {
  const twin = { name: 'test-model', base_url: 'https://llm.example.org/v1', model: 'remote-model' };
  const fake = makeFakeFetch([replyWith('ok')]);
  let keyReads = 0;
  const vault = {
    get() {
      keyReads += 1;
      return FAKE_KEY;
    },
  };
  const error = syncErrorFrom(() => createChatClient({
    baseUrl: BASE_URL,
    customModels: [twin],
    builtInModels: ['test-model', 'other-model'],
    vault,
    budget: createBudget(null),
    fetchImpl: fake.fetchImpl,
  }));
  assert.equal(error.message, CUSTOM_MODEL_REASONS.duplicateName);
  assert.equal(fake.calls.length, 0);
  assert.equal(keyReads, 0);
});

test('look-alike hosts and plain http for the built-in API are refused before any fetch', () => {
  const lookAlikes = [
    'http://api.tokenfactory.nebius.com/v1/',
    'https://api.tokenfactory.nebius.com.evil.example/v1/',
    'https://evil.example/v1/',
  ];
  for (const baseUrl of lookAlikes) {
    const fake = makeFakeFetch([replyWith('ok')]);
    const error = syncErrorFrom(() => createChatClient({
      baseUrl,
      vault: createTokenVault(),
      budget: createBudget(null),
      fetchImpl: fake.fetchImpl,
    }));
    assert.equal(error.message, WRONG_ADDRESS);
    assert.equal(fake.calls.length, 0);
  }
});

// Redirects are turned into errors so the key cannot be forwarded to another origin.
test('requests ask fetch not to follow redirects, so a redirect cannot reach another origin', async () => {
  const { client, calls } = makeClient({ script: [replyWith('ok')], customModels: [CUSTOM_MODEL] });
  await client.complete(sampleRequest({ model: 'test-model' }));
  assert.equal(calls[0].options.redirect, 'error');
});

// A single step has a hard cap on attempts, even with no budget limit.
test('MAX_ATTEMPTS_PER_STEP is one try plus the retries, and a step that keeps failing stops there', async () => {
  assert.equal(MAX_ATTEMPTS_PER_STEP, MAX_RETRIES + 1);
  assert.equal(MAX_ATTEMPTS_PER_STEP, 6);
  const fake = makeFakeFetch(Array.from({ length: MAX_ATTEMPTS_PER_STEP + 2 }, () => fakeResponse(500, {})));
  const vault = createTokenVault();
  vault.set(FAKE_KEY);
  const client = createChatClient({
    baseUrl: BASE_URL,
    vault,
    budget: createBudget(null),
    fetchImpl: fake.fetchImpl,
    sleep: async () => {},
  });
  const error = await errorFrom(client.complete(sampleRequest()));
  assert.match(error.message, new RegExp(`Gave up after ${MAX_ATTEMPTS_PER_STEP} tries`));
  assert.equal(fake.calls.length, MAX_ATTEMPTS_PER_STEP);
});

/** Return a promise that resolves after the given number of milliseconds. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
