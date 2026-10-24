// Shared chart-panel code for the batch and live pages: the series colours, the table view that goes
// with each chart, and the theme watcher. The charts themselves are still made through charts/index.js.

import { el, formatNumber } from "./ui.js";

// Series 1 to 3 use the colour tokens --cat-1 to --cat-3. Series 4 and later cycle through them again.
export const SERIES_COUNT = 3;

const TOGGLE_TO_TABLE = "Show as table";
const TOGGLE_TO_CHART = "Show as chart";

// The cycling rule: series 4 uses slot 1 again, so the slot is the index mod 3.
/** Return the colour slot (0 to 2) for a series index (0 is the first), or null for a bad index. */
export function seriesSlot(index) {
  return index < 0 ? null : index % SERIES_COUNT;
}

/** True from series 4 on. Those series reuse a colour, so the charts draw them dashed or faded. */
export function isRepeatSeries(index) {
  return index >= SERIES_COUNT;
}

/** Return the categorical colour for a series index, read from the page now, or null. */
export function seriesColour(index) {
  const slot = seriesSlot(index);
  if (slot === null) {
    return null;
  }
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--cat-${slot + 1}`);
  return value.trim() || null;
}

/** The chart options for one series: its colour, and the dashed and faded flags that mark a repeat. */
export function seriesStyle(index) {
  return { color: seriesColour(index), dashed: isRepeatSeries(index), faded: isRepeatSeries(index) };
}

/** Make one table cell. The first column is a row header, and cells from firstNumber on are right aligned. */
export function tableCell(text, index, firstNumber) {
  const isFirst = index === 0;
  return el(isFirst ? "th" : "td", {
    text,
    scope: isFirst ? "row" : null,
    className: index >= firstNumber ? "num" : null,
  });
}

/** Build a real table with a caption and column headers. The cells are plain text. */
export function buildTable({ caption, headers, rows, firstNumber }) {
  const headRow = el("tr", {}, headers.map((text) => el("th", { scope: "col", text })));
  const bodyRows = rows.map((cells) => {
    return el("tr", {}, cells.map((text, index) => tableCell(text, index, firstNumber)));
  });
  return el("table", { className: "data-table chart-table" }, [
    el("caption", { className: "table-caption", text: caption }),
    el("thead", {}, [headRow]),
    el("tbody", {}, bodyRows),
  ]);
}

/** Return the table description for a bar chart: one row per probe and model, with the rate and its interval. */
export function barTable(caption, options) {
  const rows = [];
  options.groups.forEach((probe, groupIndex) => {
    for (const item of options.series) {
      rows.push([
        probe,
        item.name,
        formatNumber(item.valuesByGroup[groupIndex]),
        formatNumber(item.lowsByGroup[groupIndex]),
        formatNumber(item.highsByGroup[groupIndex]),
      ]);
    }
  });
  return { caption, headers: ["Probe", "Model", "Flip rate", "Low", "High"], rows, firstNumber: 2 };
}

/** Make the view for one chart: a toggle button above it and a hidden table where the chart is. */
export function makeChartPanel(chartHost, tableHost, create, describe) {
  const toggle = el("button", {
    type: "button",
    className: "btn table-toggle",
    text: TOGGLE_TO_TABLE,
    "aria-pressed": "false",
    "aria-controls": tableHost.id,
  });
  const panel = { chartHost, tableHost, toggle, create, describe, chart: null, options: null };
  tableHost.tabIndex = -1;
  toggle.disabled = true;
  chartHost.before(toggle);
  toggle.addEventListener("click", () => toggleTable(panel));
  return panel;
}

/** Draw the chart (made once, then updated) and rebuild the table from the same options. */
export function drawPanel(panel, options) {
  panel.options = options;
  if (panel.chart === null) {
    panel.chart = panel.create(panel.chartHost, options);
  } else {
    panel.chart.update(options);
  }
  panel.tableHost.replaceChildren(buildTable(panel.describe(options)));
  panel.toggle.disabled = false;
}

/** Show the table or the chart. A chart shown again is redrawn, since it was not measured while hidden. */
export function setPanelView(panel, showTable) {
  panel.tableHost.hidden = !showTable;
  panel.chartHost.hidden = showTable;
  panel.toggle.setAttribute("aria-pressed", String(showTable));
  panel.toggle.textContent = showTable ? TOGGLE_TO_CHART : TOGGLE_TO_TABLE;
  if (!showTable && panel.options !== null) {
    panel.chart.update(panel.options);
  }
}

/** Handle the toggle button: swap the view, and move focus into the view that is now shown. */
export function toggleTable(panel) {
  const showTable = panel.tableHost.hidden;
  setPanelView(panel, showTable);
  if (showTable) {
    panel.tableHost.focus();
  } else {
    panel.toggle.focus();
  }
}

/** Destroy the panel's chart and empty both containers. The view (chart or table) is left as it is. */
export function destroyChart(panel) {
  if (panel.chart !== null) {
    panel.chart.destroy();
  }
  panel.chart = null;
  panel.options = null;
  panel.chartHost.replaceChildren();
  panel.tableHost.replaceChildren();
}

/** No data to show: remove the chart and table, show the chart view, and switch the button off. */
export function clearPanel(panel) {
  destroyChart(panel);
  setPanelView(panel, false);
  panel.toggle.disabled = true;
}

/** Call redraw when the light or dark theme changes, since the chart colours are read from the page at draw time. */
export function watchThemeChanges(redraw) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => redraw());
  const observer = new MutationObserver(() => redraw());
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}
