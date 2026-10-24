// Memory-only holder for the user's API key. Nothing here writes to storage, the URL, the DOM or the console.

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

/** Create a vault that keeps one key in a closure variable and nowhere else. */
export function createTokenVault() {
  let storedText = null;
  return {
    /** Store the key. Throws a plain message if it does not look like a key. */
    set(text) {
      if (!isPlausibleToken(text)) throw new Error(BAD_KEY_MESSAGE);
      storedText = text.trim();
    },
    /** Return the stored key, or null when none is set. */
    get() {
      return storedText;
    },
    /** Return true when a key is stored. */
    has() {
      return storedText !== null;
    },
    /** Forget the stored key. */
    clear() {
      storedText = null;
    },
    /** Return the masked key for display, or an empty string when none is set. */
    masked() {
      return storedText === null ? '' : maskToken(storedText);
    },
  };
}

// One shared vault for the pages.
export const vault = createTokenVault();
