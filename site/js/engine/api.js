// Chat client for the platform the visitor chose, and the model-list check for the same platform. It runs in the
// browser and reads the key from the token vault. The key is sent only to the chosen platform's own address.

import { isSafeCustomUrl, validateCustomModel } from './custom-model.js';
import { createModelLimiter } from './limiter.js';

const MAX_BACKOFF_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 120000;
const NO_KEY_MESSAGE = 'No API key is set. Add your key first.';
const OTHER_PLATFORM_KEY_MESSAGE = 'The saved key belongs to another platform. Enter the key for this platform.';
const KEY_REFUSED_MESSAGE = 'The key was refused. Check the key and try again.';
const STOPPED_MESSAGE = 'Stopped by you.';
const NO_TEXT_MESSAGE = 'The reply had no text.';
const NETWORK_MESSAGE = 'A network problem stopped the request. Check your connection and try again.';
const TIMEOUT_MESSAGE = 'The request timed out.';
const WRONG_ADDRESS_MESSAGE = 'The API address is not the one this site is allowed to use.';
const CUSTOM_REFUSED_MESSAGE = 'Custom endpoints cannot be used yet. Each one needs its own key first.';
const NO_MODEL_LIST_MESSAGE = 'The service sent no model list.';
// The key must only ever go to the chosen platform's own host. The address is built from the platform in
// platformAddressFor, so there is no fixed host in this file.
// The retries the client makes after a failed try. Each try is one HTTP attempt.
export const MAX_RETRIES = 5;
// One try plus the retries, so one step makes at most this many HTTP attempts. The batch page states this number.
export const MAX_ATTEMPTS_PER_STEP = MAX_RETRIES + 1;
// Calls in flight to one model at once, unless the page sets another value. It keeps each model under its provider rate limit.
export const DEFAULT_PER_MODEL_LIMIT = 4;

// The log used when the caller gives none: it keeps nothing.
const NO_LOG = { record() {} };

/** Thrown when a run has used up its call budget. */
export class BudgetExhausted extends Error {
  constructor() {
    super('The call limit for this run has been reached.');
    this.name = 'BudgetExhausted';
  }
}

/** Thrown when the service refuses the key (HTTP 401 or 403). The batch must stop, not retry. */
export class KeyRefused extends Error {
  constructor() {
    super(KEY_REFUSED_MESSAGE);
    this.name = 'KeyRefused';
  }
}

/** Create a counter of HTTP attempts. A limit of null means there is no limit. */
export function createBudget(limit) {
  let count = 0;
  return {
    limit,
    /** Count one attempt. Throws BudgetExhausted when the limit is already reached. */
    spend() {
      if (limit !== null && count >= limit) throw new BudgetExhausted();
      count += 1;
    },
    /** Return how many attempts have been counted. */
    used() {
      return count;
    },
    /** Return how many attempts are left, or null when there is no limit. */
    remaining() {
      return limit === null ? null : limit - count;
    },
  };
}

/** Return the wait before retry number attempt (0 first): 1, 2, 4, ... seconds, capped at 60. */
export function backoffSeconds(attempt) {
  return Math.min(2 ** attempt, MAX_BACKOFF_SECONDS);
}

/** Return true if a failed attempt is worth another try: 429, 5xx, or a network problem or timeout. */
export function isRetryable(status, networkError) {
  if (networkError) return true;
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}

/**
 * Return a promise that resolves after the given number of seconds.
 * It rejects at once with the stop message if the signal aborts first.
 */
export function defaultSleep(seconds, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(STOPPED_MESSAGE));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, seconds * 1000);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Return the URL with a trailing slash added when it has none. */
function withTrailingSlash(url) {
  return url.endsWith('/') ? url : url + '/';
}

/**
 * Throw the fixed message unless every custom model passes validateCustomModel. A name must not equal a built-in
 * model name, or its calls would be mistaken for the built-in model. The reason is fixed text, never the visitor's.
 */
function checkCustomModels(customModels, builtInModels) {
  const takenNames = [...builtInModels];
  for (const entry of customModels) {
    const check = validateCustomModel(entry, takenNames);
    if (!check.ok) throw new Error(check.reason);
    takenNames.push(entry.name);
  }
}

/** Return true when the model name is the name of one of the custom models. */
function isCustomModel(model, customModels) {
  return customModels.some((entry) => entry.name === model);
}

/** Return the model id the API expects: a custom model's own model field, or the name itself for a built-in model. */
export function apiModelFor(model, customModels = []) {
  const entry = customModels.find((item) => item.name === model);
  return entry ? entry.model : model;
}

