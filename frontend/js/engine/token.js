// Helpers for the user's API key: the length and character rules, the masked display, and the browser's local storage.
// The keys themselves are kept by provider-keys.js, one per provider. Nothing here writes a key to the URL, the DOM or
// the console.

// Length limits for a key, counted after trimming. Keys in use range from short to long, so the
// upper limit is generous. The check only has to catch blank values and pasted sentences.
export const MIN_KEY_LENGTH = 20;
export const MAX_KEY_LENGTH = 512;
const MASK_MIN_LENGTH = 12;
const SHORT_MASK = '••••••';
// Allowed characters: letters, digits, and - _ . + / =. The last four cover base64-style keys.
// Whitespace is not allowed, so spaces, quotes and line breaks inside the value are rejected.
export const KEY_CHARACTERS_PATTERN = /^[A-Za-z0-9._+/=-]+$/;

/**
 * Return true if text looks like an API key: 20 to 512 characters after trimming, and only key
 * characters with no spaces. The value itself is never shown to the user.
 */
export function isPlausibleToken(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < MIN_KEY_LENGTH || trimmed.length > MAX_KEY_LENGTH) return false;
  return KEY_CHARACTERS_PATTERN.test(trimmed);
}

/** Return a short form of the key for display, such as abc…wxyz. Short values show only dots. */
export function maskToken(text) {
  if (typeof text !== 'string' || text.length < MASK_MIN_LENGTH) return SHORT_MASK;
  return text.slice(0, 3) + '…' + text.slice(-4);
}

/** Return the browser's local storage, or null when this page cannot use it (no storage, or it is blocked). */
export function browserStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

// The two names the old single vault saved its remembered key under. The vault is gone: the per-provider store in
// provider-keys.js reads these names once, moves a key found there under its provider id, and then removes them.
export const REMEMBER_STORAGE_NAME = 'ordeal.nebius-api-key';
export const REMEMBER_PLATFORM_NAME = 'ordeal.api-key-platform';
