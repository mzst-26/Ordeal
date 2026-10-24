// Boot for the comparison page. Reads the embedded results, keeps the filter and selection state,
// mounts each figure through its own module, and gives every figure the shared api (PLAN_COMPARE 5d).
// A figure module that is missing or fails to load shows "Not built yet" in its own card.
import {
  defaultFilters, visibleModels, rankBands, takeaway, familyOrder, familyColour, familyLabel, sizeBounds,
} from "./derive.js";
import { hideTooltip } from "./tooltip.js";

const DATA_ID = "compare-data";
const NOT_BUILT = "Not built yet";
const FAILED = "This figure could not start.";
const CONDITION_NAMES = { none: "no system prompt", mitigation: "mitigation prompt", control: "control prompt" };
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The figures, in page order. FIG 6 uses the scatter module in its map mode. */
const FIGURES = [
  { id: "fig-scatter", load: () => import("./fig-scatter.js") },
  { id: "fig-fingerprint", load: () => import("./fig-fingerprint.js") },
  { id: "fig-survivors", load: () => import("./fig-survivors.js") },
  { id: "fig-h2h", load: () => import("./fig-h2h.js") },
  { id: "fig-replay", load: () => import("./fig-replay.js") },
  { id: "fig-map", load: () => import("./fig-scatter.js"), options: { mode: "map" } },
  { id: "fig-mitigation", load: () => import("./fig-mitigation.js") },
];

/** Reads and parses the embedded JSON. Returns {data}, {empty: true} or {error}. */
function readData() {
  const node = document.getElementById(DATA_ID);
  const text = node ? node.textContent.trim() : "";
  if (text === "" || text === "{}") {
    return { empty: true };
  }
  try {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.models) || data.models.length === 0) {
      return { empty: true };
    }
    return { data };
  } catch (error) {
    return { error };
  }
}

/** Writes a message into a figure's container, as a plain paragraph. */
function showMessage(root, message) {
  const paragraph = document.createElement("p");
  paragraph.className = "figure-message";
  paragraph.textContent = message;
  root.replaceChildren(paragraph);
}

/** The filter controls, built from the data and wired to the state. */
function buildFilters(data, state, onChange) {
  const models = data.models;
  const order = familyOrder(models);
  const bounds = sizeBounds(models);
  const familyBox = document.getElementById("filter-family");
  const sizeInput = document.getElementById("filter-size");
  const sizeOut = document.getElementById("filter-size-out");
  const reasoning = document.getElementById("filter-reasoning");
  const open = document.getElementById("filter-open");
  const lowSample = document.getElementById("filter-lowsample");
  const search = document.getElementById("filter-search");
  const resetButton = document.getElementById("filter-reset");
  const chips = new Map();

  for (const family of order) {
    const count = models.filter((model) => (family === null ? !model.family : model.family === family)).length;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "filter-chip";
    chip.setAttribute("aria-pressed", "true");
    const box = document.createElement("span");
    box.className = "chip-box";
    box.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.textContent = familyLabel(family);
    const countText = document.createElement("span");
    countText.className = "chip-count";
    countText.textContent = `(${count})`;
    chip.append(box, name, countText);
    chip.addEventListener("click", () => {
      const next = new Set(state.filters.families);
      if (next.has(family)) {
        next.delete(family);
      } else {
        next.add(family);
      }
      state.filters.families = next;
      chip.setAttribute("aria-pressed", next.has(family) ? "true" : "false");
      onChange();
    });
    chips.set(family, chip);
    familyBox.append(chip);
  }

  const sizeMax = Math.max(bounds.max, bounds.min + 1);
  sizeInput.min = String(bounds.min);
  sizeInput.max = String(sizeMax);

  /** Shows the size slider's value, and says so when models of unknown size are hidden. */
  function showSize() {
    const full = state.filters.sizeMax >= bounds.max;
    const value = Math.round(state.filters.sizeMax * 10) / 10;
    sizeOut.textContent = full
      ? "Any size"
      : `Up to ${value} B parameters (models of unknown size are hidden)`;
  }

  sizeInput.addEventListener("input", () => {
    state.filters.sizeMax = Number(sizeInput.value);
    showSize();
    onChange();
  });
  reasoning.addEventListener("change", () => {
    state.filters.reasoning = reasoning.value;
    onChange();
  });
  open.addEventListener("change", () => {
    state.filters.open = open.value;
    onChange();
  });
  lowSample.addEventListener("change", () => {
    state.filters.lowSampleHidden = lowSample.checked;
    onChange();
  });
  search.addEventListener("input", () => {
    state.filters.search = search.value.trim();
    onChange();
  });
  resetButton.addEventListener("click", () => {
    resetFilters();
    onChange();
  });

  /** Sets every control to the state's filters, after a reset or a change from a figure. */
  function sync() {
    for (const [family, chip] of chips) {
      chip.setAttribute("aria-pressed", state.filters.families.has(family) ? "true" : "false");
    }
    sizeInput.value = String(state.filters.sizeMax);
    showSize();
    reasoning.value = state.filters.reasoning;
    open.value = state.filters.open;
    lowSample.checked = state.filters.lowSampleHidden;
    search.value = state.filters.search;
  }

  /** Puts the filters back to where the page starts. */
  function resetFilters() {
    state.filters = defaultFilters(models);
    sync();
  }

  sync();
  return { sync, resetFilters };
}