/** Return the JSON body of one chat request. The model is the API model id, not the display name. */
export function chatBody(apiModel, { messages, temperature, maxTokens }) {
  return JSON.stringify({ model: apiModel, messages, temperature, max_tokens: maxTokens });
}

/**
 * Return the full address for one API path on a platform, such as "chat/completions" or "models".
 * It throws the fixed address message unless the platform is a browser platform with a safe https base URL.
 * Every address the key is sent to is built here, so the key can only go to that platform's own host.
 */
export function platformAddressFor(platform, path) {
  const base = platform && platform.browser === true ? platform.base_url : null;
  if (typeof base !== 'string' || !isSafeCustomUrl(base)) throw new Error(WRONG_ADDRESS_MESSAGE);
  return withTrailingSlash(base) + path;
}


/** Return true for a 2xx status. */
function isSuccess(status) {
  return status >= 200 && status < 300;
}

/** Describe a failed status in plain words. The response body is never included. */
function describeStatus(status) {
  if (status === 429) return `The service is limiting requests (HTTP ${status}).`;
  if (status >= 500 && status <= 599) return `The service returned an error (HTTP ${status}).`;
  return `The service rejected the request (HTTP ${status}).`;
}

/** Return the reply text from a parsed reply, or null when it is missing. */
function readReplyText(json) {
  const choice = json && json.choices ? json.choices[0] : undefined;
  const content = choice && choice.message ? choice.message.content : undefined;
  return typeof content === 'string' ? content : null;
}

/** Parse the JSON body of a response, or return null if the body is not valid JSON. */
async function readJson(response) {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Throw the stop message if the caller has aborted. */
function throwIfStopped(signal) {
  if (signal && signal.aborted) throw new Error(STOPPED_MESSAGE);
}

/**
 * Wait for a back-off sleep, but reject at once when the caller aborts,
 * even if the sleep itself ignores the signal.
 */
function waitUnlessStopped(pendingSleep, signal) {
  throwIfStopped(signal);
  if (!signal) return pendingSleep;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error(STOPPED_MESSAGE));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(pendingSleep)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Turn an error from fetch into a retry decision. Throws if the caller aborted. */
function classifyFailure(error, signal) {
  throwIfStopped(signal);
  if (error && error.name === 'AbortError') {
    return { ok: false, retryable: true, status: null, message: TIMEOUT_MESSAGE };
  }
  return { ok: false, retryable: true, status: null, message: NETWORK_MESSAGE };
}

/** Turn a completed HTTP response into a reply, a retry decision, or a final error. */
function interpretResponse(status, json) {
  if (isSuccess(status)) {
    const text = readReplyText(json);
    if (text === null) throw new Error(NO_TEXT_MESSAGE);
    return { ok: true, text, status };
  }
  if (status === 401 || status === 403) throw new KeyRefused();
  return { ok: false, retryable: isRetryable(status, false), status, message: describeStatus(status) };
}

/**
 * Make one HTTP attempt. Returns {ok, text} or {ok: false, retryable, message}.
 * Throws for errors that must not be retried, including any endpoint other than the built-in chat endpoint.
 */
async function attemptOnce(context) {
  throwIfStopped(context.signal);
  context.budget.spend();
  context.log.record('request-attempt', { model: context.model, attempt: context.attempt + 1 });

  // The timer and the caller's signal both abort this one request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs);
  const stopWithCaller = () => controller.abort();
  if (context.signal) context.signal.addEventListener('abort', stopWithCaller);

  let response;
  let json = null;
  try {
    // Keep fetch unbound: browsers reject calls where `this` is another object.
    const send = context.fetchImpl;
    response = await send(context.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + context.token,
      },
      body: context.body,
      signal: controller.signal,
      // A redirect could send the request to another origin, which the check above cannot see, so it is refused.
      redirect: 'error',
    });
    if (isSuccess(response.status)) json = await readJson(response);
  } catch (error) {
    const failure = classifyFailure(error, context.signal);
    context.log.record('request-result', { model: context.model, attempt: context.attempt + 1, ...describeOutcome(failure) });
    return failure;
  } finally {
    clearTimeout(timer);
    if (context.signal) context.signal.removeEventListener('abort', stopWithCaller);
  }
  try {
    const outcome = interpretResponse(response.status, json);
    context.log.record('request-result', { model: context.model, attempt: context.attempt + 1, ...describeOutcome(outcome) });
    return outcome;
  } catch (error) {
    context.log.record('request-refused', { model: context.model, attempt: context.attempt + 1, status: response.status });
    throw error;
  }
}

