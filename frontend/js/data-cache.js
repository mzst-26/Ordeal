// Keeps each /data/*.json request for the life of the document. The three views (Gauntlet, Batch and Live) read
// the same files, so a file is fetched once and every view gets the same promise. A failed load is dropped from
// the cache, so the next view that asks gets a fresh try instead of a stored error.

/**
 * Return a cache with a loadJson(path) method. The first call for a path fetches it and reads the body as JSON.
 * Later calls for the same path return the same promise and do not fetch again. The fetch function is a
 * parameter so tests can count the requests without a network.
 */
export function createDataCache(fetchFn = fetch) {
  const entries = new Map();

  /**
   * Return a promise for the parsed JSON at path. It rejects on a network error or a non-OK status, and the
   * rejected promise is removed from the cache so the next call tries again.
   */
  function loadJson(path) {
    if (entries.has(path)) {
      return entries.get(path);
    }
    // The async function turns a synchronous throw from fetchFn into a rejection, so both failure kinds take
    // the same removal path below.
    const promise = (async () => {
      const response = await fetchFn(path);
      if (!response.ok) {
        // The body is left out on purpose: it is not needed to diagnose the failure and may be large or
        // contain text that should not reach an error message.
        throw new Error(`Could not load ${path}: HTTP ${response.status}`);
      }
      return response.json();
    })();
    entries.set(path, promise);
    promise.catch(() => {
      // Only remove this entry. A newer entry for the same path must not be dropped by an older failure.
      if (entries.get(path) === promise) {
        entries.delete(path);
      }
    });
    return promise;
  }

  return { loadJson };
}

// One cache for the whole document, so every view that calls the module-level loadJson shares it.
const sharedCache = createDataCache();

/**
 * Return the parsed JSON at path, using the one cache shared by the whole document. Callers in different views
 * get the same promise for the same path, so each file is requested once per page load.
 */
export function loadJson(path) {
  return sharedCache.loadJson(path);
}
