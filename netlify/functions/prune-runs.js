// Scheduled job that runs once a day and deletes every saved run older than 7 days, for every visitor. Netlify calls
// it on the schedule below; nobody calls it over HTTP. The age rule is the one in site/js/run-retention.js, so the
// browser and the server agree on what "expired" means. The removal itself is pruneExpired in runs-handler.js.

import { openRunStore } from "../lib/run-store.js";
import { pruneExpired } from "../lib/runs-handler.js";

// "@daily" tells Netlify to run this function once a day.
export const config = { schedule: "@daily" };

/** Delete the expired runs and return how many were removed. The clock is read once, so every run is judged alike. */
export default async function handler() {
  const removed = await pruneExpired(openRunStore(), Date.now());
  return new Response(JSON.stringify({ removed }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
