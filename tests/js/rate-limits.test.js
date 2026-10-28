// Tests for frontend/js/rate-limits.js. The fixtures are shaped like ordeal/data/rate_limits.json (the console table)
// and like results/rate_limits.json (the observed values the backend writes). The functions are pure, so no DOM is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRateLimit, rateLimitSourceText, rateLimitRowFor, pacingRows } from "../../frontend/js/rate-limits.js";

// A small table in the same shape as the published file. Two models are enough to show the rules.
const TABLE = {
  checked: "2026-10-27",
  platform: "nebius",
  models: {
    "org/model-a": { requests_per_minute: 600, tokens_per_minute: 400000 },
    "org/model-big": { requests_per_minute: 3000, tokens_per_minute: 2000000 },
  },
};

test("formatRateLimit shows requests and tokens per minute, with K for thousands", () => {
  assert.equal(
    formatRateLimit({ requests_per_minute: 600, tokens_per_minute: 400000 }),
    "600 req/min · 400K tok/min",
  );
});

test("formatRateLimit shows M for millions and rounds down, as the context window does", () => {
  assert.equal(
    formatRateLimit({ requests_per_minute: 3000, tokens_per_minute: 2000000 }),
    "3K req/min · 2M tok/min",
  );
  // 1,999,999 is just under two million, so it rounds down to 1M rather than up to 2M.
  assert.equal(
    formatRateLimit({ requests_per_minute: 1000, tokens_per_minute: 1999999 }),
    "1K req/min · 1M tok/min",
  );
});

test("formatRateLimit keeps counts under one thousand exact instead of rounding them to 0K", () => {
  assert.equal(
    formatRateLimit({ requests_per_minute: 120, tokens_per_minute: 999 }),
    "120 req/min · 999 tok/min",
  );
});

test("formatRateLimit says no published limit for a model with no entry, never 0", () => {
  assert.equal(formatRateLimit(undefined), "no published limit");
  assert.equal(formatRateLimit(null), "no published limit");
  assert.doesNotMatch(formatRateLimit(null), /\b0\b/);
});

test("formatRateLimit shows unknown for a side that is missing or not a positive number", () => {
  assert.equal(
    formatRateLimit({ requests_per_minute: 600 }),
    "600 req/min · unknown tok/min",
  );
  assert.equal(
    formatRateLimit({ requests_per_minute: 0, tokens_per_minute: "400000" }),
    "unknown req/min · unknown tok/min",
  );
});

test("rateLimitSourceText names where the number came from", () => {
  assert.equal(rateLimitSourceText({ source: "headers" }), "read from the provider's reply headers");
  assert.equal(rateLimitSourceText({ source: "table" }), "from the console table");
  assert.equal(rateLimitSourceText({ source: "default" }), "default: unknown model");
});

test("rateLimitSourceText treats a published entry with no source field as the console table", () => {
  assert.equal(
    rateLimitSourceText({ requests_per_minute: 600, tokens_per_minute: 400000 }),
    "from the console table",
  );
});

test("rateLimitSourceText says default for a model with no entry, and not recorded for a source it does not know", () => {
  assert.equal(rateLimitSourceText(null), "default: unknown model");
  assert.equal(rateLimitSourceText({ source: "guess" }), "source not recorded");
});

test("rateLimitRowFor gives the text and the source for a model in the table", () => {
  assert.deepEqual(rateLimitRowFor(TABLE, "org/model-a"), {
    text: "600 req/min · 400K tok/min",
    source: "from the console table",
  });
});

test("rateLimitRowFor gives no published limit for a model not in the table", () => {
  assert.deepEqual(rateLimitRowFor(TABLE, "org/not-listed"), {
    text: "no published limit",
    source: "default: unknown model",
  });
});

test("rateLimitRowFor does not treat object names such as constructor as models", () => {
  assert.equal(rateLimitRowFor(TABLE, "constructor").text, "no published limit");
});

test("rateLimitRowFor says unknown when the rate limits file could not be read", () => {
  assert.deepEqual(rateLimitRowFor(null, "org/model-a"), {
    text: "unknown",
    source: "the rate limits file could not be read",
  });
});

test("pacingRows shows the table values, with not recorded for the observed columns when there is no observed data", () => {
  const rows = pacingRows(TABLE, null);
  assert.deepEqual(rows[0], {
    model: "org/model-a",
    requestsPerMinute: "600",
    tokensPerMinute: "400K",
    source: "from the console table",
    inFlightCap: "not recorded",
    latency: "not recorded",
  });
});

test("pacingRows uses the observed entry, with its source, cap and latency, when one exists", () => {
  const observed = {
    "org/model-a": {
      requests_per_minute: 1200,
      tokens_per_minute: 400000,
      source: "headers",
      in_flight_cap: 14,
      latency_seconds: 1.25,
    },
  };
  const rows = pacingRows(TABLE, observed);
  assert.equal(rows[0].requestsPerMinute, "1K");
  assert.equal(rows[0].source, "read from the provider's reply headers");
  assert.equal(rows[0].inFlightCap, "14");
  assert.equal(rows[0].latency, "1.25 s");
  // A model with no observed entry keeps the table values and says not recorded.
  assert.equal(rows[1].model, "org/model-big");
  assert.equal(rows[1].inFlightCap, "not recorded");
});

test("pacingRows lists an observed model that is not in the table after the table models", () => {
  const observed = {
    "org/extra": { requests_per_minute: 60, tokens_per_minute: 9000, source: "default", in_flight_cap: 1, latency_seconds: 2 },
  };
  const rows = pacingRows(TABLE, observed);
  assert.deepEqual(rows.map((row) => row.model), ["org/model-a", "org/model-big", "org/extra"]);
  assert.equal(rows[2].source, "default: unknown model");
});
