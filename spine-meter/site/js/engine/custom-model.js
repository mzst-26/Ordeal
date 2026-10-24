// Checks a custom model that the user adds in the browser: an OpenAI-compatible endpoint with a name.
// The rules match model_client.py (is_safe_custom_url and custom_route), except the key variable name,
// which only the command line uses: the web page takes the key as typed. Pure functions only:
// no network calls and no DOM work.

const HTTPS_PREFIX = "https://";
// The text fields a custom model must fill in. The key is typed in on the page, so it is not listed here.
const REQUIRED_FIELDS = ["name", "base_url", "model"];
const MODEL_NAME_MAX_LENGTH = 200;
const KEY_PREFIX = "v1.";
const KEY_MIN_LENGTH = 40;

/** The fixed reasons that validateCustomModel gives. None of them repeats the user's text. */
export const CUSTOM_MODEL_REASONS = Object.freeze({
  notObject: "A custom model must be an object with a name, a base URL and a model name.",
  blankField: "A custom model needs a name, a base URL and a model name, and none of them can be empty.",
  url: "The base URL must start with https:// and have no user name, password, query, fragment or control character.",
  duplicateName: "Another model already uses this name. Choose a different name.",
});

/** The fixed reasons that modelNameProblem gives for a typed model name. None of them repeats the text. */
export const MODEL_NAME_REASONS = Object.freeze({
  tooLong: "A model name can be at most 200 characters. Check the name and try again.",
  keyShaped: "That text looks like an API key, not a model name, so it was not added.",
});

/** Return true when the text has a control character: a code below 32, or 127. */
function hasControlCharacter(text) {
  return text.split("").some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

/** Return true for an https URL with a host, no user name or password, and no query string or fragment. */
export function isSafeCustomUrl(url) {
  if (typeof url !== "string" || !url.startsWith(HTTPS_PREFIX) || url.includes("?") || url.includes("#")) {
    return false;
  }
  // A trailing newline or other control character is refused here, before WHATWG URL can strip it.
  if (hasControlCharacter(url)) {
    return false;
  }
  // The authority (user name, password and host) ends at the first slash, question mark or hash, as urlsplit reads it.
  // WHATWG URL would read "https:///v1" as host "v1", so an empty authority is refused here.
  const authority = url.slice(HTTPS_PREFIX.length).split(/[/?#]/)[0];
  if (authority === "" || authority.includes("@")) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname !== "";
  } catch {
    return false;
  }
}

/** Return true for text shaped like an API key: v1. and 40 or more characters after it, or the word Bearer. */
function looksLikeKey(name) {
  const afterPrefix = name.length - KEY_PREFIX.length;
  return (name.startsWith(KEY_PREFIX) && afterPrefix >= KEY_MIN_LENGTH) || /bearer /i.test(name);
}

/**
 * Return the fixed reason a typed model name must be refused, or null when it may be used. Checked before the
 * name is added, so a key typed into the model box is never kept, shown or sent.
 */
export function modelNameProblem(name) {
  if (name.length > MODEL_NAME_MAX_LENGTH) {
    return MODEL_NAME_REASONS.tooLong;
  }
  return looksLikeKey(name) ? MODEL_NAME_REASONS.keyShaped : null;
}

/** Return the reason a custom model entry is not allowed, or null when it is allowed. */
function findProblem(entry, takenNames) {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return CUSTOM_MODEL_REASONS.notObject;
  }
  const blank = REQUIRED_FIELDS.some((field) => typeof entry[field] !== "string" || entry[field].trim() === "");
  if (blank) {
    return CUSTOM_MODEL_REASONS.blankField;
  }
  if (!isSafeCustomUrl(entry.base_url)) {
    return CUSTOM_MODEL_REASONS.url;
  }
  if (takenNames.includes(entry.name)) {
    return CUSTOM_MODEL_REASONS.duplicateName;
  }
  return null;
}

/**
 * Check a custom model before any call is made. Returns { ok: true }, or { ok: false, reason } where reason
 * is one of CUSTOM_MODEL_REASONS. takenNames lists the names that other models already use.
 */
export function validateCustomModel(entry, takenNames = []) {
  const reason = findProblem(entry, takenNames);
  return reason === null ? { ok: true } : { ok: false, reason };
}

/** Return the host (name and optional port) of a base URL that passes isSafeCustomUrl, or null when it does not. */
export function hostOfCustomUrl(url) {
  return isSafeCustomUrl(url) ? new URL(url).host : null;
}
