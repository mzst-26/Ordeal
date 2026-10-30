// Which models an enlarged chart shows, and how the models rank. Nothing here reads the DOM, so the tests run it in Node.
// The enlarged chart in chart-popup.js uses these to filter the models out, and to keep the best or the worst few.

/** The name of the mean line on the level curve. It is a filter like a model, but it is not a model, so it is never ranked. */
export const MEAN_NAME = "Mean of models";

/** The name of each model a chart shows, in the order it is drawn. A scatter chart names its models by label. */
export function modelNames(options) {
  if (Array.isArray(options.series)) return options.series.map((item) => item.name);
  if (Array.isArray(options.points)) return options.points.map((point) => point.label);
  return [];
}

/**
 * Return the options with only the models whose names are in keptNames. A line or bar chart keeps its series, and a
 * scatter chart keeps its points. A chart with neither has no models to filter, so it comes back unchanged.
 */
export function filterChartOptions(options, keptNames) {
  if (Array.isArray(options.series)) {
    return { ...options, series: options.series.filter((item) => keptNames.has(item.name)) };
  }
  if (Array.isArray(options.points)) {
    return { ...options, points: options.points.filter((point) => keptNames.has(point.label)) };
  }
  return options;
}

/** The average of the finite numbers in a list, or NaN when there are none. */
function meanFinite(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return Number.NaN;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

/**
 * The performance of one model in a chart. A chart of flip rates scores a model by the mean of its flip rates, and lower
 * is better (options.lowerIsBetter is true). A twin-probe chart scores a model by its hit rate minus its false alarm
 * rate, and higher is better. A model with no finite value scores NaN.
 */
function scoreOf(item, options) {
  if (Array.isArray(options.points)) {
    return Number.isFinite(item.y) && Number.isFinite(item.x) ? item.y - item.x : Number.NaN;
  }
  return meanFinite(item.values ?? item.valuesByGroup ?? []);
}

/**
 * The model names ranked best first. A model with no score is ranked last, whichever way the chart counts as better.
 */
export function rankedModels(options) {
  const items = Array.isArray(options.series) ? options.series : Array.isArray(options.points) ? options.points : [];
  const lowerIsBetter = options.lowerIsBetter === true;
  const named = items
    .filter((item) => (Array.isArray(options.series) ? item.name : item.label) !== MEAN_NAME)
    .map((item) => ({
      name: Array.isArray(options.series) ? item.name : item.label,
      score: scoreOf(item, options),
    }));
  return named.sort((a, b) => {
    if (Number.isNaN(a.score) && Number.isNaN(b.score)) return 0;
    if (Number.isNaN(a.score)) return 1;
    if (Number.isNaN(b.score)) return -1;
    return lowerIsBetter ? a.score - b.score : b.score - a.score;
  }).map((item) => item.name);
}

/**
 * The ranked names of the models kept when a chart shows only its best (or only its worst) count models. The names are
 * returned in ranked order, so the same numbers always keep the same models.
 */
export function topModels(options, count, which) {
  const ranked = rankedModels(options);
  return which === "best" ? ranked.slice(0, count) : ranked.slice(Math.max(0, ranked.length - count));
}
