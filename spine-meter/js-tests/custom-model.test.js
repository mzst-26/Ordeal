// Tests for site/js/engine/custom-model.js. The golden cases come from js-tests/fixtures/custom_model.json,
// which was written by running the Python rules in model_client.py (scripts/make_golden.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateCustomModel,
  isSafeCustomUrl,
  hostOfCustomUrl,
  modelNameProblem,
  CUSTOM_MODEL_REASONS,
  MODEL_NAME_REASONS,
} from "../site/js/engine/custom-model.js";
import { readJson } from "./helpers.js";

const fixture = readJson("js-tests/fixtures/custom_model.json");
const VALID_ENTRY = { name: "my-model", base_url: "https://example.com/v1/", model: "org/model" };

for (const item of fixture.cases) {
  test(`validateCustomModel agrees with model_client.py: ${item.name}`, () => {
    const result = validateCustomModel(item.input.entry, item.input.taken_names);
    assert.equal(result.ok, item.output.ok);
    if (!result.ok) {
      assert.ok(Object.values(CUSTOM_MODEL_REASONS).includes(result.reason));
    }
  });
}

test("a valid custom model gives exactly { ok: true }", () => {
  assert.deepEqual(validateCustomModel(VALID_ENTRY), { ok: true });
});

test("a plain http URL gives the URL reason", () => {
  const result = validateCustomModel({ ...VALID_ENTRY, base_url: "http://example.com/v1" });
  assert.deepEqual(result, { ok: false, reason: CUSTOM_MODEL_REASONS.url });
});

test("a URL with a user name and password gives the URL reason", () => {
  const result = validateCustomModel({ ...VALID_ENTRY, base_url: "https://user:secret@example.com/v1" });
  assert.deepEqual(result, { ok: false, reason: CUSTOM_MODEL_REASONS.url });
});

test("a URL with a query string gives the URL reason", () => {
  const result = validateCustomModel({ ...VALID_ENTRY, base_url: "https://example.com/v1?api_key=abc" });
  assert.deepEqual(result, { ok: false, reason: CUSTOM_MODEL_REASONS.url });
});

test("an empty or spaces-only name, model or base URL gives the blank-field reason", () => {
  for (const field of ["name", "model", "base_url"]) {
    const result = validateCustomModel({ ...VALID_ENTRY, [field]: "   " });
    assert.deepEqual(result, { ok: false, reason: CUSTOM_MODEL_REASONS.blankField }, field);
  }
});

test("a field that is not text gives the blank-field reason", () => {
  assert.deepEqual(validateCustomModel({ ...VALID_ENTRY, model: 12 }), {
    ok: false,
    reason: CUSTOM_MODEL_REASONS.blankField,
  });
});

test("a name that another model uses gives the duplicate reason", () => {
  const result = validateCustomModel(VALID_ENTRY, ["my-model", "org/built-in"]);
  assert.deepEqual(result, { ok: false, reason: CUSTOM_MODEL_REASONS.duplicateName });
});

test("a name equal to a built-in model name gives the duplicate reason", () => {
  const entry = { ...VALID_ENTRY, name: "org/built-in" };
  const result = validateCustomModel(entry, ["org/built-in"]);
  assert.deepEqual(result, { ok: false, reason: CUSTOM_MODEL_REASONS.duplicateName });
});

test("a base URL with a fragment gives the URL reason", () => {
  const entry = { ...VALID_ENTRY, base_url: "https://llm.example.org/v1#section" };
  assert.deepEqual(validateCustomModel(entry), { ok: false, reason: CUSTOM_MODEL_REASONS.url });
  assert.equal(isSafeCustomUrl("https://llm.example.org/v1#"), false);
});

test("a base URL with a trailing newline or another control character gives the URL reason", () => {
  for (const suffix of ["\n", "\r\n", "\t", "\u0000", "\u007f"]) {
    const entry = { ...VALID_ENTRY, base_url: `https://llm.example.org/v1${suffix}` };
    const result = validateCustomModel(entry);
    assert.deepEqual(result, { ok: false, reason: CUSTOM_MODEL_REASONS.url }, JSON.stringify(suffix));
  }
  assert.equal(hostOfCustomUrl("https://llm.example.org/v1\n"), null);
});

test("a typed model name over 200 characters, or shaped like a key, gets a fixed reason", () => {
  assert.equal(modelNameProblem("a".repeat(200)), null);
  assert.equal(modelNameProblem("a".repeat(201)), MODEL_NAME_REASONS.tooLong);
  assert.equal(modelNameProblem("v1." + "a".repeat(40)), MODEL_NAME_REASONS.keyShaped);
  assert.equal(modelNameProblem("v1." + "a".repeat(39)), null);
  assert.equal(modelNameProblem("Bearer abc"), MODEL_NAME_REASONS.keyShaped);
  assert.equal(modelNameProblem("org/model-name"), null);
});

test("a reason never repeats the name or the URL the user typed", () => {
  const typed = "https://secret-host.example/?token=zzz";
  const result = validateCustomModel({ ...VALID_ENTRY, name: "my-secret-name", base_url: typed });
  assert.equal(result.ok, false);
  assert.equal(result.reason.includes("secret"), false);
  assert.equal(result.reason.includes("zzz"), false);
});

test("the reasons are fixed strings, frozen so that nothing can change them", () => {
  assert.equal(Object.isFrozen(CUSTOM_MODEL_REASONS), true);
  for (const reason of Object.values(CUSTOM_MODEL_REASONS)) {
    assert.equal(typeof reason, "string");
    assert.ok(reason.length > 0);
  }
});

test("isSafeCustomUrl accepts an https host with a path and rejects everything else", () => {
  assert.equal(isSafeCustomUrl("https://api.example.com/v1"), true);
  assert.equal(isSafeCustomUrl("https://127.0.0.1:8443/v1"), true);
  assert.equal(isSafeCustomUrl("https:///v1"), false);
  assert.equal(isSafeCustomUrl("https://@example.com/v1"), false);
  assert.equal(isSafeCustomUrl(null), false);
});

test("hostOfCustomUrl gives the host and port of a safe URL, and null for any other URL", () => {
  assert.equal(hostOfCustomUrl("https://llm.example.org/v1/"), "llm.example.org");
  assert.equal(hostOfCustomUrl("https://127.0.0.1:8443/v1"), "127.0.0.1:8443");
  assert.equal(hostOfCustomUrl("http://llm.example.org/v1"), null);
  assert.equal(hostOfCustomUrl("https://user:pw@llm.example.org/v1"), null);
  assert.equal(hostOfCustomUrl("https://llm.example.org/v1?key=1"), null);
  assert.equal(hostOfCustomUrl(undefined), null);
});
