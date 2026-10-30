// Row builders for the Vega-Lite comparison views. Pure functions, no DOM, so the node tests can run them.
// Vega-Lite draws one mark per row, so the compare data (one object per model, with nested blocks) is first
// flattened into long rows: one row per model and condition, or one row per model and question.
// A value that was not run, or is NaN, becomes null here. A null row is left out of the chart, so a missing
// value is never drawn as zero.

// The pressure measure for the condition rows: the flip rate at the last level of the whole pressure ladder.
// The pushback dimension uses it so the differences rule can tell the ladder apart from a single pushback kind.
export const LADDER_PUSHBACK = "ladder";
// The provider shown when a model's replies were saved before the provider field existed.
const UNKNOWN_PROVIDER = "unknown";
// The conditions used when the data does not list them. The page's three conditions, in the order the switch shows them.
const DEFAULT_CONDITIONS = Object.freeze(["none", "mitigation", "control"]);

/** The value as a finite number, or null. NaN, infinities, null and undefined all become null. */
export function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The name a model is shown under: its display name, or its id when it has none. */
export function modelLabel(model) {
  return model.display_name || model.id;
}

/** The provider of a model, or "unknown" when the data does not name one. */
function providerOf(model) {
  return model.provider || UNKNOWN_PROVIDER;
}

/** The flip-rate fields of one Rate, as a row fragment. A missing Rate gives all-null fields. */
function rateFields(rate) {
  if (!rate) {
    return { rate: null, low: null, high: null, n: null };
  }
  return {
    rate: finiteOrNull(rate.rate),
    low: finiteOrNull(rate.ci_low),
    high: finiteOrNull(rate.ci_high),
    n: finiteOrNull(rate.n),
  };
}

/**
 * One row per model and condition: the flip rate at the last level under that condition, with its interval.
 * Used by the small multiples and the dot plot. The conditions come from the data, in the data's order.
 */
export function conditionRows(models, data) {
  const conditions = (data && data.conditions) || DEFAULT_CONDITIONS;
  const suite = (data && data.suite) || "unknown";
  const rows = [];
  for (const model of models || []) {
    for (const condition of conditions) {
      const block = model.mitigation ? model.mitigation[condition] : null;
      rows.push({
        modelId: model.id,
        model: modelLabel(model),
        family: model.family || null,
        provider: providerOf(model),
        condition,
        questionSet: suite,
        pushback: LADDER_PUSHBACK,
        ...rateFields(block ? block.flip_rate_last : null),
      });
    }
  }
  return rows;
}

/**
 * One row per model and question: the flip rate at the last level for that question, with its count.
 * Used by the heatmap. A question the model has no data for has no row, so its heatmap cell stays empty.
 */
export function questionRows(models, data) {
  const suite = (data && data.suite) || "unknown";
  const rows = [];
  for (const model of models || []) {
    for (const entry of model.question_flip_rates || []) {
      const fields = rateFields(entry.flip_rate_last);
      rows.push({
        modelId: model.id,
        model: modelLabel(model),
        provider: providerOf(model),
        questionId: entry.question_id,
        questionSet: suite,
        rate: fields.rate,
        n: fields.n,
      });
    }
  }
  return rows;
}
