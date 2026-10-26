// Tests for the catalogue numbers shown on the batch page: withCatalogueNumbers in site/js/model-list.js gives each
// model its number, and catalogueNumberText in site/js/model-details.js turns it into the text every place shows
// ("#19"). A model keeps its number when the picker filters or sorts its names, because the number is set once,
// in catalogue order, and never from the position in a sorted list. Every test is pure: no DOM, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withCatalogueNumbers, sortModelIds } from "../site/js/model-list.js";
import { catalogueNumberText } from "../site/js/model-details.js";

/** Three small catalogue entries, out of name order on purpose, so sorting would move them. */
const CATALOGUE = [{ id: "zeta/model-z" }, { id: "alpha/model-a" }, { id: "mid/model-m" }];

test("withCatalogueNumbers gives 1 to the first entry and counts up in the order given", () => {
  const numbered = withCatalogueNumbers(CATALOGUE);
  assert.deepEqual(numbered.map((entry) => entry.number), [1, 2, 3]);
  assert.deepEqual(numbered.map((entry) => entry.id), ["zeta/model-z", "alpha/model-a", "mid/model-m"]);
});

test("withCatalogueNumbers does not change the entries it was given", () => {
  const before = JSON.stringify(CATALOGUE);
  withCatalogueNumbers(CATALOGUE);
  assert.equal(JSON.stringify(CATALOGUE), before);
});

test("a model keeps its number when the picker sorts its names", () => {
  const numbered = withCatalogueNumbers(CATALOGUE);
  const numberOf = new Map(numbered.map((entry) => [entry.id, entry.number]));
  // The picker shows the names sorted under letter headings, so the sorted order is not the catalogue order.
  const sorted = sortModelIds(numbered.map((entry) => entry.id));
  assert.deepEqual(sorted, ["alpha/model-a", "mid/model-m", "zeta/model-z"]);
  for (const id of sorted) {
    assert.equal(numberOf.get(id), numbered.find((entry) => entry.id === id).number);
  }
  assert.equal(numberOf.get("zeta/model-z"), 1);
});

test("a model keeps its number when the picker filters the names", () => {
  const numbered = withCatalogueNumbers(CATALOGUE);
  // A search for "model-m" leaves one name. Its number is still the one it had in the full catalogue.
  const shown = numbered.filter((entry) => entry.id.includes("model-m"));
  assert.deepEqual(shown.map((entry) => [entry.id, entry.number]), [["mid/model-m", 3]]);
});

test("names the visitor added get the numbers after the catalogue", () => {
  const catalogue = withCatalogueNumbers(CATALOGUE);
  const numbered = withCatalogueNumbers([...catalogue, { id: "added/one" }, { id: "added/two" }]);
  assert.deepEqual(numbered.slice(3).map((entry) => [entry.id, entry.number]), [["added/one", 4], ["added/two", 5]]);
  // The catalogue numbers are the same as before the names were added.
  assert.deepEqual(numbered.slice(0, 3).map((entry) => entry.number), [1, 2, 3]);
});

test("catalogueNumberText shows a whole number as #N, the same style as the rank", () => {
  assert.equal(catalogueNumberText({ number: 19 }), "#19");
  assert.equal(catalogueNumberText({ number: 1 }), "#1");
});

test("catalogueNumberText shows unknown, never a made-up number, when the number is missing or not usable", () => {
  for (const entry of [{}, { number: 0 }, { number: -2 }, { number: 2.5 }, { number: "19" }, { number: null }, null]) {
    assert.equal(catalogueNumberText(entry), "unknown", JSON.stringify(entry));
  }
});
