// Visitor rules for the web run store. Each browser has its own random visitor id, sent with every request. The
// server stores each run under a key that names that id, owner/<visitor id>/<run id>, so one visitor can only see
// and change their own runs. These are pure functions with no storage or network calls. The browser and the
// Netlify functions both import this file, so the id check and the key shape are written in one place only.

/** The shortest visitor id allowed. 32 hex characters hold 128 random bits, which makes guessing an id impractical. */
export const VISITOR_ID_MIN_LENGTH = 32;

/** The longest visitor id allowed. The limit keeps storage keys to a sensible size. */
export const VISITOR_ID_MAX_LENGTH = 128;

// The first part of every run key. A list of all runs asks for this prefix, and the owner key names the visitor.
const OWNER_ROOT = "owner";

// Letters, digits, - and _ only. A slash is refused, because a slash would change where a key points.
const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Run ids are UUIDs made by the server. This check is looser, but it still refuses a slash or a dot-dot.
const RUN_ID_PATTERN = /^[A-Za-z0-9-]+$/;

/**
 * Check a visitor id. Returns { ok: true } for a usable id, or { ok: false, error } with a message a visitor can
 * act on. A missing id is named as missing, so a browser that lost its id can tell what went wrong.
 */
export function checkVisitorId(visitorId) {
  if (typeof visitorId !== "string" || visitorId === "") {
    return { ok: false, error: "The visitor id is missing. Each browser must send its own id with every request." };
  }
  if (visitorId.length < VISITOR_ID_MIN_LENGTH) {
    return { ok: false, error: `The visitor id is too short. It must be at least ${VISITOR_ID_MIN_LENGTH} characters.` };
  }
  if (visitorId.length > VISITOR_ID_MAX_LENGTH) {
    return { ok: false, error: `The visitor id is too long. It may be at most ${VISITOR_ID_MAX_LENGTH} characters.` };
  }
  if (!VISITOR_ID_PATTERN.test(visitorId)) {
    return { ok: false, error: "The visitor id may hold only letters, digits, - and _." };
  }
  return { ok: true };
}

/**
 * Return the key prefix for one visitor, such as owner/<id>/. Every key of that visitor starts with it. The id must
 * pass checkVisitorId; a bad id throws, because building a key from it would be a bug in the caller.
 */
export function ownerPrefix(visitorId) {
  const check = checkVisitorId(visitorId);
  if (!check.ok) {
    throw new Error(check.error);
  }
  return `${OWNER_ROOT}/${visitorId}/`;
}

/**
 * Return the storage key of one run: owner/<visitor id>/<run id>. A run id with a slash or another odd character
 * throws, so a request cannot choose a key that points at another visitor.
 */
export function runKeyFor(visitorId, runId) {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new Error("The run id is not valid for a storage key.");
  }
  return ownerPrefix(visitorId) + runId;
}

/**
 * Read a storage key back into its visitor id and run id. Returns null for any key that is not a run key, such as
 * a key with an extra slash or a key from another part of the store.
 */
export function parseOwnerKey(key) {
  if (typeof key !== "string" || !key.startsWith(`${OWNER_ROOT}/`)) return null;
  const parts = key.split("/");
  if (parts.length !== 3 || parts[2] === "") return null;
  if (!checkVisitorId(parts[1]).ok) return null;
  return { visitorId: parts[1], runId: parts[2] };
}

/**
 * Return only the entries that belong to one visitor, in the order they were given. Each entry has an owner field,
 * which is the visitor id it was saved under. Nothing is removed from the list the caller holds.
 */
export function ownedBy(entries, visitorId) {
  return entries.filter((entry) => entry.owner === visitorId);
}
