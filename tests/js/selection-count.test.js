// Tests for frontend/js/selection-count.js. The element is a small stand-in object: only textContent is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectionCountText, updateSelectionCount } from "../../frontend/js/selection-count.js";

// Wording of the "N of M things selected" label: normal counts, the all-selected case, and an empty list.
test("selectionCountText reads 3 of 29 models selected", () => {
  assert.equal(selectionCountText(3, 29, "models"), "3 of 29 models selected");
});

test("selectionCountText reads 29 of 29 models selected when all are ticked", () => {
  assert.equal(selectionCountText(29, 29, "models"), "29 of 29 models selected");
});

test("selectionCountText says there are no models to select when the total is 0", () => {
  assert.equal(selectionCountText(0, 0, "models"), "No models to select");
});

// Noun handling: the plural noun passed in is made singular when the total is exactly 1.
test("selectionCountText uses the singular noun when there is exactly one item", () => {
  assert.equal(selectionCountText(0, 1, "models"), "0 of 1 model selected");
});

test("selectionCountText singularises a noun that ends in ies", () => {
  assert.equal(selectionCountText(1, 1, "families"), "1 of 1 family selected");
});

test("selectionCountText uses the noun it is given for questions", () => {
  assert.equal(selectionCountText(32, 32, "questions"), "32 of 32 questions selected");
});

// The updater writes the same text into the element it is given.
test("updateSelectionCount sets the text of the element", () => {
  const element = { textContent: "" };
  updateSelectionCount(element, 3, 29, "models");
  assert.equal(element.textContent, "3 of 29 models selected");
});
