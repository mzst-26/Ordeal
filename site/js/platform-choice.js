// Reads the platform the visitor chose: the shared list, plus this browser's saved choice of platform and model.
// The pages call activePlatform() just before they make a request, so every request goes to the platform that is
// chosen at that moment, and no page keeps its own copy of the address.

import { loadJson } from "./data-cache.js";
import { browserStorage } from "./engine/token.js";
import { currentPlatform, loadPlatforms, readChoice } from "./platforms.js";

/** Return the browser platform the visitor chose, or the default one when none is chosen. Reads the list each time. */
export async function activePlatform() {
  const list = await loadPlatforms(loadJson);
  return currentPlatform(list, readChoice(browserStorage()));
}
