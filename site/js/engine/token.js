// Holder for the user's API key. The key is kept in memory, and is written to this browser's local storage only
// when the user asks for it to be remembered. Nothing here writes the key to the URL, the DOM or the console.

// Length limits for a key, counted after trimming. Keys in use range from short to long, so the
// upper limit is generous. The check only has to catch blank values and pasted sentences.
export const MIN_KEY_LENGTH = 20;
export const MAX_KEY_LENGTH = 512;
const MASK_MIN_LENGTH = 12;
const SHORT_MASK = '••••••';
// Allowed characters: letters, digits, and - _ . + / =. The last four cover base64-style keys.
// Whitespace is not allowed, so spaces, quotes and line breaks inside the value are rejected.
export const KEY_CHARACTERS_PATTERN = /^[A-Za-z0-9._+/=-]+$/;
const BAD_KEY_MESSAGE = 'That does not look like an API key. Check it and try again.';

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

/**
 * Create a vault that keeps one key in a closure variable. With a storage object, a key saved with
 * remember: true is also kept there, so it is still there after a reload. Storage errors are never shown.
 */
export function createTokenVault({ storage = null } = {}) {
  let storedText = null;

  /** Read the saved key from storage. Returns null when there is none, or when it is not a plausible key. */
  function readRemembered() {
    try {
      const text = storage ? storage.getItem(REMEMBER_STORAGE_NAME) : null;
      return isPlausibleToken(text) ? text.trim() : null;
    } catch {
      return null;
    }
  }

  /** Write or remove the saved key. A storage error is ignored, so the key still works for this tab. */
  function writeRemembered(text) {
    try {
      if (!storage) return;
      if (text === null) storage.removeItem(REMEMBER_STORAGE_NAME);
      else storage.setItem(REMEMBER_STORAGE_NAME, text);
    } catch {
      // The key stays in memory for this tab only.
    }
  }

  /** Return the key held in memory, loading a remembered key from storage the first time. */
  function current() {
    if (storedText === null) storedText = readRemembered();
    return storedText;
  }

  return {
    /**
     * Store the key. Throws a plain message if it does not look like a key. With remember: true the key is
     * also saved in storage; with remember: false any saved copy is removed, so the key lasts for this tab only.
     */
    set(text, { remember = false } = {}) {
      if (!isPlausibleToken(text)) throw new Error(BAD_KEY_MESSAGE);
      storedText = text.trim();
      writeRemembered(remember ? storedText : null);
    },
    /** Return the stored key, or null when none is set. A key saved in storage is loaded on first use. */
    get() {
      return current();
    },
    /** Return true when a key is stored, in memory or in storage. */
    has() {
      return current() !== null;
    },
    /** Return true when the key is saved in storage, so it survives a reload. */
    remembered() {
      return readRemembered() !== null;
    },
    /** Forget the stored key, in memory and in storage. */
    clear() {
      storedText = null;
      writeRemembered(null);
    },
    /** Return the masked key for display, or an empty string when none is set. */
    masked() {
      const text = current();
      return text === null ? '' : maskToken(text);
    },
  };
}

// The name the key is saved under in this browser's local storage.
export const REMEMBER_STORAGE_NAME = 'ordeal.nebius-api-key';

// One shared vault for the pages. It saves a key only when the user asks it to.
export const vault = createTokenVault({ storage: browserStorage() });
