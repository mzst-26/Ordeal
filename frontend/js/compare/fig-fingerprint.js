// FIG 2, "Fingerprint": a heatmap of flip rates. Rows are models (in the order given, or sorted by a column);
// columns are the fingerprint probe axes. The number in each cell is the signal; the colour is an extra.
import { isNotRun, pct, rateText } from "./derive.js";

// A cell with fewer than this many probe units is marked as low-sample (hatched, with its n shown).
const LOW_N = 15;
const CAPTION =
  "Each cell is the share of probe units where the model flipped its answer, so a darker cell is more pressure-sensitive; " +
  "hatched cells have fewer than 15 units and dotted cells were not run.";

/** The flip rate for one axis, or null when the cell is not run. */
function fingerprintValue(model, key) {
  const rate = model && model.fingerprint ? model.fingerprint[key] : null;
  return isNotRun(rate) ? null : rate.rate;
}

/**
 * Sort the heatmap rows by one axis.
 * `direction` is "desc" (highest first, the default) or "asc". Rows with a null value for the key go last,
 * in their original order, whatever the direction. Ties keep their original order. Returns a new array.
 */
export function sortHeatmapRows(models, key, direction = "desc") {
  if (!key) return models.slice();
  const sign = direction === "asc" ? 1 : -1;
  const rows = models.map((model, index) => ({ model, index, value: fingerprintValue(model, key) }));
  const present = rows
    .filter((row) => row.value !== null)
    .sort((a, b) => sign * (a.value - b.value) || a.index - b.index);
  const missing = rows.filter((row) => row.value === null);
  return [...present, ...missing].map((row) => row.model);
}

/** The cell colour for a flip rate: paper-raised at 0, full cat-1 at 1. Set through element.style, never in HTML. */
export function heatmapFill(value) {
  const clamped = Math.min(1, Math.max(0, value));
  return `color-mix(in srgb, var(--cat-1) ${Math.round(clamped * 100)}%, var(--paper-raised))`;
}

/**
 * The text tokens for a heatmap cell. The percentage (and n) sit in a label box with a paper-raised background and
 * ink text, so the text is always ink on paper-raised (about 14.9:1 light, 12.9:1 dark) whatever the cell colour.
 */
export function heatmapLabelTokens() {
  return { text: "var(--ink)", background: "var(--paper-raised)" };
}

/** The rank band label for a model, or null when it has no band. */
export function bandLabel(bands, id) {
  const band = bands && typeof bands.get === "function" ? bands.get(id) : null;
  return band === null || band === undefined ? null : `Band ${band}`;
}

// Tiny element builder: attrs {text, class, hidden, tabIndex, onXxx handlers, anything else as an attribute};
// null, undefined and false attributes and children are skipped. Text goes in via textContent, never as markup.
function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key === "hidden") node.hidden = Boolean(value);
    else if (key === "tabIndex") node.tabIndex = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const kid of kids) {
    if (kid !== null && kid !== undefined && kid !== false) node.append(kid);
  }
  return node;
}

