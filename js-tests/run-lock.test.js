// Tests for the Shuffle controls' run lock in site/js/run-lock.js. While a batch run or its confirmation is open,
// the Shuffle tick box and the two set dropdowns must not change. The tick box is also disabled while a run is busy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shuffleControlsState } from "../site/js/run-lock.js";

test("an idle page with the box off leaves the box and both dropdowns usable", () => {
  assert.deepEqual(shuffleControlsState({ busy: false, shuffleOn: false }), { toggleDisabled: false, setsDisabled: false });
});

test("an idle page with the box on still disables the dropdowns, because the mixed run uses both sets", () => {
  assert.deepEqual(shuffleControlsState({ busy: false, shuffleOn: true }), { toggleDisabled: false, setsDisabled: true });
});

test("a busy page disables the box and the dropdowns, whether the box is on or off", () => {
  assert.deepEqual(shuffleControlsState({ busy: true, shuffleOn: false }), { toggleDisabled: true, setsDisabled: true });
  assert.deepEqual(shuffleControlsState({ busy: true, shuffleOn: true }), { toggleDisabled: true, setsDisabled: true });
});
