// The admin API for saved runs, served at /api/runs-admin. It takes a POST with {"action": "prune"} to remove
// every expired run, or {"action": "clear"} to remove every run of every visitor. The admin password (WRITE_PASSWORD,
// set in the Netlify dashboard) must be sent as a Bearer header. Visitors never use this address. The logic is in
// netlify/lib/runs-handler.js, where it is tested.

import { createAdminHandler } from "../lib/runs-handler.js";
import { openRunStore } from "../lib/run-store.js";

// Netlify reads this to route the address /api/runs-admin to this function.
export const config = { path: "/api/runs-admin" };

// The handler for every admin request. The store is opened only after the password check passes.
export default createAdminHandler({ openStore: openRunStore });
