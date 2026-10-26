// Plain-language rules for the Batch fingerprint figure: the wording for each probe, the rate text, the
// "not run yet" choice and the cells that the Summary, Chart and Table views all draw from. Every view reads
// the same cells, so the three views always show the same numbers. These are pure functions with no DOM, so
// the tests can check the wording without a browser.

// The text shown for a probe and model that has no replies yet. It is words, not an axis label, so it
// never overlaps another label.
export const NOT_RUN_TEXT = "Not run yet";

// The twelve probes in the fingerprint family, in the order the figure lists them. Each one pushes the model
// in a different way, so the phrases below say what the push was, in words a non-technical reader can follow.
export const FINGERPRINT_PROBES = [
  "bare", "doubt_only", "quote_mine", "oracle", "trojan", "authority",
  "consensus", "unity", "affect_stakes", "flattery", "elite_bait", "commitment",
];

// One plain phrase per probe. Each completes the sentence "The model ... " in the summary. They describe the
// push in ordinary words; the probe ids stay in the data and the table. A probe with no phrase here falls
// back to its id, so a new probe still shows up rather than vanishing.
const PROBE_PHRASES = {
  bare: "Changed its answer after being told it was wrong",
  doubt_only: "Changed its answer after only being asked if it was sure",
  quote_mine: "Changed its answer after its own hedge was quoted back to it",
  oracle: "Changed its answer after being told a trusted source disagreed",
  trojan: "Changed its answer after being shown a worked solution with a wrong step",
  authority: "Changed its answer after being told a professor disagreed",
  consensus: "Changed its answer after being told most students picked another answer",
  unity: "Changed its answer after being asked to agree as one team",
  affect_stakes: "Changed its answer after being told a lot was at stake and time was short",
  flattery: "Changed its answer after being flattered about its care",
  elite_bait: "Changed its answer after being told experts pick another answer",
  commitment: "Changed its answer after being reminded it had agreed to change a wrong step",
};

/** True when a value is a finite number. Missing replies are stored as NaN, so this is how a number is told apart. */
function isUsable(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Return the plain phrase for a probe. An unknown probe gets its id with the underscores turned into spaces,
 * so the sentence still reads, and the missing phrase is easy to spot in review.
 */
export function probePhrase(probe) {
  return PROBE_PHRASES[probe] ?? String(probe).replace(/_/g, " ");
}

/**
 * Return a rate as a whole percent, such as "25%". Rounding to a whole percent keeps the text short; the table
 * view holds the same numbers if someone needs a finer figure.
 */
export function percentText(value) {
  return `${Math.round(value * 100)}%`;
}

/**
 * True when there is no rate to show for a probe and model. This happens when the batch has no replies for that
 * pair, so the row is missing or its rate is NaN. A rate of exactly zero is a real result and is not "not run".
 */
export function isNotRun(row) {
  return row === undefined || !isUsable(row.estimate);
}

/**
 * Write the one-sentence summary for a probe and model. Every view uses this one template, so the wording is
 * the same everywhere. The range is left out when its bounds are missing, rather than printing "NaN%".
 */
export function summarySentence(probe, row) {
  const phrase = probePhrase(probe);
  if (isNotRun(row)) {
    return `${phrase}: ${NOT_RUN_TEXT.toLowerCase()}.`;
  }
  const rate = `${percentText(row.estimate)} of the time`;
  if (!isUsable(row.low) || !isUsable(row.high)) {
    return `${phrase}: ${rate}.`;
  }
  return `${phrase}: ${rate} (95% range ${percentText(row.low)} to ${percentText(row.high)}).`;
}

/**
 * Build one cell: the numbers and the text for one probe and one model. The chart draws the bar from
 * estimate, low and high, and shows text, while the summary and table show the same text and sentence.
 */
function buildCell(probe, row) {
  const notRun = isNotRun(row);
  return {
    probe,
    phrase: probePhrase(probe),
    notRun,
    text: notRun ? NOT_RUN_TEXT : percentText(row.estimate),
    low: !notRun && isUsable(row.low) ? percentText(row.low) : "",
    high: !notRun && isUsable(row.high) ? percentText(row.high) : "",
    estimate: notRun ? null : row.estimate,
    lowValue: notRun || !isUsable(row.low) ? null : row.low,
    highValue: notRun || !isUsable(row.high) ? null : row.high,
    units: notRun || !isUsable(row.units) ? 0 : row.units,
    sentence: summarySentence(probe, row),
  };
}

/**
 * Build the view for the figure: one entry per probe (in first-seen order) and, for each model in the order
 * given, its cells in the same probe order. Each model keeps its index, which the figure uses to pick its
 * colour, so a model keeps its colour when the list of ticked models changes.
 */
export function buildFingerprintView(rows, models) {
  // Index the rows by model and probe so each lookup is one step rather than a search through all rows.
  const byPair = new Map();
  const probes = [];
  for (const row of rows) {
    byPair.set(`${row.model}\u0000${row.probe}`, row);
    if (!probes.includes(row.probe)) probes.push(row.probe);
  }
  return {
    probes: probes.map((probe) => ({ probe, phrase: probePhrase(probe) })),
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      index: model.index,
      cells: probes.map((probe) => buildCell(probe, byPair.get(`${model.id}\u0000${probe}`))),
    })),
  };
}
