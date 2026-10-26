// Pure functions that turn one catalog entry into the plain text shown in a model row on the batch page.
// No DOM here, so the rules can be tested in node. A missing field is shown as "unknown", never as 0 or false,
// because a made-up number would look like a real one to the person reading the page.

const UNKNOWN = "unknown";
const UNRANKED = "unranked";
const NO_SCORE_BASIS = "no public score found";
const THOUSAND = 1000;
const MILLION = 1000000;

/**
 * Return the context window as plain text: "128K", "262K" or "1M". Counts are rounded down, so 262144 gives
 * "262K". Null, missing or not a positive number gives "unknown".
 */
export function formatContext(tokens) {
  if (!isPositiveNumber(tokens)) {
    return UNKNOWN;
  }
  // Below one thousand a K figure would round to 0K, so the exact count is shown instead.
  if (tokens < THOUSAND) {
    return String(Math.floor(tokens));
  }
  if (tokens >= MILLION) {
    return `${Math.floor(tokens / MILLION)}M`;
  }
  return `${Math.floor(tokens / THOUSAND)}K`;
}

/**
 * Return the reasoning label: "Reasoning" for "yes", "No reasoning" for "no". Any other value, including null,
 * gives "unknown", because only a sourced "no" may say the model does not reason.
 */
export function reasoningText(value) {
  if (value === "yes") {
    return "Reasoning";
  }
  if (value === "no") {
    return "No reasoning";
  }
  return UNKNOWN;
}

/**
 * Return a new array of the entries, ordered by industry_rank from 1 upward. Entries with no rank go last, in
 * name order, so no entry is dropped. Ties are broken by name. The input array is not changed.
 */
export function sortByRank(entries) {
  return [...entries].sort(compareByRank);
}

/**
 * Return true when a row has no details at all: no rank, context, reasoning or price. Such a row is a plain name from
 * a saved list, so its card shows the name alone instead of a row of "unknown" words.
 */
export function hasNoDetails(row) {
  return row.rank === UNRANKED && row.context === UNKNOWN && row.reasoning === UNKNOWN && row.price === UNKNOWN;
}

/**
 * Return the text for one model row: the rank ("#2" or "unranked"), the model id, the context window, the
 * reasoning label, the price line and the basis of the rank. Missing fields become "unknown".
 */
export function modelRowText(entry) {
  return {
    rank: rankText(rankOf(entry)),
    name: String(entry?.id ?? ""),
    context: formatContext(entry?.context_tokens),
    reasoning: reasoningText(entry?.reasoning),
    price: priceText(entry),
    basis: basisText(entry),
  };
}

/**
 * Return the text for one entry in the single-run model menu: its rank and short name, such as "#1 GLM-5.3",
 * or "unranked GLM-5.3" when it has no rank. Nothing else is added, so the menu stays easy to scan. The short
 * name is the id after the last slash.
 */
export function modelOptionLabel(entry) {
  return `${rankText(rankOf(entry))} ${shortName(entry?.id)}`;
}

/**
 * Return the catalogue number of a model as text, "#19", for every place that shows it: the picker card, the selected
 * line and the plan line. The number is set once per list (see withCatalogueNumbers in model-list.js), so it reads
 * the same whatever the picker is filtered or sorted by. A missing or non-whole number gives "unknown", never a guess.
 */
export function catalogueNumberText(entry) {
  const number = entry?.number;
  return Number.isInteger(number) && number > 0 ? `#${number}` : UNKNOWN;
}

/** Return the part of a model id after the last slash, such as "GLM-5.3" from "zai-org/GLM-5.3". */
function shortName(id) {
  return String(id ?? "").split("/").pop();
}

/** Return true for a finite number above zero. Strings and null are refused. */
function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Return the entry's rank when it is a whole number, or null. A rank stored as text is treated as missing. */
function rankOf(entry) {
  const rank = entry?.industry_rank;
  return Number.isInteger(rank) ? rank : null;
}

/** Return "#N" for a rank, or "unranked" when there is none. */
function rankText(rank) {
  return rank === null ? UNRANKED : `#${rank}`;
}

/**
 * Return the price as "$in / $out", such as "$0.15 / $0.6". The unit, per million tokens, is not repeated on every
 * row: the batch page shows it once in its column heading. A side with no price shows "unknown".
 */
function priceText(entry) {
  const input = priceSide(entry?.price_input_per_million_usd);
  const output = priceSide(entry?.price_output_per_million_usd);
  if (input === UNKNOWN && output === UNKNOWN) {
    return UNKNOWN;
  }
  return `${input} / ${output}`;
}

/** Return one price as "$0.15", or "unknown" when it is not a number. */
function priceSide(value) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value}` : UNKNOWN;
}

/** Return the rank's source line, or "no public score found" when the entry has none. */
function basisText(entry) {
  const basis = entry?.rank_basis;
  return typeof basis === "string" && basis.trim() !== "" ? basis : NO_SCORE_BASIS;
}

/** Order two entries: ranked before unranked, lower rank first, then by name. */
function compareByRank(a, b) {
  const rankA = rankOf(a);
  const rankB = rankOf(b);
  if (rankA !== rankB) {
    return compareRanks(rankA, rankB);
  }
  return compareNames(a, b);
}

/** Compare two ranks where null means unranked and sorts after every number. */
function compareRanks(rankA, rankB) {
  if (rankA === null) {
    return 1;
  }
  if (rankB === null) {
    return -1;
  }
  return rankA - rankB;
}

/** Compare two entries by id, by character code, so the order does not depend on the browser's locale. */
function compareNames(a, b) {
  const idA = String(a?.id ?? "");
  const idB = String(b?.id ?? "");
  if (idA === idB) {
    return 0;
  }
  return idA < idB ? -1 : 1;
}
