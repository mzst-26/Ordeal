// The model list for the batch page, per platform. Each platform has its own saved list of model ids (from
// ordeal/models.json, copied to site/data/models.json), and the names a visitor adds are kept per platform in this
// browser. The functions here are pure, or take the storage as a parameter, so they can be tested in node without a
// page. The page itself (page-batch.js) draws the rows and keeps the ticks.
//
// Why one list per platform: a model id only means something on the platform that serves it. Showing one platform's
// names while another platform is chosen would run a model on an address that does not host it.

import { parseModelReference, findModel } from "./platforms.js";

// Where the site copy of the saved model lists is requested from. It is optional: a missing file only hides the lists.
export const MODELS_PATH = "/data/models.json";
// The most rows the model popup draws at once. A list can hold more than 20,000 names, so the popup shows a slice
// and says how many more match, instead of drawing every row.
export const MAX_POPUP_ROWS = 300;
// Above this many planned calls, the plan shows one warning line. The run is still allowed; it is only flagged.
export const LARGE_RUN_CALLS = 5000;
// The start of the storage name for the names a visitor added. The platform id is added after it.
const ADDED_PREFIX = "ordeal.added-models.";
// The status a platform's saved list has when the refresh worked. Any other status means there is no usable list.
const REFRESHED = "refreshed";

const ADDED_NOTE = "added";
const NOT_CHECKED_NOTE = "not checked";

const LARGE_RUN_TEXT = "This run is large: it has more than 5,000 planned calls and will take a long time. You can still start it.";

/**
 * Return the ids saved for one platform, in file order. A missing file, a platform with no entry, a status that is
 * not "refreshed", or a models value that is not a list all give an empty list. Entries that are not non-empty
 * strings are skipped, and a repeated id is kept once. Nothing here throws, so a broken file only hides the list.
 */
