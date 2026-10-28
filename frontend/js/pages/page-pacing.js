// Draws the limits table on the pacing page (frontend/pacing.html). The numbers come from /data/rate_limits.json, which
// the export writes from the console table and from the backend's observed values. The page only reads that file.
// It never calls a model platform, and it says so when the file cannot be read, instead of showing an empty table.
import { loadJson } from "../shared/data-cache.js";
import { pacingRows } from "../shared/rate-limits.js";

// The file the export writes. The page reads it once when it opens.
const RATE_LIMITS_PATH = "/data/rate_limits.json";
// Column titles and their alignment. The two observed columns are added only when the file has observed values,
// so a page with only the console table does not show a column of "not recorded".
const BASE_COLUMNS = [["Model", ""], ["Requests per minute", "num"], ["Tokens per minute", "num"], ["Source", ""]];
const OBSERVED_COLUMNS = [["In-flight cap", "num"], ["Latency", "num"]];

// Module scripts run after the page is read, so the table and the status line already exist when this starts.
startPacingPage();

/**
 * Load the limits file and draw the table. When the file cannot be read, the status line says what to check and the
 * table stays hidden. Never throws.
 */
async function startPacingPage() {
  const status = document.querySelector("[data-pacing-status]");
  const table = document.querySelector("[data-pacing-table]");
  const data = await loadRatesOrNull();
  if (data === null) {
    status.textContent = "The limits file could not be read. Check that the site is being served, then reload the page.";
    return;
  }
  status.textContent = statusText(data);
  const withObserved = hasObserved(data);
  drawTable(table, pacingRows(data, data.observed ?? null), withObserved);
  table.hidden = false;
}

/** Read the limits file. A missing or broken file gives null, so the page can say so instead of failing. */
async function loadRatesOrNull() {
  try {
    return await loadJson(RATE_LIMITS_PATH);
  } catch {
    return null;
  }
}

/**
 * Return the line above the table: the date the console table was checked, and whether observed values are shown.
 * The date is shown as recorded, so the reader can judge how old the numbers are.
 */
function statusText(data) {
  const checked = data.checked ?? "an unknown date";
  const observedNote = hasObserved(data)
    ? "The last run's observed values are shown as well."
    : "No run has recorded observed values yet, so only the console table is shown.";
  return `Console table checked ${checked}. ${observedNote}`;
}

/** Return true when the file holds observed values from a run, even if it has no models in it yet. */
function hasObserved(data) {
  return data.observed !== undefined && data.observed !== null;
}

/** Replace the table's head and body with one row per model. The observed columns are shown only when asked for. */
function drawTable(table, rows, withObserved) {
  const columns = withObserved ? [...BASE_COLUMNS, ...OBSERVED_COLUMNS] : BASE_COLUMNS;
  table.replaceChildren(buildHead(columns), buildBody(rows, withObserved));
}

/** Build the table head from the column titles. */
function buildHead(columns) {
  const row = document.createElement("tr");
  for (const [title, className] of columns) {
    row.append(buildCell("th", title, className));
  }
  const head = document.createElement("thead");
  head.append(row);
  return head;
}

/** Build the table body, one row for each model. */
function buildBody(rows, withObserved) {
  const body = document.createElement("tbody");
  for (const row of rows) {
    body.append(buildRow(row, withObserved));
  }
  return body;
}

/** Build one model's row. The text comes from pacingRows, so the page only places it in cells. */
function buildRow(row, withObserved) {
  const line = document.createElement("tr");
  line.append(
    buildCell("th", row.model, ""),
    buildCell("td", row.requestsPerMinute, "num"),
    buildCell("td", row.tokensPerMinute, "num"),
    buildCell("td", row.source, ""),
  );
  if (withObserved) {
    line.append(buildCell("td", row.inFlightCap, "num"), buildCell("td", row.latency, "num"));
  }
  return line;
}

/**
 * Build one table cell with its text set as plain text, never as HTML, so a model name cannot inject markup.
 * An empty class name adds no class.
 */
function buildCell(tagName, text, className) {
  const cell = document.createElement(tagName);
  cell.textContent = text;
  if (className !== "") {
    cell.className = className;
  }
  return cell;
}