// Mounts FIG 2 into root. update(view) receives the filtered models and rank bands from app.js.
export function mount(root, api) {
  const axes = (api.data.axes || []).filter((axis) => axis.family === "fingerprint");
  const tableId = `${root.id}-table`;
// sortKey/sortDir: current column sort (null = given order). active: the grid cell that holds the roving tabindex.
// renderedSig: signature of the last render, to skip needless rebuilds. refocusSort: header button to refocus after a re-sort.
  const state = {
    sortKey: null,
    sortDir: "desc",
    active: null,
    tableOpen: false,
    view: { models: [] },
    renderedSig: null,
    refocusSort: null,
    headerButtons: {},
  };

  const chartBox = h("div", {
    class: "fp-chart",
    role: "region",
    "aria-label": "Fingerprint heatmap: flip rate by model (rows) and probe axis (columns)",
  });
  const altBox = h("div", { class: "fp-alt", id: tableId, hidden: true });
  const toggle = h("button", {
    type: "button",
    class: "btn",
    "aria-expanded": "false",
    "aria-controls": tableId,
    text: "Show as table",
    onclick: () => {
      state.tableOpen = !state.tableOpen;
      applyVisibility();
    },
  });
  const caption = h("p", { class: "field-hint fg-caption", text: CAPTION });
  const scrollCue = h("p", { class: "field-hint fp-scroll-cue", hidden: true, text: "Scroll sideways to see every column." });

  root.replaceChildren(
    h("div", { class: "figure-tools" }, toggle),
    chartBox,
    scrollCue,
    caption,
    altBox,
  );

  // The cue shows only while the grid is wider than its box (the box then scrolls sideways).
  function updateScrollCue() {
    const overflowing = !chartBox.hidden && chartBox.scrollWidth > chartBox.clientWidth + 1;
    scrollCue.hidden = !overflowing;
  }
  window.addEventListener("resize", updateScrollCue);

  // Shows either the heatmap or the accessible table, and hides the toggle when there are no rows.
  function applyVisibility() {
    const empty = state.view.models.length === 0;
    if (empty) state.tableOpen = false;
    toggle.hidden = empty;
    toggle.textContent = state.tableOpen ? "Show as chart" : "Show as table";
    toggle.setAttribute("aria-expanded", String(state.tableOpen));
    chartBox.hidden = state.tableOpen;
    altBox.hidden = !state.tableOpen;
    updateScrollCue();
  }

// Clicking the same column flips the direction; a new column starts highest-first. Announces the result for screen readers.
  function sortBy(axis) {
    if (state.sortKey === axis.id) {
      state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
    } else {
      state.sortKey = axis.id;
      state.sortDir = "desc";
    }
    state.refocusSort = axis.id;
    api.announce(
      `Rows sorted by ${axis.label}, ${state.sortDir === "desc" ? "highest first" : "lowest first"}.`,
    );
    render(true);
  }

// Colour ramp key from 0% to 100% plus a note on the hatched and dotted cell styles.
  function buildLegend() {
    const swatches = [0, 0.25, 0.5, 0.75, 1].map((value) => {
      const swatch = h("span", { class: "fp-swatch", "aria-hidden": "true" });
      swatch.style.backgroundColor = heatmapFill(value);
      return swatch;
    });
    return h(
      "div",
      { class: "fp-legend" },
      h("span", { text: "0%" }),
      ...swatches,
      h("span", { text: "100%" }),
      h("p", { class: "field-hint", text: "Hatched: fewer than 15 units. Dotted: not run." }),
    );
  }

// Plain table with the same rates (and intervals and units via rateText) as the heatmap, for screen readers and as a text view.
  function buildAltTable(rows) {
    return h(
      "table",
      { class: "fg-table" },
      h("caption", {
        class: "fg-table-caption",
        text: "Fingerprint flip rates by model and probe axis, with 95% intervals and units",
      }),
      h(
        "thead",
        {},
        h("tr", {}, h("th", { scope: "col", text: "Model" }), ...axes.map((axis) => h("th", { scope: "col", text: axis.label }))),
      ),
      h(
        "tbody",
        {},
        ...rows.map((model) =>
          h(
            "tr",
            {},
            h("th", { scope: "row", text: [model.display_name || model.id, bandLabel(state.view.bands, model.id)].filter(Boolean).join(", ") }),
            ...axes.map((axis) =>
              h("td", { text: rateText(model.fingerprint ? model.fingerprint[axis.id] : null) }),
            ),
          ),
        ),
      ),
    );
  }

// Builds the heatmap table for the already-sorted rows. Returns {table}. Needs at least one row and one axis (render() guarantees it).
  function buildGrid(rows) {
    const cells = new Map();
    const headerButtons = {};
    if (!state.active || !rows.some((model) => model.id === state.active.row)) {
      state.active = { row: rows[0].id, col: axes[0].id };
    }

// Roving tabindex: exactly one cell is tabbable at a time.
    function setActive(row, col) {
      state.active = { row, col };
      for (const [key, cell] of cells) {
        cell.tabIndex = key === `${row}|${col}` ? 0 : -1;
      }
    }

    const headerRow = h(
      "tr",
      {},
      h("th", { scope: "col", class: "fp-corner", text: "Model" }),
      ...axes.map((axis) => {
        const sorted = state.sortKey === axis.id;
        const button = h("button", {
          type: "button",
          class: "fp-sort",
          text: axis.label,
          onclick: () => sortBy(axis),
        });
        headerButtons[axis.id] = button;
        const arrow = sorted ? (state.sortDir === "asc" ? "▲" : "▼") : null;
        return h(
          "th",
          {
            scope: "col",
            class: "fp-th",
            "aria-sort": sorted ? (state.sortDir === "asc" ? "ascending" : "descending") : "none",
          },
          button,
          arrow ? h("span", { class: "fp-arrow", "aria-hidden": "true", text: arrow }) : null,
        );
      }),
    );

    const body = rows.map((model) =>
      h(
        "tr",
        {},
        h(
          "th",
          { scope: "row", class: "fp-rowhead" },
          h("button", {
            type: "button",
            class: "fp-rowname",
            text: model.display_name || model.id,
            onclick: () => api.openModel(model.id),
          }),
          bandLabel(state.view.bands, model.id) ? h("span", { class: "fp-band", text: bandLabel(state.view.bands, model.id) }) : null,
        ),
        ...axes.map((axis) => {
          const rate = model.fingerprint ? model.fingerprint[axis.id] : null;
          const cell = h("td", { class: "fp-cell" });
          cell.dataset.row = model.id;
          cell.dataset.col = axis.id;
// Not-run cells get no colour; low-n cells (n below LOW_N) keep their colour and show n.
          if (isNotRun(rate)) {
            cell.classList.add("fp-cell--none");
            cell.append(h("span", { class: "fp-pct", text: "not run" }));
          } else {
            cell.style.backgroundColor = heatmapFill(rate.rate);
            const label = h("span", { class: "fp-label" }, h("span", { class: "fp-pct", text: pct(rate.rate) }));
            if (typeof rate.n === "number" && rate.n < LOW_N) {
              cell.classList.add("fp-cell--low");
              label.append(h("span", { class: "fp-n", text: `n=${rate.n}` }));
            }
            cell.append(label);
          }
          cell.addEventListener("click", () => setActive(model.id, axis.id));
          cells.set(`${model.id}|${axis.id}`, cell);
          return cell;
        }),
      ),
    );

    const table = h("table", { class: "fp-grid" }, h("thead", {}, headerRow), h("tbody", {}, ...body));
    state.headerButtons = headerButtons;

    // Arrow keys move between cells (roving tabindex: only the active cell is in the Tab order).
    table.addEventListener("keydown", (event) => {
      const cell = event.target.closest ? event.target.closest("td.fp-cell") : null;
      if (!cell) return;
      const rowIds = rows.map((model) => model.id);
      const colIds = axes.map((axis) => axis.id);
      let r = rowIds.indexOf(cell.dataset.row);
      let c = colIds.indexOf(cell.dataset.col);
      switch (event.key) {
        case "ArrowRight": c = Math.min(colIds.length - 1, c + 1); break;
        case "ArrowLeft": c = Math.max(0, c - 1); break;
        case "ArrowDown": r = Math.min(rowIds.length - 1, r + 1); break;
        case "ArrowUp": r = Math.max(0, r - 1); break;
        case "Home": c = 0; break;
        case "End": c = colIds.length - 1; break;
        default: return;
      }
      event.preventDefault();
      const target = cells.get(`${rowIds[r]}|${colIds[c]}`);
      if (target) {
        setActive(rowIds[r], colIds[c]);
        target.focus();
      }
    });

    setActive(state.active.row, state.active.col);
    return { table };
  }

// Shown when the filters leave no models.
  function emptyState() {
    return h(
      "div",
      { class: "fg-empty" },
      h("p", { text: "No models match these filters." }),
      h("button", { type: "button", class: "btn", text: "Reset filters", onclick: () => api.resetFilters() }),
    );
  }

  /** Rebuild the DOM. Skipped when nothing the DOM depends on has changed, so focus is kept. */
  function render(force = false) {
    const models = state.view.models || [];
    const bands = models.map((model) => bandLabel(state.view.bands, model.id));
    const sig = JSON.stringify([models.map((model) => model.id), state.sortKey, state.sortDir, axes.length, bands]);
    if (!force && sig === state.renderedSig) {
      applyVisibility();
      return;
    }
    state.renderedSig = sig;

    if (models.length === 0 || axes.length === 0) {
      chartBox.replaceChildren(
        models.length === 0
          ? emptyState()
          : h("p", { class: "field-hint", text: "This results file has no fingerprint axes." }),
      );
      altBox.replaceChildren();
    } else {
      const rows = sortHeatmapRows(models, state.sortKey, state.sortDir);
      const { table } = buildGrid(rows);
      chartBox.replaceChildren(table, buildLegend());
      altBox.replaceChildren(buildAltTable(rows));
    }
    applyVisibility();

    if (state.refocusSort && state.headerButtons[state.refocusSort]) {
      state.headerButtons[state.refocusSort].focus();
    }
    state.refocusSort = null;
  }

  return {
    update(view) {
      state.view = view;
      render(false);
    },
  };
}
