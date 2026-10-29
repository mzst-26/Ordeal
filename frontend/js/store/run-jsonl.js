// A saved run as a JSON Lines file. The first line is the run's header: its label, status, settings and planned units.
// Each line after it holds one saved unit. The file is written from exportRun, so it keeps the same visible fields and
// the same key check, and it is read back with parseRunJsonl and saved with importRunDocument.

import { exportRun } from "./run-store.js";

const RUN_KIND = "run";
const UNIT_KIND = "unit";
const NOT_RUN_MESSAGE = "The file is not a saved run. Its first line must be the run's header.";
const BAD_LINE_MESSAGE = "The file is not JSON Lines.";
const BAD_UNIT_MESSAGE = "A line after the header is not a saved unit.";

/**
 * Return the run as JSON Lines: the header line first, then one line for each saved unit, ending with a newline.
 * Each line is a JSON object, so a unit's steps can be read one at a time.
 */
export function runToJsonl(run) {
  const { results, ...header } = JSON.parse(exportRun(run));
  const lines = [{ kind: RUN_KIND, ...header }];
  for (const [unit, payload] of Object.entries(results)) {
    lines.push({ kind: UNIT_KIND, unit, payload });
  }
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/**
 * Read a saved run from JSON Lines text, in the shape importRunDocument takes. It throws a plain reason when the first
 * line is not a run header, or a later line is not a saved unit.
 */
export function parseRunJsonl(text) {
  const rows = text.split("\n").filter((line) => line.trim() !== "").map(parseRow);
  const [header, ...units] = rows;
  if (header === undefined || header.kind !== RUN_KIND) {
    throw new Error(NOT_RUN_MESSAGE);
  }
  const results = {};
  for (const row of units) {
    if (row.kind !== UNIT_KIND || typeof row.unit !== "string") {
      throw new Error(BAD_UNIT_MESSAGE);
    }
    // defineProperty keeps a unit key such as "__proto__" as an ordinary entry, the same as importRunDocument does.
    Object.defineProperty(results, row.unit, { value: row.payload, enumerable: true, writable: true, configurable: true });
  }
  return {
    label: header.label,
    status: header.status,
    config: header.config,
    plannedUnits: header.plannedUnits,
    results,
    // Older files have no totals, so the field is left out and the run starts with zero totals.
    totals: header.totals,
  };
}

/**
 * Return true when a line is the header of a saved-run file. Any other file, such as a replies file, gives false, so the
 * page can read it in the way it reads replies.
 */
export function isRunHeaderLine(line) {
  try {
    return JSON.parse(line).kind === RUN_KIND;
  } catch {
    return false;
  }
}

/** Parse one line of the file. A line that is not JSON gives the plain reason. */
function parseRow(line) {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(BAD_LINE_MESSAGE);
  }
}
