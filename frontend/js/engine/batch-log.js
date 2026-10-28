// Operation log for one batch run. Each entry is a plain object with a time, a kind and small fields.
// It never holds the API key, a reply text or a request body, so the file is safe to share when asking for help.

// The most entries kept. The oldest are dropped first, and the count of dropped entries is kept.
export const LOG_LIMIT = 5000;

// Fields that could carry a reply or a request. They are removed before an entry is kept.
const NEVER_LOGGED = ['reply', 'messages', 'body', 'token', 'user_text'];

/**
 * Create a log. record(kind, fields) adds one entry; fields that could hold a reply or a request are dropped.
 * now() returns the time text for each entry, and limit caps the number of entries kept.
 */
export function createBatchLog({ now = () => new Date().toISOString(), limit = LOG_LIMIT } = {}) {
  const entries = [];
  let dropped = 0;
  return {
    /** Add one entry with the time, the kind and the safe fields. Returns the entry. */
    record(kind, fields = {}) {
      const safe = { ...fields };
      for (const name of NEVER_LOGGED) delete safe[name];
      const entry = { time: now(), kind, ...safe };
      if (entries.length >= limit) {
        entries.shift();
        dropped += 1;
      }
      entries.push(entry);
      return entry;
    },
    /** Return a copy of the entries, oldest first. */
    entries() {
      return entries.slice();
    },
    /** Return how many of the oldest entries were dropped to stay under the limit. */
    dropped() {
      return dropped;
    },
    /** Return the log as JSON Lines: one entry per line, each line a complete JSON object. */
    toJsonl() {
      const header = dropped > 0 ? [{ time: now(), kind: 'log-truncated', dropped }] : [];
      const lines = [...header, ...entries].map((entry) => JSON.stringify(entry));
      return lines.length === 0 ? '' : lines.join('\n') + '\n';
    },
  };
}
