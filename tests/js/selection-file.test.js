// Tests for the selection files of the batch popups. A file holds only the ticked ids of one kind, in JSON or JSON
// Lines, and must load back in either format. Nothing here touches a browser or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectionToText, parseSelectionText } from "../../frontend/js/ui/selection-files.js";

test("models written as JSON load back in the same order", () => {
  const text = selectionToText("model", ["M1", "M2"], "json");
  assert.deepEqual(parseSelectionText(text, "model"), ["M1", "M2"]);
});

test("questions written as JSON Lines load back, one object per line", () => {
  const text = selectionToText("question", ["m01", "m02"], "jsonl");
  assert.equal(text, '{"type":"question","id":"m01"}\n{"type":"question","id":"m02"}\n');
  assert.deepEqual(parseSelectionText(text, "question"), ["m01", "m02"]);
});

test("a single JSON Lines row is read as one id, not as a JSON object without a list", () => {
  const text = '{"type":"model","id":"M1"}\n';
  assert.deepEqual(parseSelectionText(text, "model"), ["M1"]);
});

test("a repeated id is kept once", () => {
  const text = '{"type":"model","id":"M1"}\n{"type":"model","id":"M1"}\n';
  assert.deepEqual(parseSelectionText(text, "model"), ["M1"]);
});

test("a file of the other kind is refused, so questions never tick models", () => {
  const text = selectionToText("question", ["m01"], "json");
  assert.throws(() => parseSelectionText(text, "model"), /holds question selections, not model selections/);
});

test("an empty file is refused with a plain reason", () => {
  assert.throws(() => parseSelectionText("  \n", "model"), /The file is empty/);
});

test("text that is neither JSON nor JSON Lines is refused", () => {
  assert.throws(() => parseSelectionText("M1, M2", "model"), /not JSON or JSON Lines/);
});

test("an id that is not text is refused", () => {
  const text = '{"type":"model","ids":[42]}';
  assert.throws(() => parseSelectionText(text, "model"), /not text/);
});

test("a file with no kind is refused", () => {
  assert.throws(() => parseSelectionText('{"ids":["M1"]}', "model"), /does not say what kind/);
});

test("an unknown format is refused when writing", () => {
  assert.throws(() => selectionToText("model", ["M1"], "csv"), /Unknown selection format/);
});
