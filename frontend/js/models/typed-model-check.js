// The check a model name gets when the visitor types it into a "not in the list" field. Each page then decides what
// an accepted name does: the batch page ticks it in its picker, and the Gauntlet sets its one model to it.
//
// Why the check lives here: the batch page's add path (addTypedModel in page-batch.js) is tied to the batch's picker
// state, so another page cannot call it. The steps it runs are kept here instead, so every page checks a typed name in
// the same way: the format rules first, then the platform's own list when a key for that platform is saved.

import { askForToken } from "../ui/token-dialog.js";
import { fetchModelIds } from "../engine/api.js";
import { vault } from "../engine/token.js";
import { keyFitsPlatform, refusalText, resolveNewModel } from "./model-list.js";

/**
 * Return true when the key saved in this browser was entered for this platform, or once the visitor gives one for it.
 * This is the same prompt a run asks for, so a key is never asked for in a second way.
 */
export async function keyReadyFor(platform) {
  if (vault.has() && keyFitsPlatform(vault.platformId(), platform.id)) {
    return true;
  }
  return askForToken({ vault, platformId: platform.id });
}

/**
 * Check a typed name for the platform. Returns {ok: true, model, checked, message} when the name can be used, where
 * checked says whether the platform's own list confirmed it. Returns {ok: false, message} when it cannot.
 * A name is refused before any request when it is empty or unsafe. Otherwise the platform's list is read, but only
 * when a key for this platform is saved, and a name the list does not have is refused with close names.
 */
export async function checkTypedName(platform, text) {
  const early = resolveNewModel(platform, text, null);
  if (!early.ok) {
    return refused(early);
  }
  const found = resolveNewModel(platform, text, await platformIdsForCheck(platform));
  if (!found.ok) {
    return refused(found);
  }
  const message = choiceOutcomeText({ model: found.model, checked: found.checked });
  return { ok: true, model: found.model, checked: found.checked, message };
}

/**
 * Return the plain line that says which model the name is now, and whether the platform list confirmed it. A name
 * that was not checked says why, so the visitor knows it was not confirmed.
 */
export function choiceOutcomeText({ model, checked }) {
  const confirmed = checked ? "The platform list has it." : "It is not checked, because the platform list was not read.";
  return `${model} is now the model. ${confirmed}`;
}

/** Return the failure result for a name that cannot be used: its plain line and the close names, if any. */
function refused(found) {
  return { ok: false, message: refusalText(found.reason, found.suggestions) };
}

/**
 * Return the platform's own list of ids for the check, or null when the check cannot run. It cannot run when no key is
 * saved, when the saved key was entered for another platform (that key is never sent there), or when the request
 * fails. Null means the name is accepted as not checked.
 */
export async function platformIdsForCheck(platform) {
  if (!vault.has() || !keyFitsPlatform(vault.platformId(), platform.id)) {
    return null;
  }
  try {
    return await fetchModelIds({ platform, token: vault.get() });
  } catch {
    return null;
  }
}
