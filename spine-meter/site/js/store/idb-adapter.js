// IndexedDB adapter for the saved runs. It uses one database, "sycophancy-meter" version 1, with one object
// store "runs" keyed by id. Every call to the browser's indexedDB API is wrapped in try/catch, so a private
// window or a blocked store gives a plain message instead of an uncaught error. This adapter does not check
// records for keys or tokens: the run store does that before it calls put.

export const IDB_NAME = 'sycophancy-meter';
export const IDB_VERSION = 1;
export const IDB_STORE = 'runs';
const UNAVAILABLE_MESSAGE = 'Saved runs are not available in this browser, so runs last only until the page is closed.';
const FAILED_MESSAGE = 'The saved runs could not be read or written. Try again.';
const STORE_MESSAGE = 'Only the runs store is used.';
const NO_ID_MESSAGE = 'The record has no id, so it was not saved.';

/**
 * Open the database and return the connection. Rejects with the unavailable message when the factory is
 * missing, the open call throws, or the browser reports an error (as in some private windows).
 */
function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    try {
      if (!factory || typeof factory.open !== 'function') {
        reject(new Error(UNAVAILABLE_MESSAGE));
        return;
      }
      const request = factory.open(IDB_NAME, IDB_VERSION);
      request.onupgradeneeded = () => {
        try {
          const db = request.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE, { keyPath: 'id' });
          }
        } catch (error) {
          reject(new Error(UNAVAILABLE_MESSAGE));
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(UNAVAILABLE_MESSAGE));
    } catch (error) {
      reject(new Error(UNAVAILABLE_MESSAGE));
    }
  });
}

/**
 * Run one request inside a transaction on the runs store. makeRequest gets the object store and returns
 * an IDB request. Resolves with the request's result once the transaction commits.
 */
function runTransaction(database, mode, makeRequest) {
  return new Promise((resolve, reject) => {
    let result;
    let transaction = null;
    try {
      transaction = database.transaction(IDB_STORE, mode);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(new Error(FAILED_MESSAGE));
      transaction.onabort = () => reject(new Error(FAILED_MESSAGE));
      const request = makeRequest(transaction.objectStore(IDB_STORE));
      request.onsuccess = () => {
        result = request.result;
      };
    } catch (error) {
      try {
        if (transaction) transaction.abort();
      } catch (abortError) {
        // The transaction had already finished, so there is nothing to abort.
      }
      reject(new Error(FAILED_MESSAGE));
    }
  });
}

/**
 * Create an IndexedDB adapter. getIndexedDb returns the browser's indexedDB object; it is read at the
 * first call, so a test can pass a fake. The default reads the global.
 * Methods: available() (resolves true or false), put, get (document or null), list and remove.
 */
export function createIdbAdapter({ getIndexedDb = () => globalThis.indexedDB } = {}) {
  // The open connection, kept after the first successful open. A failed open is not kept.
  let connection = null;

  /** Return the open connection, opening it on first use. */
  async function connect() {
    if (connection !== null) {
      return connection;
    }
    let factory;
    try {
      factory = getIndexedDb();
    } catch (error) {
      throw new Error(UNAVAILABLE_MESSAGE);
    }
    const opened = await openDatabase(factory);
    opened.onversionchange = () => {
      try {
        opened.close();
      } catch (error) {
        // Closing failed, so the connection is dropped below anyway.
      }
      connection = null;
    };
    connection = opened;
    return opened;
  }

  /** Check the store name, then run one request on it. */
  async function transact(storeName, mode, makeRequest) {
    if (storeName !== IDB_STORE) {
      throw new Error(STORE_MESSAGE);
    }
    const database = await connect();
    return runTransaction(database, mode, makeRequest);
  }

  return {
    /** Name of this adapter, so a caller can tell it from the memory adapter. */
    kind: 'indexeddb',
    /** Resolve true when the database opens. Resolve false when indexedDB is missing or the open fails. */
    async available() {
      try {
        await connect();
        return true;
      } catch (error) {
        return false;
      }
    },
    /** Save a document under its id, replacing any earlier copy. */
    async put(storeName, doc) {
      if (!doc || typeof doc.id !== 'string') {
        throw new Error(NO_ID_MESSAGE);
      }
      await transact(storeName, 'readwrite', (store) => store.put(doc));
    },
    /** Return one document, or null when there is none with that id. */
    async get(storeName, id) {
      const doc = await transact(storeName, 'readonly', (store) => store.get(id));
      return doc === undefined ? null : doc;
    },
    /** Return every document in the store. */
    async list(storeName) {
      return transact(storeName, 'readonly', (store) => store.getAll());
    },
    /** Delete one document. Removing an id that is not there does nothing. */
    async remove(storeName, id) {
      await transact(storeName, 'readwrite', (store) => store.delete(id));
    },
  };
}