export function platformModelIds(modelsFile, platformId) {
  const entry = savedEntry(modelsFile, platformId);
  if (entry === null || entry.status !== REFRESHED || !Array.isArray(entry.models)) {
    return [];
  }
  const seen = new Set();
  const ids = [];
  for (const id of entry.models) {
    if (typeof id === "string" && id !== "" && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** Return the entry for one platform in the saved file, or null when the file or the entry is missing or not an object. */
function savedEntry(modelsFile, platformId) {
  if (!modelsFile || typeof modelsFile !== "object" || !modelsFile.platforms || typeof modelsFile.platforms !== "object") {
    return null;
  }
  const entry = modelsFile.platforms[platformId];
  return entry && typeof entry === "object" ? entry : null;
}

/** Return true when the platform has at least one saved id. An empty list gets the same note as no list. */
export function hasSavedList(modelsFile, platformId) {
  return platformModelIds(modelsFile, platformId).length > 0;
}

/**
 * Return the rows the popup shows for a search: up to `limit` ids that contain the query (ignoring case and outer
 * spaces), and how many more match. An empty query matches every id. Only the shown rows are returned, so the caller
 * never has to draw the rest.
 */
export function visibleModelIds(ids, query, limit) {
  const needle = String(query ?? "").trim().toLowerCase();
  const shown = [];
  let total = 0;
  for (const id of ids) {
    if (needle === "" || id.toLowerCase().includes(needle)) {
      total += 1;
      if (shown.length < limit) shown.push(id);
    }
  }
  return { shown, more: total - shown.length };
}

/** Return the storage name for one platform's added names, such as "ordeal.added-models.openrouter". */
export function addedStorageName(platformId) {
  return ADDED_PREFIX + platformId;
}

/**
 * Read the names a visitor added for one platform. Each one is {id, checked}: the id, and whether the platform's own
 * list confirmed it when it was added. Anything that is not a valid entry is skipped. A storage error, or saved text
 * that is not a list, gives an empty list, so the page still works with nothing saved.
 */
export function readAddedModels(storage, platformId) {
  try {
    const raw = storage ? storage.getItem(addedStorageName(platformId)) : null;
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAddedEntry).map((entry) => ({ id: entry.id, checked: entry.checked }));
  } catch {
    return [];
  }
}

/** Return true for a saved entry with a non-empty text id and a true or false checked flag. */
function isAddedEntry(entry) {
  return Boolean(entry) && typeof entry === "object" && typeof entry.id === "string" && entry.id !== ""
    && typeof entry.checked === "boolean";
}

/**
 * Save the names a visitor added for one platform. Returns true when the write worked. A storage error returns false,
 * and the names then last only for this page visit, which the page says plainly.
 */
export function writeAddedModels(storage, platformId, added) {
  try {
    if (!storage) return false;
    storage.setItem(addedStorageName(platformId), JSON.stringify(added));
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the added list with one more name. A name that is already there is not added twice: the result says so
 * with duplicate: true, and the list comes back unchanged. The given list is never changed.
 */
export function withAddedModel(added, id, checked) {
  if (added.some((entry) => entry.id === id)) {
    return { added, duplicate: true };
  }
  return { added: [...added, { id, checked }], duplicate: false };
}

/**
 * Return the set of ticked ids to use after the platform choice changes. A tick is only ever for a model of the
 * platform it was made on, so a change of platform starts with no ticks. The same platform keeps its ticks.
 */
export function ticksAfterPlatformChange(previousId, nextId, ticked) {
  return previousId === nextId ? ticked : new Set();
}

/**
 * Check one name the visitor typed for a platform. availableIds is the platform's own list of ids when the check ran,
 * or null when it did not (no key, or the request failed). Returns {ok: true, model, checked} when the name can be
 * added, where checked says whether the list confirmed it. Returns {ok: false, reason, suggestions} when it cannot.
 * A name is never added when the list was read and does not have it.
 */
export function resolveNewModel(platform, text, availableIds) {
  const parsed = parseModelReference(platform, text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, suggestions: [] };
  if (availableIds === null) return { ok: true, model: parsed.model, checked: false };
  const found = findModel(platform, parsed.model, availableIds);
  if (!found.ok) return { ok: false, reason: found.reason, suggestions: found.suggestions ?? [] };
  return { ok: true, model: found.model, checked: true };
}

/** Return the one warning line for a run with this many planned calls, or "" when it is not large. It never stops the run. */
export function largeRunWarning(plannedCalls) {
  return plannedCalls > LARGE_RUN_CALLS ? LARGE_RUN_TEXT : "";
}

/**
 * Return the added list without one name. The given list is never changed, so the page can keep the old copy until
 * the new one is saved. A name that is not there gives back an equal list.
 */
export function withoutAddedModel(added, id) {
  return added.filter((entry) => entry.id !== id);
}

/**
 * Return one row for each added name that the platform's own list does not already have. The platform list wins,
 * so a name is never shown twice. A row is marked unchecked when the platform list did not confirm the name.
 */
export function addedRows(baseIds, addedModels) {
  const base = new Set(baseIds);
  return addedModels
    .filter((entry) => !base.has(entry.id))
    .map((entry) => ({ id: entry.id, note: ADDED_NOTE, unchecked: !entry.checked }));
}

/**
 * Return the one plain line that says what happened to a name the visitor added. It says whether the platform list
 * confirmed the name, and whether the name lasts only for this page visit because storage is blocked.
 */
export function addOutcomeText({ model, checked, saved }) {
  const confirmed = checked ? "The platform list has it." : "It is not checked, because the platform list was not read.";
  const lasting = saved ? "" : " Browser storage is blocked, so it lasts only for this page visit.";
  return `Added ${model}. ${confirmed}${lasting}`;
}

/**
 * Return the plain line for a name that cannot be added: the reason, then the close names when there are any.
 * The typed text itself is never repeated, so nothing the visitor typed is shown as markup.
 */
export function refusalText(reason, suggestions) {
  return suggestions.length === 0 ? reason : `${reason} Did you mean: ${suggestions.join(", ")}?`;
}

/**
 * Return the small note after a model name in the popup card, joining the row's own note with "not checked" when
 * the platform list did not confirm the name. A plain confirmed row has no note.
 */
export function entryNote(entry) {
  const parts = [entry.note, entry.unchecked ? NOT_CHECKED_NOTE : ""].filter((part) => part !== "");
  return parts.join(", ");
}

/**
 * Return true when the key saved in this browser was entered for this platform. A key is only sent to the platform it
 * was entered for, so a key saved for one platform is never sent to another one.
 */
export function keyFitsPlatform(keyPlatformId, platformId) {
  return typeof keyPlatformId === "string" && keyPlatformId !== "" && keyPlatformId === platformId;
}
