// In-memory adapter for the saved runs. It keeps documents in a Map for the life of the page, so nothing
// survives a reload. The run store falls back to it when IndexedDB is not available. Documents are copied
// on the way in and on the way out, so a caller that changes a copy does not change what is stored.

const NO_ID_MESSAGE = 'The record has no id, so it was not saved.';

/** Return a copy of a document, made the same way IndexedDB copies it. */
function copyDocument(doc) {
  return structuredClone(doc);
}

/**
 * Create an in-memory adapter with put, get, list and remove, all async.
 * get returns the document or null. list returns every document in the store, in no fixed order.
 */
export function createMemoryAdapter() {
  // One Map per store name. Each Map is keyed by document id.
  const stores = new Map();

  /** Return the Map for a store name, creating it on first use. */
  function storeFor(storeName) {
    if (!stores.has(storeName)) {
      stores.set(storeName, new Map());
    }
    return stores.get(storeName);
  }

  return {
    /** Name of this adapter, so a caller can tell it from the IndexedDB adapter. */
    kind: 'memory',
    /** Return true: the memory store is always usable. */
    async available() {
      return true;
    },
    /** Save a copy of a document under its id, replacing any earlier copy. */
    async put(storeName, doc) {
      if (!doc || typeof doc.id !== 'string') {
        throw new Error(NO_ID_MESSAGE);
      }
      storeFor(storeName).set(doc.id, copyDocument(doc));
    },
    /** Return a copy of one document, or null when there is none with that id. */
    async get(storeName, id) {
      const doc = storeFor(storeName).get(id);
      return doc === undefined ? null : copyDocument(doc);
    },
    /** Return copies of every document in the store. */
    async list(storeName) {
      return [...storeFor(storeName).values()].map(copyDocument);
    },
    /** Delete one document. Removing an id that is not there does nothing. */
    async remove(storeName, id) {
      storeFor(storeName).delete(id);
    },
  };
}