/** Wires the condition radios. Returns a function that checks the radio for a condition. */
function buildCondition(onChange) {
  const radios = document.querySelectorAll('input[name="condition"]');
  for (const radio of radios) {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        onChange(radio.value);
      }
    });
  }
  return (value) => {
    for (const radio of radios) {
      radio.checked = radio.value === value;
    }
  };
}

/** The application. Runs once the page has loaded. */
async function boot() {
  const takeawayLine = document.getElementById("takeaway");
  const countLine = document.getElementById("filter-count");
  const announcer = document.getElementById("announcer");
  const loaded = readData();

  if (loaded.empty || loaded.error) {
    const text = loaded.empty ? "No data yet" : "The comparison data could not be read.";
    if (loaded.error) {
      console.error("The comparison data could not be read.", loaded.error);
    }
    takeawayLine.textContent = text;
    countLine.textContent = "";
    for (const figure of FIGURES) {
      const root = document.getElementById(`${figure.id}-root`);
      if (root) {
        showMessage(root, text);
      }
    }
    return;
  }

  const data = loaded.data;
  const allModels = data.models;
  const order = familyOrder(allModels);
  const state = {
    filters: defaultFilters(allModels),
    condition: "none",
    selectedId: null,
    openId: null,
  };
  const mounted = [];
  let card = null;
  let closeCard = null;
  let checkCondition = () => {};
  let filterControls = null;

  /** Writes text into the polite live region. */
  function announce(text) {
    announcer.textContent = "";
    announcer.textContent = text;
  }

  /** Redraws the counts, the takeaway and every figure from the current state. */
  function render() {
    const visible = visibleModels(allModels, state.filters);
    const bands = rankBands(visible);
    countLine.textContent = `${visible.length} of ${allModels.length} models shown`;
    takeawayLine.textContent = takeaway(allModels, visible);
    const view = {
      models: visible,
      allModels,
      filters: state.filters,
      condition: state.condition,
      selectedId: state.selectedId,
      openId: state.openId,
      bands,
    };
    for (const figure of mounted) {
      try {
        figure.instance.update(view);
      } catch (error) {
        console.error(`Figure ${figure.id} failed to update.`, error);
        showMessage(figure.root, FAILED);
      }
    }
    if (card && typeof card.update === "function") {
      try {
        card.update(view);
      } catch (error) {
        console.error("The model card failed to update.", error);
      }
    }
  }

  /** Changes the filters or condition, and redraws. */
  function onChange() {
    render();
  }

  const api = {
    data,
    allModels,
    familyOrder: order,
    familyColour: (family) => familyColour(family, order),
    /** Pins the model (selects it) and opens its Model Card. */
    openModel(id) {
      state.selectedId = id;
      state.openId = id;
      if (!card) {
        announce("The model card is not built yet.");
      }
      render();
    },
    /** Pins the model without opening its card. */
    pinModel(id) {
      state.selectedId = id;
      render();
    },
    /** Clears the open card. The model card calls this when it closes. */
    closeModel() {
      state.openId = null;
      render();
    },
    /** Sets the condition: none, mitigation or control. */
    setCondition(condition) {
      if (!Object.prototype.hasOwnProperty.call(CONDITION_NAMES, condition)) {
        return;
      }
      state.condition = condition;
      checkCondition(condition);
      announce(`Showing the ${CONDITION_NAMES[condition]} condition.`);
      render();
    },
    announce,
    /** Puts every filter back to its starting value. */
    resetFilters() {
      filterControls.resetFilters();
      render();
    },
  };

  filterControls = buildFilters(data, state, onChange);
  checkCondition = buildCondition((condition) => api.setCondition(condition));

  for (const figure of FIGURES) {
    const root = document.getElementById(`${figure.id}-root`);
    if (!root) {
      continue;
    }
    let module;
    try {
      module = await figure.load();
    } catch (error) {
      console.error(`Figure ${figure.id} is not available.`, error);
      showMessage(root, NOT_BUILT);
      continue;
    }
    if (!module || typeof module.mount !== "function") {
      showMessage(root, NOT_BUILT);
      continue;
    }
    try {
      const instance = module.mount(root, api, figure.options || {});
      mounted.push({ id: figure.id, root, instance });
    } catch (error) {
      console.error(`Figure ${figure.id} failed to start.`, error);
      showMessage(root, FAILED);
    }
  }

  try {
    const cardModule = await import("./model-card.js");
    card = cardModule.mount(document.getElementById("model-card"), api, {}) || null;
    closeCard = typeof cardModule.close === "function" ? cardModule.close : null;
  } catch (error) {
    console.error("The model card is not available.", error);
    card = null;
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    hideTooltip();
    if (state.openId !== null) {
      if (closeCard) {
        closeCard();
      }
      state.openId = null;
      render();
    }
  });

  try {
    window.matchMedia(DARK_QUERY).addEventListener("change", () => render());
  } catch (error) {
    console.error("The colour scheme could not be watched.", error);
  }

  render();
}

boot();
