// Tests for the Gauntlet page module (frontend/js/pages/page-gauntlet.js). The router imports the module and calls
// mountGauntlet(root) once, when the view is first shown. Importing must therefore do nothing: no fetch and no
// page work, because there is no document under node and the view may never be opened.
import { test } from "node:test";
import assert from "node:assert/strict";

// Replace fetch with a function that fails, so any network call made while importing the module is caught.
// The original fetch is put back afterwards so other tests are not affected.
test("importing the Gauntlet page does not fetch or build the page, and exports mountGauntlet", async () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch should not run at import");
  };
  try {
    const page = await import("../../frontend/js/pages/page-gauntlet.js");
    assert.equal(typeof page.mountGauntlet, "function");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// A model that the visitor added with "Add a model that is not in the list" is an option of the desk's model menu,
// so a saved run that used it can be resumed from that menu. A model with no option cannot be resumed.
test("a saved run whose model is on the desk menu can be resumed", async () => {
  const { resumeModelProblem } = await import("../../frontend/js/pages/page-gauntlet.js");
  assert.equal(resumeModelProblem("org/custom", ["org/catalogue", "org/custom"]), "");
});

test("a saved run whose model is not on the desk menu is refused, and says how to proceed", async () => {
  const { resumeModelProblem } = await import("../../frontend/js/pages/page-gauntlet.js");
  const text = resumeModelProblem("org/custom", ["org/catalogue"]);
  assert.match(text, /The model org\/custom is not in the list/);
  assert.match(text, /Add a model that is not in the list, then press Resume again\./);
});

test("modelOnDesk finds a catalogue model and a model the visitor added, and not a missing one", async () => {
  const { modelOnDesk } = await import("../../frontend/js/pages/page-gauntlet.js");
  const menu = ["org/catalogue", "org/custom"];
  assert.equal(modelOnDesk("org/catalogue", menu), true);
  assert.equal(modelOnDesk("org/custom", menu), true);
  assert.equal(modelOnDesk("org/missing", menu), false);
});