/** Return the fields of an attempt's outcome for the log: the status, whether it worked, and the plain message. */
function describeOutcome(outcome) {
  return { ok: outcome.ok, status: outcome.status, retryable: Boolean(outcome.retryable), message: outcome.message ?? null };
}

/**
 * Ask the chosen platform for the ids of the models it offers, sorted. The key goes only to that platform's
 * /models address, which is built by the same check as the chat address. Redirects are refused. Returns the ids,
 * or throws a plain message. The key is never part of a message.
 */
export async function fetchModelIds({ platform, token, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  // The address is checked before the key is used, so a bad platform never sees the key.
  const url = platformAddressFor(platform, 'models');
  if (typeof token !== 'string' || token === '') throw new Error(NO_KEY_MESSAGE);

  // The timer aborts a request that hangs, so the page never waits forever on a silent service.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let json = null;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token },
      signal: controller.signal,
      redirect: 'error',
    });
    if (isSuccess(response.status)) json = await readJson(response);
  } catch (error) {
    throw new Error(error && error.name === 'AbortError' ? TIMEOUT_MESSAGE : NETWORK_MESSAGE);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) throw new KeyRefused();
  if (!isSuccess(response.status)) throw new Error(describeStatus(response.status));
  return readModelIds(json);
}

/** Return the sorted model ids from a parsed model list. Throws a plain message when the list is missing. */
function readModelIds(json) {
  if (!json || !Array.isArray(json.data)) throw new Error(NO_MODEL_LIST_MESSAGE);
  return json.data
    .map((model) => (model && typeof model.id === 'string' ? model.id : null))
    .filter((id) => id !== null)
    .sort();
}

/**
 * Create a chat client. complete() sends one chat request to the chosen platform and retries transient failures.
 * A custom model is refused with a fixed message until it has its own key, so no request is made for it.
 * @param {object} options - platform (a browser platform from providers.json), customModels, builtInModels, vault,
 *   budget, and optional maxRetries, timeoutMs, fetchImpl, sleep. builtInModels lists the built-in model names
 *   that no custom model may use.
 */
export function createChatClient({
  platform,
  customModels = [],
  builtInModels = [],
  vault,
  budget,
  maxRetries = MAX_RETRIES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  sleep = defaultSleep,
  log = NO_LOG,
  perModelLimit = DEFAULT_PER_MODEL_LIMIT,
}) {
  // Check the address before any request is made and before the key is read. The chat address comes from the platform.
  const chatUrl = platformAddressFor(platform, 'chat/completions');
  checkCustomModels(customModels, builtInModels);
  const limiter = createModelLimiter(perModelLimit);

  /** Send one chat request and return the reply text. Throws a plain message on failure. */
  async function complete({ model, messages, temperature, maxTokens, signal }) {
    // A custom model is refused before the key is read, so neither the key nor a request goes to its address.
    if (isCustomModel(model, customModels)) throw new Error(CUSTOM_REFUSED_MESSAGE);
    const token = vault.get();
    if (token === null) throw new Error(NO_KEY_MESSAGE);
    // The key was entered for one platform. It is refused for any other, so it never goes to the wrong address.
    if (vault.platformId() !== platform.id) throw new Error(OTHER_PLATFORM_KEY_MESSAGE);

    const context = {
      url: chatUrl,
      body: chatBody(apiModelFor(model, customModels), { messages, temperature, maxTokens }),
      token,
      signal,
      timeoutMs,
      budget,
      fetchImpl,
      model,
      attempt: 0,
      log,
    };

    // Each attempt takes a place for its model. A wait before a retry holds no place, so other calls can run.
    let outcome = await limiter.run(model, () => attemptOnce(context));
    while (!outcome.ok && outcome.retryable && context.attempt < maxRetries) {
      const seconds = backoffSeconds(context.attempt);
      log.record('retry-wait', { model, after_attempt: context.attempt + 1, seconds });
      await waitUnlessStopped(sleep(seconds, signal), signal);
      context.attempt += 1;
      outcome = await limiter.run(model, () => attemptOnce(context));
    }

    if (!outcome.ok) {
      if (outcome.retryable) log.record('request-gave-up', { model, tries: context.attempt + 1 });
      const suffix = outcome.retryable ? ` Gave up after ${context.attempt + 1} tries.` : '';
      throw new Error(outcome.message + suffix);
    }
    return outcome.text;
  }

  return { complete };
}
