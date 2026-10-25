// The platform list for the browser: which platforms a visitor may pick, how a typed model name or link is
// read, and how the chosen platform is remembered. The list itself is the shared file providers.json, which the
// export script copies into the site data folder, so the browser and the Python package read one list.
// Everything here is a pure function except the two storage helpers, which take the storage as a parameter.
// No network call is made here: the key is only ever used by api.js.

// Where the site copy of the shared list is requested from. The data folder is copied to dist/ at build time.
export const PLATFORMS_PATH = '/data/providers.json';
// The platform used when the visitor has not picked one. It is the platform the site started with.
export const DEFAULT_PLATFORM_ID = 'nebius';
// The name the platform choice is saved under in this browser's local storage. It holds only an id and a model name.
export const CHOICE_STORAGE_NAME = 'ordeal.platform-choice';

// The text before a model name that means "this model on Hugging Face", as in hf:org/name.
const HF_PREFIX = 'hf:';
// Text that starts like a file path. A hosted platform never serves a model from a file, so these are refused.
const FILE_PATH_PREFIXES = ['/', './', '../', '~'];
// How many close names to suggest when a model is not found, and how close a name must be to count.
export const SUGGESTION_COUNT = 5;
const SUGGESTION_CUTOFF = 0.6;

const LIST_MESSAGE = 'The platform list could not be read.';
const EMPTY_MESSAGE = 'Give a model id, such as org/name, or a link to the model page.';
const FILE_PATH_MESSAGE = 'That looks like a file path, not a model id. Give a model id such as org/name.';
const SPACE_MESSAGE = 'A model id cannot contain spaces. Check the id on the platform page.';
const BAD_LINK_MESSAGE = 'That link could not be read. Give a model id, or paste the full link.';

/** Return the platforms array from the parsed list file. Throws a plain message when the file has no such array. */
export function platformList(json) {
  if (!json || !Array.isArray(json.platforms)) throw new Error(LIST_MESSAGE);
  return json.platforms;
}

/** Load the shared list with the given loader (a function that takes a path and returns parsed JSON). */
export async function loadPlatforms(loadJson) {
  return platformList(await loadJson(PLATFORMS_PATH));
}

/** Return only the platforms marked browser: true. These are the only ones a visitor can pick. */
export function browserPlatforms(list) {
  return list.filter((platform) => platform.browser === true);
}

/**
 * Return the browser platforms that have a fixed address, so a key can be sent to them. The custom platform is
 * marked for the browser but has no address of its own yet, so it is left out of the picker.
 */
export function usablePlatforms(list) {
  return browserPlatforms(list).filter((platform) => typeof platform.base_url === 'string');
}

/**
 * Return the platforms a visitor may choose on the site: hosted inference platforms that are marked for the browser
 * and have a fixed address. Single-vendor APIs, local servers and the custom entry are left out on purpose. Every
 * place that offers or restores a choice uses this one list, so the picker and the saved choice always agree.
 */
export function selectablePlatforms(list) {
  return list.filter(
    (platform) => platform.kind === 'inference' && platform.browser === true && typeof platform.base_url === 'string',
  );
}

/** Return the platform with this id, or null when the list has no such id. */
export function findPlatform(list, id) {
  return list.find((platform) => platform.id === id) ?? null;
}

/**
 * Return the platform the visitor chose, or the default one. A saved id that is not selectable any more is ignored,
 * so an old choice can never send the key to a platform the picker does not offer. If the default is not selectable,
 * the first selectable platform is used. Returns null only when no platform is selectable at all.
 */
export function currentPlatform(list, choice) {
  const selectable = selectablePlatforms(list);
  const saved = choice ? findPlatform(selectable, choice.platformId) : null;
  return saved ?? findPlatform(selectable, DEFAULT_PLATFORM_ID) ?? selectable[0] ?? null;
}

// The words shown for each kind of platform on a card. A kind not listed here shows the fallback words.
const TYPE_WORDS = {
  inference: "Hosts many labs' models",
  'single-vendor': "Serves one maker's models",
  local: 'Runs on this computer',
  custom: 'Your own address',
};
const TYPE_FALLBACK = 'Not stated';
const KEY_NEEDED = "Needed, from the platform's sign-up page";
const KEY_NOT_NEEDED = 'Not needed';
const BROWSER_YES = 'Works in this page';
const BROWSER_NO = 'Needs a server, so not in this page';

/**
 * Return the short rows shown on a platform's card: its type, whether a key is needed, and whether it works in this
 * page. Each row is {label, value} with plain text, so the card can show it without any markup.
 */
export function platformFacts(platform) {
  // The site copy of the list has no key_env field (the export removes it). Only an explicit null means no key is
  // needed; any other value, or a missing field, means the visitor types a key, which is what the browser asks for.
  const keyNeeded = platform.key_env !== null;
  return [
    { label: 'Type', value: TYPE_WORDS[platform.kind] ?? TYPE_FALLBACK },
    { label: 'Key', value: keyNeeded ? KEY_NEEDED : KEY_NOT_NEEDED },
    { label: 'Browser', value: platform.browser === true ? BROWSER_YES : BROWSER_NO },
  ];
}

/**
 * Return the platform's sign-up address when it is a non-empty https address, otherwise null. Only https is allowed,
 * so the card never links to a plain or script address. A null result means the card shows no link.
 */
