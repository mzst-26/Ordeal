// Export and import of the ticked models in "Choose models" and the ticked questions in "Choose questions" on the batch
// page. A selection file holds only ids, one kind per file, so it can never hold a key or a reply. It comes in two
// formats: JSON is one object with the list of ids, and JSON Lines has one object per line. Import reads both, so a
// file loads back whichever format it was saved in.
import { el } from "./ui.js";

/** The two formats a selection file can be written in, with the label and extension that the picker shows. */
export const SELECTION_FORMATS = Object.freeze({
  json: Object.freeze({ label: "JSON", extension: "json", mimeType: "application/json" }),
  jsonl: Object.freeze({ label: "JSON Lines", extension: "jsonl", mimeType: "application/x-ndjson" }),
});

const EMPTY_MESSAGE = "The file is empty.";
const NOT_JSON_MESSAGE = "The file is not JSON or JSON Lines.";
const NO_TYPE_MESSAGE = "The file does not say what kind of selection it holds.";
const BAD_ID_MESSAGE = "The file holds an id that is not text.";

/**
 * Return the text of a selection file. type is "model" or "question", ids is the list of ticked ids, and format is a key
 * of SELECTION_FORMATS. JSON Lines gets one object per id. JSON gets one object with the whole list, so it reads well.
 */
export function selectionToText(type, ids, format) {
  if (!Object.hasOwn(SELECTION_FORMATS, format)) {
    throw new Error(`Unknown selection format: ${format}.`);
  }
  if (format === "jsonl") {
    return ids.map((id) => `${JSON.stringify({ type, id })}\n`).join("");
  }
  return `${JSON.stringify({ type, ids }, null, 2)}\n`;
}

/**
 * Return the list of ids in a selection file, with no repeats. A file of the wrong kind, such as a question file given
 * to "Choose models", is refused, so the wrong ids never get ticked. Throws an Error with the reason when it cannot read.
 */
export function parseSelectionText(text, type) {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error(EMPTY_MESSAGE);
  }
  // A JSON file is one object with an ids list. A JSON Lines file with one line also parses as an object, but has no list.
  const whole = parseOrNull(trimmed);
  if (whole !== null && Array.isArray(whole.ids)) {
    checkType(whole.type, type);
    return uniqueIds(whole.ids);
  }
  const rows = trimmed.split("\n").filter((line) => line.trim() !== "").map(parseLine);
  for (const row of rows) {
    checkType(row.type, type);
  }
  return uniqueIds(rows.map((row) => row.id));
}

/** Return the parsed value of one JSON text, or null when it is not JSON. */
function parseOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Parse one JSON Lines row. The row must be an object, or the file is not a selection file. */
function parseLine(line) {
  const row = parseOrNull(line.trim());
  if (row === null || typeof row !== "object") {
    throw new Error(NOT_JSON_MESSAGE);
  }
  return row;
}

/** Refuse a file whose kind is missing or is not the kind this picker takes. */
function checkType(found, expected) {
  if (found === undefined) {
    throw new Error(NO_TYPE_MESSAGE);
  }
  if (found !== expected) {
    throw new Error(`This file holds ${found} selections, not ${expected} selections.`);
  }
}

/** Return the ids with repeats removed, in the order given. An id must be text, so a number or an object is refused. */
function uniqueIds(values) {
  const ids = [];
  for (const value of values) {
    if (typeof value !== "string" || value === "") {
      throw new Error(BAD_ID_MESSAGE);
    }
    if (!ids.includes(value)) {
      ids.push(value);
    }
  }
  return ids;
}

/**
 * Return the export and import controls for one picker. type is "model" or "question"; label is the plural word shown
 * ("models" or "questions"). getIds() gives the ticked ids. applyIds(ids) ticks exactly those ids and returns
 * { selected, missing }, where missing lists the ids this list does not have. download(fileName, text, mimeType) saves a file.
 */
export function buildSelectionControls({ idPrefix, type, label, getIds, applyIds, download }) {
  const status = el("p", { className: "field-hint", role: "status", "aria-live": "polite" });
  const formatId = `${idPrefix}-format`;
  const formatSelect = el("select", { className: "select", id: formatId }, [
    el("option", { value: "json", text: SELECTION_FORMATS.json.label }),
    el("option", { value: "jsonl", text: SELECTION_FORMATS.jsonl.label }),
  ]);
  const exportButton = el("button", { type: "button", className: "btn", text: `Export ${label}` });
  exportButton.addEventListener("click", () => exportSelection());

  const importId = `${idPrefix}-import`;
  const fileInput = el("input", {
    className: "text-input",
    id: importId,
    type: "file",
    accept: ".json,.jsonl,application/json,application/x-ndjson",
  });
  const importLabel = el("label", { className: "field-label", for: importId, text: `Import ${label} from a file` });
  fileInput.addEventListener("change", () => importSelection());

  /** Save the ticked ids in the chosen format. Nothing is saved when nothing is ticked. */
  function exportSelection() {
    const ids = getIds();
    if (ids.length === 0) {
      status.textContent = `No ${label} are ticked, so there is nothing to export.`;
      return;
    }
    const format = SELECTION_FORMATS[formatSelect.value];
    download(`batch-${type}s.${format.extension}`, selectionToText(type, ids, formatSelect.value), format.mimeType);
    status.textContent = `Exported ${ids.length} ${ids.length === 1 ? type : `${type}s`}.`;
  }

  /** Read the chosen file, tick its ids in place of the current selection, and say what was skipped. */
  async function importSelection() {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    try {
      const ids = parseSelectionText(await file.text(), type);
      const result = applyIds(ids);
      const skipped = result.missing.length > 0 ? ` ${result.missing.length} not in this list, so they were skipped.` : "";
      status.textContent = `Ticked ${result.selected} ${label} from the file.${skipped}`;
    } catch (error) {
      status.textContent = `The file could not be imported: ${error.message}`;
    }
  }

  return el("div", { className: "selection-files" }, [
    el("div", { className: "field" }, [el("label", { className: "field-label", for: formatId, text: "File format" }), formatSelect]),
    exportButton,
    el("div", { className: "field" }, [importLabel, fileInput]),
    status,
  ]);
}
