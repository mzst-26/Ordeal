// Tests for the pure helpers in site/js/picker-dialog.js. The dialog itself needs a DOM, so only the helpers are tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeSelection, filterItems } from "../site/js/picker-dialog.js";

// summarizeSelection counts every item and the ones the predicate marks as selected.
test("summarizeSelection counts total and selected items", () => {
  const items = ["a", "b", "c", "d"];
  assert.deepEqual(summarizeSelection(items, (item) => item !== "b"), { total: 4, selected: 3 });
});

test("summarizeSelection returns zeros for an empty list", () => {
  assert.deepEqual(summarizeSelection([], () => true), { total: 0, selected: 0 });
});

test("summarizeSelection reports none selected when the predicate is always false", () => {
  assert.deepEqual(summarizeSelection([1, 2], () => false), { total: 2, selected: 0 });
});

// filterItems matches a trimmed, case-insensitive substring of the text from textOf.
test("filterItems returns every item for an empty query", () => {
  const items = [{ name: "Alpha" }, { name: "Beta" }];
  assert.deepEqual(filterItems(items, "", (item) => item.name), items);
});

test("filterItems returns every item when the query is only spaces", () => {
  const items = [{ name: "Alpha" }, { name: "Beta" }];
  assert.deepEqual(filterItems(items, "   ", (item) => item.name), items);
});

test("filterItems matches case-insensitively", () => {
  const items = [{ name: "Alpha" }, { name: "Beta" }, { name: "alphabet" }];
  assert.deepEqual(
    filterItems(items, "ALPHA", (item) => item.name),
    [{ name: "Alpha" }, { name: "alphabet" }],
  );
});

test("filterItems trims the query before matching", () => {
  const items = ["red fox", "blue whale"];
  assert.deepEqual(filterItems(items, "  whale ", (item) => item), ["blue whale"]);
});

test("filterItems returns an empty array when nothing matches", () => {
  assert.deepEqual(filterItems(["one", "two"], "three", (item) => item), []);
});
