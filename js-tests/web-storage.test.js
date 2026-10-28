// Tests for the storage the Gauntlet and Batch pages open (persistence-ui.js). Node has no IndexedDB, so the page
// storage must fall back to memory and say so in plain words. Nothing touches a browser or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openPageStorage, storageText } from "../frontend/js/persistence-ui.js";

// Node has no IndexedDB, so this proves the fallback path: memory storage is used and flagged as a fallback.
test("without IndexedDB the page storage falls back to memory", async () => {
  const storage = await openPageStorage();
  assert.equal(storage.fallback, true);
  assert.equal(storage.adapter.kind, "memory");
});

// The storage notice shown to the user: it must warn that nothing survives a reload when in memory, and promise the key is never saved otherwise.
test("the fallback sentence says runs are not saved in this window", () => {
  assert.match(storageText(true), /Runs are not saved in this window/);
  assert.match(storageText(false), /survive a reload/);
  assert.match(storageText(false), /The key is never saved\./);
});
