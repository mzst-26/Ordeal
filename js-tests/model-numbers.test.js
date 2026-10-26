// Tests for the catalogue numbers shown on the batch page: withCatalogueNumbers in site/js/model-list.js gives each
// model its number, and modelNumberText in site/js/model-details.js turns it into the label every place shows
// ("#19"). A model keeps its number when the picker filters or sorts its names, because the number is set once,
// in catalogue order, and never from the position in a sorted list. Every test is pure: no DOM, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withCatalogueNumbers,
  sortModelIds,
  withAddedModel,
  withoutAddedModel,
  nextAddedNumber,
  numberAddedModels,
  readAddedModels,
  writeAddedModels,
  readAddedCounter,
  writeAddedCounter,
} from "../site/js/model-list.js";
import { modelNumberText } from "../site/js/model-details.js";

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

test("withCatalogueNumbers keeps a number that is already stored, and numbers the rest by position", () => {
  const numbered = withCatalogueNumbers([{ id: "org/a", number: 40 }, { id: "org/b" }]);
  assert.deepEqual(numbered.map((entry) => entry.number), [40, 2]);
});

// Names the visitor adds get a number when they are added, and keep it. They are not renumbered by position.

/** A fake storage that really keeps what is written, so a write can be read back in a test. */
function memoryStorage() {
  const store = new Map();
  return {
    getItem: (name) => (store.has(name) ? store.get(name) : null),
    setItem: (name, value) => { store.set(name, String(value)); },
  };
}

test("removing an added name keeps the labels of the names that stay", () => {
  // The first added name is +1 and the second is +2. Removing +1 must leave +2 as it was.
  const first = withAddedModel([], "org/a", true, nextAddedNumber([], 0));
  const second = withAddedModel(first.added, "org/b", true, nextAddedNumber(first.added, 0));
  const kept = withoutAddedModel(second.added, "org/a");
  assert.deepEqual(kept.map((entry) => [entry.id, entry.number]), [["org/b", 2]]);
});

test("a number used by a removed name is never handed out again", () => {
  // Name 5 was removed, but the counter still remembers 5, so the next name is 6, not 5.
  const left = [{ id: "org/a", checked: true, number: 4 }];
  assert.equal(nextAddedNumber(left, 5), 6);
});

test("the first added name is +1, whatever the catalogue size", () => {
  assert.equal(nextAddedNumber([], 0), 1);
});

test("numberAddedModels gives numbers to names saved before numbers existed, in order", () => {
  const filled = numberAddedModels([{ id: "org/a", checked: true }, { id: "org/b", checked: false }], 0);
  assert.deepEqual(filled.added.map((entry) => [entry.id, entry.number]), [["org/a", 1], ["org/b", 2]]);
  assert.equal(filled.lastUsed, 2);
  assert.equal(filled.changed, true);
});

test("numberAddedModels changes nothing when every name already has a number", () => {
  const numbered = [{ id: "org/a", checked: true, number: 4 }];
  const filled = numberAddedModels(numbered, 4);
  assert.equal(filled.changed, false);
  assert.deepEqual(filled.added, numbered);
});

test("a stored number survives a write and a read", () => {
  const storage = memoryStorage();
  writeAddedModels(storage, "openrouter", [{ id: "org/b", checked: true, number: 5 }]);
  assert.deepEqual(readAddedModels(storage, "openrouter"), [{ id: "org/b", checked: true, number: 5 }]);
});

test("the counter starts at 0 and keeps the last number written", () => {
  const storage = memoryStorage();
  assert.equal(readAddedCounter(storage, "openrouter"), 0);
  assert.equal(writeAddedCounter(storage, "openrouter", 7), true);
  assert.equal(readAddedCounter(storage, "openrouter"), 7);
  assert.equal(readAddedCounter(storage, "groq"), 0);
});

test("the counter reads 0 and does not throw when storage is blocked", () => {
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readAddedCounter(blocked, "openrouter"), 0);
  assert.equal(writeAddedCounter(blocked, "openrouter", 7), false);
});

test("modelNumberText shows a catalogue model as #N, the same style as the rank", () => {
  assert.equal(modelNumberText({ number: 19 }), "#19");
  assert.equal(modelNumberText({ number: 1 }), "#1");
});

test("modelNumberText shows an added name as +N, counted on its own", () => {
  assert.equal(modelNumberText({ number: 1, added: true }), "+1");
  assert.equal(modelNumberText({ number: 2, added: true }), "+2");
});

test("modelNumberText shows unknown, never a made-up number, when the number is missing or not usable", () => {
  for (const entry of [{}, { number: 0 }, { number: -2 }, { number: 2.5 }, { number: "19" }, { number: null }, null]) {
    assert.equal(modelNumberText(entry), "unknown", JSON.stringify(entry));
    assert.equal(modelNumberText({ ...entry, added: true }), "unknown", JSON.stringify(entry));
  }
});

test("a catalogue model #1 and an added name +1 can both exist without a clash", () => {
  // The catalogue here has one model, so its number is 1. The first added name is also 1, but its label is +1.
  const catalogue = withCatalogueNumbers([{ id: "org/catalogue" }]);
  const added = withAddedModel([], "org/added", true, nextAddedNumber([], 0)).added;
  const labels = [modelNumberText(catalogue[0]), modelNumberText({ ...added[0], added: true })];
  assert.deepEqual(labels, ["#1", "+1"]);
  assert.equal(new Set(labels).size, 2);
});
