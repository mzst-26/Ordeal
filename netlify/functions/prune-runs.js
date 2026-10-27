// Scheduled job that runs once a day and deletes every saved run older than 7 days. Netlify calls it on the
// schedule below; nobody calls it over HTTP. The age rule is the one in site/js/run-retention.js, so the browser
// and the server agree on what "expired" means.

import { openRunStore, listSummaries, removeRecord } from "../lib/run-store.js";
import { toRetentionRuns } from "../lib/run-rules.js";
import { expiredRunIds } from "../../site/js/run-retention.js";

// "@daily" tells Netlify to run this function once a day.
export const config = { schedule: "@daily" };

/** Delete the expired runs and return how many were removed. The clock is read once, so every run is judged alike. */
export default async function handler() {
  const store = openRunStore();
  const expired = expiredRunIds(toRetentionRuns(await listSummaries(store)), Date.now());
  for (const id of expired) {
    await removeRecord(store, id);
  }
  return new Response(JSON.stringify({ removed: expired.length }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
