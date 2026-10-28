// Tests for frontend/js/ui/levels-drawer.js: when the levels drawer is open, and how that choice is saved.
// Storage is a small stand-in with getItem and setItem, so no browser is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DRAWER_STORAGE_KEY, readStoredDrawer, writeStoredDrawer } from "../../frontend/js/ui/levels-drawer.js";

/** A stand-in for localStorage that keeps values in a Map. */
function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

/** A storage whose every call throws, as happens when the browser blocks site data. */
const blockedStorage = {
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("blocked");
  },
};

test("the storage key is ordeal-levels-drawer", () => {
  assert.equal(DRAWER_STORAGE_KEY, "ordeal-levels-drawer");
});

test("readStoredDrawer returns false only for a saved 'false'", () => {
  assert.equal(readStoredDrawer(fakeStorage({ [DRAWER_STORAGE_KEY]: "false" })), false);
  assert.equal(readStoredDrawer(fakeStorage({ [DRAWER_STORAGE_KEY]: "true" })), true);
});

test("readStoredDrawer defaults to open (true) when nothing is saved", () => {
  assert.equal(readStoredDrawer(fakeStorage()), true);
});

test("readStoredDrawer defaults to open for an unknown saved value", () => {
  assert.equal(readStoredDrawer(fakeStorage({ [DRAWER_STORAGE_KEY]: "maybe" })), true);
});

test("readStoredDrawer tolerates a missing or throwing storage", () => {
  assert.equal(readStoredDrawer(undefined), true);
  assert.equal(readStoredDrawer(null), true);
  assert.equal(readStoredDrawer(blockedStorage), true);
});

test("writeStoredDrawer saves the choice under the key and reads back the same", () => {
  const storage = fakeStorage();
  writeStoredDrawer(storage, false);
  assert.equal(storage.values.get(DRAWER_STORAGE_KEY), "false");
  assert.equal(readStoredDrawer(storage), false);
  writeStoredDrawer(storage, true);
  assert.equal(storage.values.get(DRAWER_STORAGE_KEY), "true");
  assert.equal(readStoredDrawer(storage), true);
});

test("writeStoredDrawer does not throw when storage is blocked or missing", () => {
  assert.doesNotThrow(() => writeStoredDrawer(blockedStorage, false));
  assert.doesNotThrow(() => writeStoredDrawer(undefined, true));
  assert.doesNotThrow(() => writeStoredDrawer(null, false));
});
