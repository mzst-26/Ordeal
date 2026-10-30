// The five benchmark cases, built once per page from the seeded generator. Both engines read the same arrays, so the
// only thing that differs between them is the chart library. Building the data is not timed: the timer starts when a
// case is drawn, and the data already exists by then, as it does when the page has loaded its results.
import {
  SCATTER_POINTS, HEATMAP_MODELS, HEATMAP_QUESTIONS, FACET_COUNT, FACET_POINTS, DIFFERENCE_MODELS, BENCH_SEED,
  scatterPoints, facetPoints, heatmapData, differenceData,
} from "./data-gen.js";
import { questionRows, conditionRows } from "../../frontend/js/compare/vega-rows.js";

// The colours the charts use. The values are the page's light-theme tokens (frontend/js/compare/fig-views.js), so the
// benchmark draws with the same palette the site ships. The highlight colour is only for the selection case.
export const THEME = Object.freeze({
  ink: "#26211C",
  inkSoft: "#5A5048",
  rule: "#D9CDBB",
  surface: "#F5EFE3",
  accent: "#2E5E5B",
  categorical: Object.freeze(["#892C1A", "#A57C00", "#9A6AAF"]),
  highlight: "#892C1A",
});

// The case names the runner uses. "selection" and "facets" share the same facet rows.
export const CASE_IDS = Object.freeze(["scatter", "heatmap", "facets", "selection", "toggle"]);

// Each built case is cached, so a second render of the same case does not rebuild the 100k rows.
const built = new Map();

/** The arrays for one case, built on first use from the seed. Throws for an unknown case name. */
export function caseData(caseId) {
  if (!built.has(caseId)) {
    built.set(caseId, buildCase(caseId));
  }
  return built.get(caseId);
}

/** Builds the rows for one case. Each case is the shape its builder in frontend/js/compare expects. */
function buildCase(caseId) {
  if (caseId === "scatter") {
    return { points: scatterPoints(SCATTER_POINTS, BENCH_SEED) };
  }
  if (caseId === "heatmap") {
    const data = heatmapData(HEATMAP_MODELS, HEATMAP_QUESTIONS, BENCH_SEED);
    return { rows: questionRows(data.models, data), models: HEATMAP_MODELS, questions: HEATMAP_QUESTIONS };
  }
  if (caseId === "facets" || caseId === "selection") {
    return { rows: facetPoints(FACET_COUNT, FACET_POINTS, BENCH_SEED), facets: FACET_COUNT };
  }
  if (caseId === "toggle") {
    const data = differenceData(DIFFERENCE_MODELS, BENCH_SEED);
    return { rows: conditionRows(data.models, data), models: DIFFERENCE_MODELS };
  }
  throw new Error(`Unknown benchmark case: ${caseId}`);
}
