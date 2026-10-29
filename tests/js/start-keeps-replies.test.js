// Guards the batch page's Start against throwing away paid replies. A Start must never clear the reply cache or delete
// anything, must load every usable saved reply first, and must refuse to run when those replies cannot be read. Only a
// restart from scratch forgets replies, on purpose. These checks read the page's source, so a later edit that brings back
// a clear or a delete on the Start path fails here, before it reaches a user.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(fileURLToPath(new URL("../../frontend/js/pages/page-batch.js", import.meta.url)), "utf8");

/** Return the source from the start marker up to the end marker, without either marker. */
function between(startMarker, endMarker) {
  const start = SOURCE.indexOf(startMarker);
  const end = SOURCE.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `the page must have "${startMarker}" before "${endMarker}"`);
  return SOURCE.slice(start + startMarker.length, end);
}

test("the batch page never clears its reply cache", () => {
  assert.equal(SOURCE.includes("page.cache.clear("), false);
});

test("a Start never deletes a saved run, removes a stored record, or clears the reply cache, and loads the saved replies first", () => {
  // The in-memory buffer of steps for units still running is cleared on a Start. It holds nothing saved, so it is allowed.
  const start = between("async function beginRun(", "async function startConditionRun(");
  assert.equal(/deleteRun\(|removeRecord\(|cache\.clear\(/.test(start), false, "beginRun must not delete or clear saved data");
  assert.ok(start.includes("loadSavedReplies("), "beginRun must load the saved replies first");
});

test("a failed read refuses the Start and says that no call was made", () => {
  const load = between("async function loadSavedReplies(", "/**\n * Forget the replies");
  assert.ok(load.includes("No call was made."));
  assert.ok(load.includes("return false"));
});

test("only a restart from scratch forgets replies: the forget call is made from one place, behind that flag", () => {
  // One definition and one call. The call is inside startConditionRun, where it is gated on choices.fromScratch.
  assert.equal(SOURCE.split("forgetRepliesOf(").length - 1, 2);
  assert.ok(between("async function startConditionRun(", "function forgetRepliesOf").includes("if (choices.fromScratch)"));
});
