// Tests for frontend/js/suites/condition-text.js. The text under the "System prompt condition" dropdown is picked by pure
// functions, so these tests run in Node without a browser. The option names are read from the same config file the
// page loads, so a new option in the config fails here until it has a description.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONDITION_DESCRIPTIONS,
  NOT_DESCRIBED_TEXT,
  conditionDescriptionText,
  updateConditionDescription,
} from "../../frontend/js/suites/condition-text.js";

const config = JSON.parse(readFileSync(new URL("../../frontend/data/config.json", import.meta.url), "utf8"));
const optionValues = Object.keys(config.system_prompts);

// Every option the dropdown can show must have a real description, not the fallback.
test("every system prompt option in the config has its own description", () => {
  assert.ok(optionValues.length > 0, "the config should list at least one option");
  for (const value of optionValues) {
    assert.ok(Object.hasOwn(CONDITION_DESCRIPTIONS, value), `option "${value}" has no description`);
    assert.notEqual(conditionDescriptionText(value), NOT_DESCRIBED_TEXT, `option "${value}" shows the fallback`);
  }
});

// The "none" option means no system prompt is sent at all, so its text must say so.
test("none says that no system prompt is given", () => {
  assert.match(conditionDescriptionText("none"), /no system prompt/i);
});

// The text changes with the selection, so two different options never show the same words.
test("each option has different text, so the note changes when the selection changes", () => {
  const texts = optionValues.map((value) => conditionDescriptionText(value));
  assert.equal(new Set(texts).size, texts.length);
});

// An option this page does not know yet must still give words, never an empty box.
test("an unknown option gives the safe fallback text", () => {
  assert.equal(conditionDescriptionText("made_up_option"), NOT_DESCRIBED_TEXT);
  assert.notEqual(NOT_DESCRIBED_TEXT.trim(), "");
});

// An empty dropdown reads as "" and a missing value as undefined. Both get the fallback too.
test("an empty or missing value gives the fallback text", () => {
  assert.equal(conditionDescriptionText(""), NOT_DESCRIBED_TEXT);
  assert.equal(conditionDescriptionText(undefined), NOT_DESCRIBED_TEXT);
});

// A name such as "constructor" exists on every JavaScript object. It must not return a built-in property.
test("a built-in JavaScript property name gives the fallback text, not a function", () => {
  assert.equal(conditionDescriptionText("constructor"), NOT_DESCRIBED_TEXT);
});

// The element update writes plain text into the box under the dropdown.
test("updateConditionDescription writes the description into the element", () => {
  const element = { textContent: "" };
  updateConditionDescription(element, "mitigation");
  assert.equal(element.textContent, CONDITION_DESCRIPTIONS.mitigation);
});
