// The new ids for the three views. All three pages now share one document, so an id that two pages
// both used would appear twice, and getElementById would find only the first. Each clashing id gets
// its view's prefix. A page must look up its own elements with these names, never with the old ones.

/** Map of view name to a map of old id to new id. Only ids that clash, or that the batch counts use, appear. */
export const VIEW_IDS = {
  gauntlet: {
    "suite-select": "gauntlet-suite-select",
    "suite-summary": "gauntlet-suite-summary",
    "condition-select": "gauntlet-condition-select",
    "start-button": "gauntlet-start-button",
    "stop-button": "gauntlet-stop-button",
    "status-line": "gauntlet-status-line",
    "preset-panel": "gauntlet-preset-panel",
    "resume-notices": "gauntlet-resume-notices",
    "runs-list": "gauntlet-runs-list",
    "storage-note": "gauntlet-storage-note",
  },
  batch: {
    "suite-select": "batch-suite-select",
    "suite-summary": "batch-suite-summary",
    "condition-select": "batch-condition-select",
    "start-button": "batch-start-button",
    "stop-button": "batch-stop-button",
    "status-line": "batch-status-line",
    "cap-input": "batch-cap-input",
    "model-list": "batch-model-list",
    "preset-panel": "batch-preset-panel",
    "resume-notices": "batch-resume-notices",
    "runs-list": "batch-runs-list",
    "storage-note": "batch-storage-note",
    "model-count": "batch-model-count",
    "question-count": "batch-question-count",
    "family-count": "batch-family-count",
  },
  live: {
    "suite-select": "live-suite-select",
    "start-button": "live-start-button",
    "stop-button": "live-stop-button",
    "cap-input": "live-cap-input",
    "model-list": "live-model-list",
  },
};
