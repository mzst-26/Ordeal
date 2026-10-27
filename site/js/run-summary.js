// The batch summary that is saved to the server. A batch can hold thousands of replies, so the server gets only the
// small part a reader needs: the totals, the names of the measures, and each ticked model's numbers. The full batch
// data stays in this browser and can still be downloaded from the Export section. This file is pure: it builds a
// plain object and sends nothing.

/** Return the number, or null when the value is not a finite number. A JSON record cannot hold NaN or Infinity. */
function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/** Return the measure definitions the summary needs: the key, the label, the decimal digits and the direction. */
function measureSummaries(measures) {
  return measures.map((measure) => ({
    key: measure.key,
    label: measure.label,
    digits: measure.digits,
    higherIsBetter: measure.higherIsBetter,
  }));
}

/** Return one model's numbers. Only the model id and the measure values are kept, so no other field gets saved. */
function modelSummary(row, measures) {
  const values = {};
  for (const measure of measures) {
    values[measure.key] = numberOrNull(row.measures[measure.key]);
  }
  return { model: row.model, measures: values };
}

/**
 * Build the batch summary from the page's results. label names the batch, createdAt is the save time in
 * milliseconds, totals counts the models, questions and replies, measures lists the gauntlet measures shown, and
 * models is one analytics row per ticked model (with its measure values, or null where there is none).
 */
export function batchSummary({ label, createdAt, totals, measures, models }) {
  return {
    label,
    createdAt,
    totals: { models: totals.models, questions: totals.questions, replies: totals.replies },
    measures: measureSummaries(measures),
    models: models.map((row) => modelSummary(row, measures)),
  };
}
