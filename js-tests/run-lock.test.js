// Tests for the suite menu's run lock in frontend/js/run-lock.js. While a batch run or its confirmation is open, the suite
// menu must not change, so the suite on the form cannot be swapped mid-run. Shuffle is one of the menu's options, so
// it is locked by the same rule as the fixed suites.
import { test } from "node:test";
import assert from "node:assert/strict";
import { suiteChoiceLocked } from "../frontend/js/run-lock.js";

test("an idle page leaves the suite menu usable", () => {
  assert.equal(suiteChoiceLocked({ busy: false }), false);
});

test("a busy page locks the suite menu", () => {
  assert.equal(suiteChoiceLocked({ busy: true }), true);
});

test("only a true busy flag locks the menu, so a missing value never locks the page", () => {
  assert.equal(suiteChoiceLocked({}), false);
});
