// Tests for frontend/js/models/typed-model-check.js: the check a typed model name gets before a page uses it.
// No key is saved in these tests, so the platform list is never read and no request is made. The name is then
// accepted as "not checked", or refused by the format rules, which are the same on every page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTypedName, choiceOutcomeText } from "../../frontend/js/models/typed-model-check.js";
import { platformList, findPlatform } from "../../frontend/js/models/platforms.js";
import { readJson } from "./helpers.js";

const PLATFORMS = platformList(readJson("frontend/data/providers.json"));
const HF = findPlatform(PLATFORMS, "huggingface");

test("checkTypedName refuses an empty name with a plain message and no model", async () => {
  const result = await checkTypedName(HF, "   ");
  assert.equal(result.ok, false);
  assert.match(result.message, /Give a model id/);
  assert.equal(result.model, undefined);
});

test("checkTypedName refuses a file path, so no path can become the model", async () => {
  const result = await checkTypedName(HF, "/etc/passwd");
  assert.equal(result.ok, false);
  assert.match(result.message, /file path/);
});

test("checkTypedName accepts a well-formed name as not checked when no key is saved", async () => {
  const result = await checkTypedName(HF, "org/fresh");
  assert.equal(result.ok, true);
  assert.equal(result.model, "org/fresh");
  assert.equal(result.checked, false);
  assert.match(result.message, /not checked/);
});

test("choiceOutcomeText says the name is the model, and whether the platform list has it", () => {
  assert.equal(
    choiceOutcomeText({ model: "org/name", checked: true }),
    "org/name is now the model. The platform list has it.",
  );
  assert.match(choiceOutcomeText({ model: "org/name", checked: false }), /It is not checked/);
});
