// Tests for site/js/model-details.js. The entries here are small fixtures shaped like the catalog in
// config.json, with the four fields from Task A (context_tokens, reasoning, industry_rank, rank_basis).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatContext,
  reasoningText,
  sortByRank,
  modelRowText,
  modelOptionLabel,
} from "../site/js/model-details.js";

const FULL_ENTRY = {
  id: "org/model-a",
  kind: "text",
  price_input_per_million_usd: 0.15,
  price_output_per_million_usd: 0.6,
  context_tokens: 128000,
  reasoning: "yes",
  industry_rank: 2,
  rank_basis: "Artificial Analysis Intelligence Index, checked 2026-10-24, score 61",
};

const EMPTY_ENTRY = {
  id: "org/model-empty",
  kind: "text",
  price_input_per_million_usd: null,
  price_output_per_million_usd: null,
  context_tokens: null,
  reasoning: null,
  industry_rank: null,
  rank_basis: null,
};

// formatContext: token counts as short text; a missing or non-positive count reads "unknown", never "0K".
test("formatContext shows 128000 tokens as 128K", () => {
  assert.equal(formatContext(128000), "128K");
});

test("formatContext shows 1000000 tokens as 1M", () => {
  assert.equal(formatContext(1000000), "1M");
});

test("formatContext rounds 262144 tokens down to 262K", () => {
  assert.equal(formatContext(262144), "262K");
});

test("formatContext shows null as unknown, never 0K", () => {
  assert.equal(formatContext(null), "unknown");
});

test("formatContext shows a missing value as unknown", () => {
  assert.equal(formatContext(undefined), "unknown");
});

test("formatContext shows a zero or negative count as unknown", () => {
  assert.equal(formatContext(0), "unknown");
  assert.equal(formatContext(-5), "unknown");
});

// reasoningText: only "yes" and "no" are known values; anything else, including null, reads "unknown".
test("reasoningText maps yes to Reasoning", () => {
  assert.equal(reasoningText("yes"), "Reasoning");
});

test("reasoningText maps no to No reasoning", () => {
  assert.equal(reasoningText("no"), "No reasoning");
});

test("reasoningText maps null to unknown, never to false", () => {
  assert.equal(reasoningText(null), "unknown");
});

test("reasoningText maps any other word to unknown", () => {
  assert.equal(reasoningText("maybe"), "unknown");
});

// sortByRank: lowest rank first, unranked last, ties broken by name, and the input is not changed.
test("sortByRank puts the lowest rank first", () => {
  const entries = [
    { id: "c", industry_rank: 3 },
    { id: "a", industry_rank: 1 },
    { id: "b", industry_rank: 2 },
  ];
  assert.deepEqual(sortByRank(entries).map((entry) => entry.id), ["a", "b", "c"]);
});

test("sortByRank puts a null rank last, after every ranked model", () => {
  const entries = [
    { id: "zeta", industry_rank: null },
    { id: "beta", industry_rank: 2 },
    { id: "alpha", industry_rank: 1 },
  ];
  assert.deepEqual(sortByRank(entries).map((entry) => entry.id), ["alpha", "beta", "zeta"]);
});

test("sortByRank puts a missing rank last too, and keeps the model", () => {
  const entries = [{ id: "no-rank-field" }, { id: "ranked", industry_rank: 1 }];
  const sorted = sortByRank(entries);
  assert.equal(sorted.length, 2);
  assert.deepEqual(sorted.map((entry) => entry.id), ["ranked", "no-rank-field"]);
});

test("sortByRank orders unranked models by name", () => {
  const entries = [{ id: "delta", industry_rank: null }, { id: "bravo" }, { id: "charlie", industry_rank: null }];
  assert.deepEqual(sortByRank(entries).map((entry) => entry.id), ["bravo", "charlie", "delta"]);
});

test("sortByRank breaks a tie by name", () => {
  const entries = [{ id: "second", industry_rank: 5 }, { id: "first", industry_rank: 5 }];
  assert.deepEqual(sortByRank(entries).map((entry) => entry.id), ["first", "second"]);
});

test("sortByRank returns a new array and leaves the input in its order", () => {
  const entries = [{ id: "b", industry_rank: 2 }, { id: "a", industry_rank: 1 }];
  const before = entries.map((entry) => entry.id);
  const sorted = sortByRank(entries);
  assert.notEqual(sorted, entries);
  assert.deepEqual(entries.map((entry) => entry.id), before);
});

// modelRowText and modelOptionLabel: the text shown in the model table and dropdown,
// including entries from older catalogs that lack the newer fields.
test("modelRowText gives #N, the id, and the formatted fields for a full entry", () => {
  assert.deepEqual(modelRowText(FULL_ENTRY), {
    rank: "#2",
    name: "org/model-a",
    context: "128K",
    reasoning: "Reasoning",
    price: "$0.15 / $0.6",
    basis: "Artificial Analysis Intelligence Index, checked 2026-10-24, score 61",
  });
});

test("modelRowText shows unknown values when every field is null", () => {
  assert.deepEqual(modelRowText(EMPTY_ENTRY), {
    rank: "unranked",
    name: "org/model-empty",
    context: "unknown",
    reasoning: "unknown",
    price: "unknown",
    basis: "no public score found",
  });
});

test("modelRowText handles an old catalog entry with none of the new fields", () => {
  const oldEntry = { id: "org/old", kind: "text", price_input_per_million_usd: 1, price_output_per_million_usd: 2 };
  const row = modelRowText(oldEntry);
  assert.equal(row.rank, "unranked");
  assert.equal(row.context, "unknown");
  assert.equal(row.reasoning, "unknown");
  assert.equal(row.basis, "no public score found");
  assert.equal(row.price, "$1 / $2");
});

test("modelRowText marks a price side it does not have as unknown", () => {
  const row = modelRowText({ id: "org/half", price_input_per_million_usd: 0.5 });
  assert.equal(row.price, "$0.5 / unknown");
});

test("modelOptionLabel gives the rank and the short name, such as #1 GLM-5.3", () => {
  const entry = { id: "zai-org/GLM-5.3", industry_rank: 1 };
  assert.equal(modelOptionLabel(entry), "#1 GLM-5.3");
});

test("modelOptionLabel shows unranked when the entry has no rank", () => {
  assert.equal(modelOptionLabel({ id: "org/model-x", industry_rank: null }), "unranked model-x");
});

test("modelOptionLabel adds nothing else, such as the kind or the price", () => {
  const entry = { id: "org/model-y", kind: "vision", industry_rank: 4, price_input_per_million_usd: 0.3 };
  assert.equal(modelOptionLabel(entry), "#4 model-y");
});

test("a list sorted by sortByRank gives option labels in rank order from #1 upward", () => {
  const entries = [
    { id: "org/c", industry_rank: 3 },
    { id: "org/none", industry_rank: null },
    { id: "org/a", industry_rank: 1 },
    { id: "org/b", industry_rank: 2 },
  ];
  const labels = sortByRank(entries).map(modelOptionLabel);
  assert.deepEqual(labels, ["#1 a", "#2 b", "#3 c", "unranked none"]);
});
