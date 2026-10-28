// Pure functions that turn the per-model rate limits into plain text for the batch page and the pacing page.
// No DOM here, so the rules can be tested in node. A limit the site does not know is shown as "unknown" or
// "no published limit", never as 0, because a 0 would read as "this model allows no calls at all".
//
// Two kinds of entry reach these functions. The published table (site/data/rate_limits.json) has the console
// limits per model. The observed values (the "observed" key of the same file) are what the backend recorded from
// real replies, and they say where each number came from. An observed entry always wins over the table.

import { formatContext } from "./model-details.js";

const UNKNOWN = "unknown";
const NO_PUBLISHED_LIMIT = "no published limit";
const NOT_RECORDED = "not recorded";
const SOURCE_FROM_TABLE = "from the console table";
const SOURCE_FROM_HEADERS = "read from the provider's reply headers";
const SOURCE_DEFAULT = "default: unknown model";
const SOURCE_UNKNOWN_KIND = "source not recorded";
const SOURCE_FILE_MISSING = "the rate limits file could not be read";

/**
 * Return the limit of one model as "600 req/min · 400K tok/min". The counts use K and M the same way the context
 * window does. A model with no entry gives "no published limit", so an absent number is never shown as 0.
 */
export function formatRateLimit(entry) {
  if (!isObject(entry)) {
    return NO_PUBLISHED_LIMIT;
  }
  const requests = formatRateValue(entry.requests_per_minute);
  const tokens = formatRateValue(entry.tokens_per_minute);
  return `${requests} req/min · ${tokens} tok/min`;
}

/**
 * Return where a limit came from, for a tooltip or a subtitle. "headers" means the reply headers, "table" (or an
 * entry with no source field, which is a published table row) means the console table, and "default" means the
 * model is not known, so a low default is used. An entry with no model at all is also a default.
 */
export function rateLimitSourceText(entry) {
  if (!isObject(entry)) {
    return SOURCE_DEFAULT;
  }
  if (entry.source === "headers") {
    return SOURCE_FROM_HEADERS;
  }
  if (entry.source === "default") {
    return SOURCE_DEFAULT;
  }
  if (entry.source === "table" || entry.source === undefined) {
    return SOURCE_FROM_TABLE;
  }
  return SOURCE_UNKNOWN_KIND;
}

/**
 * Return the text and the source line for one model row on the batch page. When the table could not be read at all,
 * the row says "unknown" and names the file, so a missing file is not mistaken for a model with no limit.
 */
export function rateLimitRowFor(table, modelId) {
  if (!isObject(table)) {
    return { text: UNKNOWN, source: SOURCE_FILE_MISSING };
  }
  const entry = lookupModel(table.models, modelId);
  return { text: formatRateLimit(entry), source: rateLimitSourceText(entry) };
}

/**
 * Return one row per model for the pacing page's table: the model, its requests and tokens per minute, where the
 * numbers came from, and the observed in-flight cap and latency. The observed entry is used when there is one, and
 * its numbers are the last ones the backend recorded. Table models come first, in file order, then any model that
 * only has observed data. Missing observed data gives "not recorded", never a guessed number.
 */
export function pacingRows(table, observed) {
  const tableModels = isObject(table) && isObject(table.models) ? table.models : {};
  const observedModels = isObject(observed) ? observed : {};
  const names = unionOfNames(Object.keys(tableModels), Object.keys(observedModels));
  return names.map((name) => pacingRow(name, lookupModel(tableModels, name), lookupModel(observedModels, name)));
}

/** Return one table row for a model, using its observed entry when there is one. */
function pacingRow(name, tableEntry, observedEntry) {
  // A name with a broken table entry falls back to an empty entry, so its numbers show "unknown" instead of crashing.
  const entry = observedEntry ?? tableEntry ?? {};
  return {
    model: name,
    requestsPerMinute: formatRateValue(entry.requests_per_minute),
    tokensPerMinute: formatRateValue(entry.tokens_per_minute),
    source: rateLimitSourceText(entry),
    inFlightCap: observedText(observedEntry, observedEntry?.in_flight_cap, formatCount),
    latency: observedText(observedEntry, observedEntry?.latency_seconds, formatSeconds),
  };
}

/**
 * Return the text for one observed number. With no observed entry at all the text is "not recorded". With an entry,
 * a value that is not a positive number is "unknown".
 */
function observedText(observedEntry, value, format) {
  if (observedEntry === null) {
    return NOT_RECORDED;
  }
  return isPositiveNumber(value) ? format(value) : UNKNOWN;
}

/**
 * Return a count such as a requests or tokens per minute, with K and M as the context window uses them. Any value
 * that is not a positive number is "unknown", so a missing count is never shown as 0.
 */
function formatRateValue(value) {
  // formatContext already rounds down, shows small counts exactly and gives "unknown" for a missing number.
  return formatContext(value);
}

/** Return a count of calls in flight at once, such as "14". */
function formatCount(value) {
  return String(Math.floor(value));
}

/** Return a latency in seconds with two decimals, such as "1.25 s". */
function formatSeconds(value) {
  return `${value.toFixed(2)} s`;
}

/**
 * Return the entry for one model id, or null. Only the model's own key counts, so a name such as "constructor"
 * does not pick up a property of the object. A missing map gives null.
 */
function lookupModel(models, modelId) {
  if (!isObject(models) || !Object.hasOwn(models, modelId)) {
    return null;
  }
  return isObject(models[modelId]) ? models[modelId] : null;
}

/** Return the names from the first list, then the names only in the second list, keeping each name once. */
function unionOfNames(firstNames, secondNames) {
  const seen = new Set(firstNames);
  const extra = secondNames.filter((name) => !seen.has(name));
  return [...firstNames, ...extra];
}

/** Return true for a plain object, which is what a JSON entry is. Null, arrays and text are refused. */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return true for a finite number above zero. Strings and null are refused. */
function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
