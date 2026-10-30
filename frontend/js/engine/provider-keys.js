// Keeps one API key per provider in the browser. A key is held in memory by default. It is written to this browser's
// local storage only when the visitor ticks Remember, the same rule token.js follows for the single key. Each key
// is kept under its provider id, so a key entered for one provider is never handed to another.
// Nothing here writes a key to the URL, the DOM or the console.
import {
  browserStorage, isPlausibleToken, maskToken, REMEMBER_STORAGE_NAME, REMEMBER_PLATFORM_NAME,
} from './token.js';

// The name the per-provider keys are saved under in this browser's local storage. The value is a JSON object that
// maps each provider id to its key. Only the keys the visitor asked to remember are kept there.
export const PROVIDER_KEYS_STORAGE_NAME = 'ordeal.provider-keys';

// A provider id is lower-case letters, digits and dashes, as in providers.json (such as "groq" or "lm-studio").
// Checking the shape keeps a slot name predictable and stops a stray value from becoming a storage key.
const PROVIDER_ID_PATTERN = /^[a-z0-9-]+$/;

const BAD_ID_MESSAGE = 'The provider id must be lower-case letters, digits or dashes, such as groq.';
const BAD_KEY_MESSAGE = 'That does not look like an API key. Check it and try again.';
const NO_PROVIDER_MESSAGE = 'The key needs the provider it belongs to.';
const OTHER_PROVIDER_MESSAGE = 'That key belongs to another provider, so it was not saved for this one.';

/** Return true when the text is a provider id the store accepts. */
export function isProviderId(text) {
  return typeof text === 'string' && PROVIDER_ID_PATTERN.test(text);
}

/**
 * Read the key the old single vault saved, with the provider id it was saved for. Returns null when there is none, or
 * when the saved values do not look like a key and a provider id, so a damaged value is left alone.
 */
function readOldSingleKey(storage) {
  try {
    const text = storage ? storage.getItem(REMEMBER_STORAGE_NAME) : null;
    const providerId = storage ? storage.getItem(REMEMBER_PLATFORM_NAME) : null;
    if (!isPlausibleToken(text) || !isProviderId(providerId)) return null;
    return { providerId, text: text.trim() };
  } catch {
    return null;
  }
}

/** Remove the two values the old single vault saved. A storage error is ignored, because the key was already moved. */
function removeOldSingleKey(storage) {
  try {
    storage.removeItem(REMEMBER_STORAGE_NAME);
    storage.removeItem(REMEMBER_PLATFORM_NAME);
  } catch {
    // Nothing else to do: the moved key is saved under the per-provider name.
  }
}

/**
 * Read the saved map of provider ids to keys from storage. Returns an empty object when nothing is saved or the
 * saved text cannot be read. Entries whose key does not look like a key are skipped, so a damaged value is ignored.
 */
function readSavedMap(storage) {
  try {
    const raw = storage ? storage.getItem(PROVIDER_KEYS_STORAGE_NAME) : null;
    const parsed = raw === null ? {} : JSON.parse(raw);
    const kept = {};
    for (const [providerId, text] of Object.entries(parsed)) {
      if (isProviderId(providerId) && isPlausibleToken(text)) kept[providerId] = text.trim();
    }
    return kept;
  } catch {
    return {};
  }
}

/**
 * Create a store that keeps one key for each provider id. With a storage object, the keys saved with remember on are
 * also kept there, so they are still there after a reload. Storage errors are ignored, so the keys still work for
 * this page. The store never logs anything.
 */
