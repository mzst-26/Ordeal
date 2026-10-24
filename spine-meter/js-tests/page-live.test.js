// Tests for the Live page module (site/js/page-live.js). The router imports the module and calls
// mountLive(root) once, when the view is first shown. Importing must therefore do nothing: no fetch and no
// page work, because there is no document under node and the view may never be opened.
import { test } from "node:test";
import assert from "node:assert/strict";

// Replace fetch with a function that fails, so any network call made while importing the module is caught.
// The original fetch is put back afterwards so other tests are not affected.
test("importing the Live page does not fetch or build the page, and exports mountLive", async () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch should not run at import");
  };
  try {
    const page = await import("../site/js/page-live.js");
    assert.equal(typeof page.mountLive, "function");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
