// Reads the platform the visitor chose: the shared list, plus this browser's saved choice of platform and model.
// The pages call activePlatform() just before they make a request, so every request goes to the platform that is
// chosen at that moment, and no page keeps its own copy of the address.

import { loadJson } from "../shared/data-cache.js";
import { browserStorage } from "../engine/token.js";
import { slotFor } from "../engine/provider-keys.js";
import { currentPlatform, loadPlatforms, readChoice } from "./platforms.js";

// The message a page shows when no platform can be chosen. It is plain text, so it is safe to show as it is.
const NO_PLATFORM_MESSAGE = "No platform is available, so the request cannot be sent.";

/**
 * Return the platform the visitor chose, or the default one when none is chosen. Reads the list each time.
 * It throws a plain message only when the list has no selectable platform at all, which the pages report.
 */
export async function activePlatform() {
  const list = await loadPlatforms(loadJson);
  const platform = currentPlatform(list, readChoice(browserStorage()));
  if (platform === null) throw new Error(NO_PLATFORM_MESSAGE);
  return platform;
}

/**
 * Return the chosen platform together with its key slot. A page asks for the key through this slot, so it reads and
 * writes the key of the provider it is about to call, the same key every other page uses.
 */
export async function activeKeySlot() {
  const platform = await activePlatform();
  return { platform, slot: slotFor(platform.id) };
}