export function createProviderKeys({ storage = null } = {}) {
  // Each entry is { text, remembered }. The map is filled from storage the first time it is read.
  const entries = new Map();
  let loaded = false;

  /**
   * Move a key from the old single vault into this store. The old key is taken only when this store has no key for that
   * provider yet, so a newer key is never replaced. The old copy is removed only after the move is saved, so a failed
   * save never loses the key.
   */
  function adoptOldSingleKey() {
    const old = readOldSingleKey(storage);
    if (old === null || entries.has(old.providerId)) return;
    entries.set(old.providerId, { text: old.text, remembered: true });
    if (persist()) removeOldSingleKey(storage);
  }

  /** Fill the map from storage once. Keys found there are marked as remembered, then an old single-vault key is moved in. */
  function load() {
    if (loaded) return;
    loaded = true;
    for (const [providerId, text] of Object.entries(readSavedMap(storage))) {
      entries.set(providerId, { text, remembered: true });
    }
    adoptOldSingleKey();
  }

  /**
   * Write only the remembered keys to storage. When none are remembered the saved value is removed. Returns true when the
   * write worked, and false when storage refused it, so the caller keeps any old copy until the new one is saved.
   */
  function persist() {
    try {
      if (!storage) return false;
      const remembered = {};
      for (const [providerId, entry] of entries) {
        if (entry.remembered) remembered[providerId] = entry.text;
      }
      if (Object.keys(remembered).length === 0) {
        storage.removeItem(PROVIDER_KEYS_STORAGE_NAME);
      } else {
        storage.setItem(PROVIDER_KEYS_STORAGE_NAME, JSON.stringify(remembered));
      }
      return true;
    } catch {
      // The keys stay in memory for this page only.
      return false;
    }
  }

  return {
    /**
     * Store the key for one provider. Throws a plain message if the id or the key is not valid. With remember: true the
     * key is also saved in storage; with remember: false any saved copy for this provider is removed.
     */
    set(providerId, text, { remember = false } = {}) {
      load();
      if (!isProviderId(providerId)) throw new Error(BAD_ID_MESSAGE);
      if (!isPlausibleToken(text)) throw new Error(BAD_KEY_MESSAGE);
      entries.set(providerId, { text: text.trim(), remembered: remember === true });
      persist();
    },
    /** Return the key for this provider, or null when none is set. */
    get(providerId) {
      load();
      const entry = entries.get(providerId);
      return entry === undefined ? null : entry.text;
    },
    /** Return true when a key is set for this provider, in memory or in storage. */
    has(providerId) {
      load();
      return entries.has(providerId);
    },
    /** Return true when this provider's key is saved in storage, so it survives a reload. */
    remembered(providerId) {
      load();
      const entry = entries.get(providerId);
      return entry !== undefined && entry.remembered;
    },
    /** Forget the key for this provider, in memory and in storage. The other providers keep theirs. */
    clear(providerId) {
      load();
      entries.delete(providerId);
      persist();
    },
  };
}

// The one store for the batch page's per-provider keys. It saves a key only when the visitor asks it to.
export const providerKeys = createProviderKeys({ storage: browserStorage() });

/** Return the key slot for one provider from the shared store. The batch page uses this for its platform and key. */
export function slotFor(providerId) {
  return keySlotFor(providerKeys, providerId);
}

/** Return the key slot for a platform object, or null when no platform is chosen. Used by the platform panel. */
export function slotForPlatform(platform) {
  return platform === null || platform === undefined ? null : slotFor(platform.id);
}

/**
 * Return the key slot for one provider: an object with the same methods as the single-key vault in token.js (get, has,
 * set, clear, platformId, remembered, masked). Each slot is tied to its provider id. Passing the slot where the vault
 * is expected means the chat client and the key dialog need no change: a slot only reads or writes its own provider.
 */
export function keySlotFor(keys, providerId) {
  return {
    /** Return this provider's key, or null when none is set. */
    get() {
      return keys.get(providerId);
    },
    /** Return true when this provider has a key set. */
    has() {
      return keys.has(providerId);
    },
    /** Return the id of the provider the stored key belongs to, or null when no key is set. */
    platformId() {
      return keys.has(providerId) ? providerId : null;
    },
    /**
     * Store a key for this provider only. The platform must name this provider, so a key typed for another one is refused.
     */
    set(text, { remember = false, platform = null } = {}) {
      if (typeof platform !== 'string' || platform === '') throw new Error(NO_PROVIDER_MESSAGE);
      if (platform !== providerId) throw new Error(OTHER_PROVIDER_MESSAGE);
      keys.set(providerId, text, { remember });
    },
    /** Forget this provider's key. */
    clear() {
      keys.clear(providerId);
    },
    /** Return true when this provider's key is saved in storage. */
    remembered() {
      return keys.remembered(providerId);
    },
    /** Return the masked key for display, or an empty string when none is set. */
    masked() {
      const text = keys.get(providerId);
      return text === null ? '' : maskToken(text);
    },
  };
}
