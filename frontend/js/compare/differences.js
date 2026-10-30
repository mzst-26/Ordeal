// "Differences only" rule for the comparison views. Pure functions, no DOM, so the node tests can run them.
// The rule looks at the rows a view would draw, counts the distinct values of each dimension, and keeps only the
// dimensions that vary. A dimension with one value is constant, so it is left out of the facets and the colour.
// Why: a chart that repeats the same value on every panel or in every colour says nothing, and hides the
// comparison the reader came for.

/** The five dimensions a row can vary on, in the fixed order used for every tie-break. */
export const DIMENSIONS = Object.freeze(["model", "provider", "condition", "questionSet", "pushback"]);

// FACET_ORDER: when several dimensions vary, the first one here becomes the panels (facets). Provider and question
// set come first, because a reader compares providers or difficulty by panel. The model comes last, because a
// model is what the bars and dots already show.
const FACET_ORDER = Object.freeze(["provider", "questionSet", "condition", "pushback", "model"]);
// COLOUR_ORDER: the first varying dimension here that is not the facet becomes the colour.
const COLOUR_ORDER = Object.freeze(["model", "condition", "pushback", "questionSet", "provider"]);

// The message for a view with no rows, and for a view where no dimension changes.
const NO_ROWS_MESSAGE = "No rows match the current filters, so there is nothing to compare.";
const NOTHING_VARIES_MESSAGE =
  "Nothing varies across the rows in view: every row has the same model, provider, condition, question set "
  + "and pushback set. Turn off differences only to see the full view.";

/**
 * The number of distinct values a dimension takes across the rows. A missing value (null or undefined)
 * counts as one value of its own, so a row without a provider still makes provider vary against the others.
 */
export function distinctCount(rows, dimension) {
  const values = new Set();
  for (const item of rows || []) {
    const value = item[dimension];
    values.add(value === null || value === undefined ? "\u0000missing" : String(value));
  }
  return values.size;
}

/** The dimensions that take more than one value across the rows, in DIMENSIONS order. */
export function varyingDimensions(rows) {
  return DIMENSIONS.filter((dimension) => distinctCount(rows, dimension) > 1);
}

/** The first dimension in the order list that is in the varying list and is not excluded. Null when none is. */
function firstVarying(order, varying, excluded) {
  return order.find((dimension) => varying.includes(dimension) && dimension !== excluded) || null;
}

/**
 * The first dimension in the order list that varies, is not excluded, and has no more values than the series cap.
 * A colour with too many values would need hues the page does not validate, so such a dimension is skipped.
 */
function firstColourable(order, varying, excluded, rows, maxSeries) {
  return order.find((dimension) => varying.includes(dimension) && dimension !== excluded
    && distinctCount(rows, dimension) <= maxSeries) || null;
}

/**
 * The view for the rows in view. The options are optional: maxSeries is the most values a colour may have (default:
 * no limit). Returns:
 *   varying: the dimensions that change, in DIMENSIONS order;
 *   dropped: the constant dimensions, which are not shown as facets or colour;
 *   facet:   the dimension that splits the view into panels, or null;
 *   colour:  the dimension that colours the marks, or null;
 *   message: text to show instead of a chart when nothing varies, or empty when a view can be drawn.
 * With one varying dimension it is the colour, when it fits the cap, and there are no panels. With two or more, the
 * first in FACET_ORDER is the panels and the first other one in COLOUR_ORDER that fits the cap is the colour.
 */
export function chooseDifferenceView(rows, options) {
  const list = rows || [];
  if (list.length === 0) {
    return { varying: [], dropped: [...DIMENSIONS], facet: null, colour: null, message: NO_ROWS_MESSAGE };
  }
  const varying = varyingDimensions(list);
  const dropped = DIMENSIONS.filter((dimension) => !varying.includes(dimension));
  if (varying.length === 0) {
    return { varying, dropped, facet: null, colour: null, message: NOTHING_VARIES_MESSAGE };
  }
  const maxSeries = (options && options.maxSeries) || Number.POSITIVE_INFINITY;
  if (varying.length === 1) {
    const colour = firstColourable(COLOUR_ORDER, varying, null, list, maxSeries);
    return { varying, dropped, facet: null, colour, message: "" };
  }
  const facet = firstVarying(FACET_ORDER, varying, null);
  const colour = firstColourable(COLOUR_ORDER, varying, facet, list, maxSeries);
  return { varying, dropped, facet, colour, message: "" };
}
