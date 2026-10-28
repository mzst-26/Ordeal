// The rules that decide the order and the picks in the Batch fingerprint figure when many models are run together.
// The Summary shows one row per model, and the Chart and Table show one probe at a time. This file works out which
// model comes first, which probe a model flips on most, and which models come first for one probe. These are pure
// functions with no DOM, so the tests can check them without a browser. Every view reads the same cells from
// fingerprint-summary.js, so the numbers match in all three views.

/**
 * The cells for a model that count towards its rate: the probes it was run on, with at least one question behind
 * them. A probe with no replies is "not run" and is left out, so it cannot pull the rate down to zero.
 */
function countedCells(model) {
  return model.cells.filter((cell) => !cell.notRun && cell.units > 0);
}

/**
 * Average one number over some cells, with each cell weighted by its number of questions. A probe based on 50
 * questions should count for more than one based on 5. Returns null if any cell has no value, so a missing bound
 * is never averaged in as zero.
 */
function weightedAverage(cells, valueOf) {
  let total = 0;
  let sum = 0;
  for (const cell of cells) {
    const value = valueOf(cell);
    if (value === null) {
      return null;
    }
    sum += value * cell.units;
    total += cell.units;
  }
  return total === 0 ? null : sum / total;
}

/**
 * Return a model's overall flip rate across the probes it was run on, with its range. The rate is the question-
 * weighted average of the probe rates. The range is the same weighted average of the probe bounds. That is not a
 * true interval for the overall rate, but it is never narrower than the probes it comes from, and it is honest
 * about the spread. A model with no counted probe is "not run", with no numbers.
 */
export function overallRate(model) {
  const cells = countedCells(model);
  if (cells.length === 0) {
    return { notRun: true, estimate: null, low: null, high: null };
  }
  return {
    notRun: false,
    estimate: weightedAverage(cells, (cell) => cell.estimate),
    low: weightedAverage(cells, (cell) => cell.lowValue),
    high: weightedAverage(cells, (cell) => cell.highValue),
  };
}

/**
 * Return the probe cell where a model flips most, or null when it was run on no probe. A tie goes to the earlier
 * probe, because the probes are in first-seen order. That keeps the pick the same every time the page is drawn.
 */
export function mostFlipsCell(model) {
  let best = null;
  for (const cell of countedCells(model)) {
    if (best === null || cell.estimate > best.estimate) {
      best = cell;
    }
  }
  return best;
}

/**
 * Compare two rates, highest first. A rate of null means "not run", and it sorts after every real rate, so the
 * models that were not run always come last.
 */
function compareRates(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/**
 * Sort items with a rate and a model, highest rate first. Items with the same rate, or both not run, are put in
 * name order, so the list reads the same way on every redraw. rateOf returns the rate for one item.
 */
function sortByRate(items, rateOf) {
  return items
    .slice()
    .sort((a, b) => compareRates(rateOf(a), rateOf(b)) || a.model.name.localeCompare(b.model.name));
}

/**
 * Return the Summary rows: one per model, highest overall rate first, not run models last. Each row holds the
 * model, its overall rate and the probe where it flips most, so the Summary can draw a row without more work.
 */
export function rankModels(models) {
  const items = models.map((model) => ({ model, overall: overallRate(model), most: mostFlipsCell(model) }));
  return sortByRate(items, (item) => item.overall.estimate);
}

/**
 * Return the rows for one probe: each model with its cell for that probe, highest rate first, not run models
 * last. The Chart and the Table both draw from these rows, so they show the same order.
 */
export function rowsForProbe(models, probeId) {
  const items = models.map((model) => ({
    model,
    cell: model.cells.find((cell) => cell.probe === probeId),
  }));
  return sortByRate(items, (item) => (item.cell && !item.cell.notRun ? item.cell.estimate : null));
}

/**
 * Return the probe to show in the Chart and Table. It keeps the probe the visitor already chose, if that probe is
 * still in the run. Otherwise it is the first probe. With no probes at all it is null.
 */
export function chooseProbe(probes, currentId) {
  if (probes.some((item) => item.probe === currentId)) {
    return currentId;
  }
  return probes.length > 0 ? probes[0].probe : null;
}
