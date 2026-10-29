// Finds the replies a Start can reuse from the saved batch runs. A reply that was paid for is kept, and the next Start
// uses it instead of calling the model again. This module holds only the decision, with no storage or page code, so
// the tests can run it in Node.

import { KIND_BATCH, recordsFromRun } from "./saved-runs.js";
import { hasWords } from "../engine/reply-words.js";

/**
 * Return every usable step record of the saved batch runs, ready for the reply cache. runs must be newest first, as
 * listRuns gives them: the records are returned oldest first, so when two runs hold the same step the newer reply is the
 * one the cache keeps. A record with no words in its reply is left out, so an unusable reply is never reused as an
 * answer. Gauntlet runs are not batch replies, and are left out.
 */
export function savedRepliesForStart(runs) {
  const records = [];
  for (const run of [...runs].reverse()) {
    if (run?.config?.kind !== KIND_BATCH) continue;
    for (const record of recordsFromRun(run)) {
      if (typeof record.reply === "string" && hasWords(record.reply)) records.push(record);
    }
  }
  return records;
}
