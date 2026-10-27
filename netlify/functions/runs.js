// The saved-runs API, served at /api/runs. Each browser sends its own visitor id in the x-visitor-id header, and
// the handler only ever lists, reads, saves or deletes runs under that id. No password is needed, because the id
// keeps each visitor's runs apart. The request handling lives in netlify/lib/runs-handler.js, where it is tested.

import { createRunsHandler } from "../lib/runs-handler.js";
import { openRunStore } from "../lib/run-store.js";

// Netlify reads this to route the address /api/runs to this function.
export const config = { path: "/api/runs" };

// The handler for every request. It opens the real Netlify store only after the request passes the checks.
export default createRunsHandler({ openStore: openRunStore });