export function signupLink(platform) {
  const link = platform.signup;
  return typeof link === 'string' && link.startsWith('https://') ? link : null;
}

/** Return a result that refuses the text, with a plain reason. */
function refuse(reason) {
  return { ok: false, reason };
}

/** Return true when the text starts with http:// or https://, so it is read as a link. */
function isLink(text) {
  return text.startsWith('http://') || text.startsWith('https://');
}

/** Return true when the text starts like a file path or contains a backslash. */
function looksLikeFilePath(text) {
  return FILE_PATH_PREFIXES.some((prefix) => text.startsWith(prefix)) || text.includes('\\');
}

/**
 * Return the model id that a link to the platform's model page names. Only the path is kept, so the scheme,
 * host, query, fragment and trailing slashes are dropped. A link on any other host is refused, so a visitor
 * cannot be sent to a model page on a site the platform does not run.
 */
function modelFromLink(platform, link) {
  if (!platform.web_host) {
    return refuse(`${platform.name} has no model web page, so give a model id, not a link.`);
  }
  let url;
  try {
    url = new URL(link);
  } catch {
    return refuse(BAD_LINK_MESSAGE);
  }
  if (url.hostname !== platform.web_host) {
    return refuse(`That link is not on ${platform.web_host}. Give a model id, or a link to ${platform.web_host}.`);
  }
  // The pathname has no query or fragment, so only leading and trailing slashes need removing.
  const path = url.pathname.replace(/^\/+|\/+$/g, '');
  return path === '' ? refuse(EMPTY_MESSAGE) : { ok: true, model: path };
}

/**
 * Read what the visitor typed as a model id for this platform. Accepted: org/name, hf:org/name, and a link on the
 * platform's web host. Returns {ok: true, model} or {ok: false, reason}. The reason is fixed text, never the input.
 */
export function parseModelReference(platform, text) {
  const cleaned = typeof text === 'string' ? text.trim() : '';
  if (cleaned === '') return refuse(EMPTY_MESSAGE);

  let model = cleaned;
  if (isLink(cleaned)) {
    const linked = modelFromLink(platform, cleaned);
    if (!linked.ok) return linked;
    model = linked.model;
  } else {
    // The file check runs before the hf: prefix is removed, so a path can never sneak through as a prefix.
    if (!platform.local && looksLikeFilePath(cleaned)) return refuse(FILE_PATH_MESSAGE);
    if (model.startsWith(HF_PREFIX)) model = model.slice(HF_PREFIX.length).trim();
  }
  if (model === '') return refuse(EMPTY_MESSAGE);
  if (/\s/.test(model)) return refuse(SPACE_MESSAGE);
  return { ok: true, model };
}

/**
 * Return the model id from the platform's list that matches the wanted id. An exact match wins. Otherwise one
 * case-insensitive match is returned in the platform's spelling. If nothing matches, the result lists close ids.
 * This makes no request: the list is passed in by the caller.
 */
export function findModel(platform, wanted, available) {
  if (available.includes(wanted)) return { ok: true, model: wanted };
  const lowered = wanted.toLowerCase();
  const matches = available.filter((id) => id.toLowerCase() === lowered);
  if (matches.length === 1) return { ok: true, model: matches[0] };
  if (matches.length > 1) {
    return refuse(`'${wanted}' matches more than one model on ${platform.name}. Give the exact id.`);
  }
  return { ok: false, reason: `${platform.name} has no model named '${wanted}'.`, suggestions: closeModelNames(available, wanted) };
}

/**
 * Return up to five ids from the list that look like the wanted id, closest first. Each id is scored by how
 * few single-character edits separate it from the wanted id. This is a simple stand-in for Python's difflib.
 */
export function closeModelNames(available, wanted) {
  const scored = available
    .map((id) => ({ id, score: similarity(id, wanted) }))
    .filter((entry) => entry.score >= SUGGESTION_CUTOFF);
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, SUGGESTION_COUNT).map((entry) => entry.id);
}

/** Return a score from 0 to 1: 1 means the same text, ignoring case. Built from the edit distance. */
function similarity(a, b) {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a.toLowerCase(), b.toLowerCase()) / longest;
}

/** Return the number of single-character inserts, deletes and changes that turn one text into the other. */
function editDistance(a, b) {
  // One row of the table is kept at a time: row[j] is the distance between the first i characters of a and the first j of b.
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const change = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + change);
    }
    row = next;
  }
  return row[b.length];
}

/** Return the saved platform choice {platformId, model}, or null when none is saved or it cannot be read. */
export function readChoice(storage) {
  try {
    const raw = storage ? storage.getItem(CHOICE_STORAGE_NAME) : null;
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    const valid = typeof parsed.platformId === 'string' && typeof parsed.model === 'string';
    return valid ? { platformId: parsed.platformId, model: parsed.model } : null;
  } catch {
    return null;
  }
}

/** Save the platform choice. A storage error is ignored: the choice then lasts only for this page visit. */
export function writeChoice(storage, { platformId, model }) {
  try {
    if (storage) storage.setItem(CHOICE_STORAGE_NAME, JSON.stringify({ platformId, model }));
  } catch {
    // The choice is kept in the page for this visit only.
  }
}
