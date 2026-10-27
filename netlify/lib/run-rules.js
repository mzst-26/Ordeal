// Rules for the saved runs the server keeps: which kinds may be saved, what a valid id looks like, how a save
// request is checked, how a record is built, and how a list summary is read back from storage metadata. These are
// pure functions with no network or storage calls, so they are easy to test with plain objects.

/** The two kinds of run the web pages make. Only these may be saved. */
export const KINDS = Object.freeze(["batch", "gauntlet"]);

// Ids are lower-case UUIDs made by the server. Checking the shape stops a request from choosing a strange storage key.
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Return true when a value is a plain object, such as one parsed from JSON. Arrays and null do not count. */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return true when the id has the shape of a UUID this server makes. */
export function runIdIsValid(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

/**
 * Return true when a browser id has the shape the browser makes: a lower-case UUID. The browser keeps it in its own
 * storage and sends it with each save, so the server checks the shape before it counts anything against it.
 */
export function browserIdIsValid(id) {
  return runIdIsValid(id);
}

/**
 * Check the body of a save request. It must name a known kind and carry a run object. Returns { ok: true }, or
 * { ok: false, error } with a plain message the caller can send back.
 */
export function checkNewRun(body) {
  if (!isPlainObject(body)) {
    return { ok: false, error: "The request body must be a JSON object." };
  }
  if (!KINDS.includes(body.kind)) {
    return { ok: false, error: "The kind must be batch or gauntlet." };
  }
  if (!isPlainObject(body.run)) {
    return { ok: false, error: "The run must be a JSON object." };
  }
  return { ok: true };
}

/**
 * Build the record the server stores for a run. It keeps the id, the kind, the time it was saved (in milliseconds),
 * the id of the browser that saved it (its owner) and the run itself. The body must already have passed checkNewRun.
 */
export function buildRecord(id, body, createdAtMs, owner) {
  return { id, kind: body.kind, createdAt: createdAtMs, owner, run: body.run };
}

/**
 * Turn the metadata kept with a stored run into a summary: id, kind, creation time, size in bytes and the owner
 * browser. Reading the metadata means a list does not have to download every run. The server strips the owner before
 * it sends a list to a browser.
 */
export function summaryOf(id, metadata) {
  return { id, kind: metadata.kind, createdAt: metadata.createdAt, size: metadata.bytes, owner: metadata.owner };
}

/**
 * Turn summaries into the shape the retention rules in site/js/run-retention.js read: id, createdAt, bytes and owner.
 * The rules name the size "bytes", while the summary calls it "size", so this one place does the renaming.
 */
export function toRetentionRuns(summaries) {
  return summaries.map((summary) => ({
    id: summary.id,
    createdAt: summary.createdAt,
    bytes: summary.size,
    owner: summary.owner,
  }));
}
