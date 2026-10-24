// Tests for the Batch page module (site/js/page-batch.js). The router imports the module and calls mountBatch(root)
// once, when the view is first shown. Importing must therefore do nothing: no fetch and no page work, because
// there is no document under node and the view may never be opened.
import { test } from "node:test";
import assert from "node:assert/strict";

test("importing the Batch page does not fetch or build the page, and exports mountBatch", async () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch should not run at import");
  };
  try {
    const page = await import("../site/js/page-batch.js");
    assert.equal(typeof page.mountBatch, "function");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
