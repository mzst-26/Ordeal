// Saves a finished Gauntlet run from this browser's store to the server, so it appears on the runs page. The whole
// run is sent, because a Gauntlet run is small. A Batch run sends its summary instead; that call is made directly
// with saveRun from runs-api.js. This file does no DOM work, so a test can call it with a memory store.

import { getRun } from "./store/run-store.js";
import { saveRun } from "./runs-api.js";

// The kind the server files a Gauntlet run under. The runs page shows it as "Gauntlet run".
export const GAUNTLET_KIND = "gauntlet";

const NOT_IN_BROWSER_TEXT = "This run is not in this browser any more, so it cannot be saved to your runs.";

// The status lines shown while a run is sent and once it has arrived. The Gauntlet and Batch pages both use them.
export const SAVING_TEXT = "Saving to your runs.";
export const SAVED_TEXT = "Saved to your runs. You can see it on the runs page.";

/**
 * Read the saved Gauntlet run with this id from the browser store and send it to the server under this visitor.
 * Returns the summary the server made. If the run is not in the browser, nothing is sent and an error explains it.
 */
export async function saveGauntletToRuns(adapter, runId, visitorId, fetchFn) {
  const run = await getRun(adapter, runId);
  if (run === null) {
    throw new Error(NOT_IN_BROWSER_TEXT);
  }
  return saveRun(visitorId, GAUNTLET_KIND, run, fetchFn);
}
