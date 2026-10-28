// Tests for frontend/js/sidebar-state.js: the collapsed or expanded sidebar choice and how it is saved.
// Storage is a small stand-in with getItem and setItem, so no browser is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SIDEBAR_STORAGE_KEY, nextSidebarState, readStoredSidebar, writeStoredSidebar } from "../frontend/js/sidebar-state.js";

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

test("the storage key is ordeal-sidebar-collapsed", () => {
  assert.equal(SIDEBAR_STORAGE_KEY, "ordeal-sidebar-collapsed");
});

test("nextSidebarState flips the collapsed flag", () => {
  assert.equal(nextSidebarState(false), true);
  assert.equal(nextSidebarState(true), false);
});

test("readStoredSidebar returns true only for a saved 'true'", () => {
  assert.equal(readStoredSidebar(fakeStorage({ [SIDEBAR_STORAGE_KEY]: "true" })), true);
  assert.equal(readStoredSidebar(fakeStorage({ [SIDEBAR_STORAGE_KEY]: "false" })), false);
  assert.equal(readStoredSidebar(fakeStorage({ [SIDEBAR_STORAGE_KEY]: "yes" })), false);
});

test("readStoredSidebar defaults to false when nothing is saved", () => {
  assert.equal(readStoredSidebar(fakeStorage()), false);
});

test("readStoredSidebar tolerates a missing or throwing storage", () => {
  assert.equal(readStoredSidebar(undefined), false);
  assert.equal(readStoredSidebar(null), false);
  assert.equal(readStoredSidebar(blockedStorage), false);
});

test("writeStoredSidebar saves the choice under the key and reads back the same", () => {
  const storage = fakeStorage();
  writeStoredSidebar(storage, true);
  assert.equal(storage.values.get(SIDEBAR_STORAGE_KEY), "true");
  assert.equal(readStoredSidebar(storage), true);
  writeStoredSidebar(storage, false);
  assert.equal(readStoredSidebar(storage), false);
});

test("writeStoredSidebar swallows errors from a blocked or missing storage", () => {
  assert.doesNotThrow(() => writeStoredSidebar(blockedStorage, true));
  assert.doesNotThrow(() => writeStoredSidebar(undefined, true));
});
