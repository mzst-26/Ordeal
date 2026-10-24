// CSV cell text for the exports. Pure functions only: no DOM and no network.

// Spreadsheets run a cell that starts with one of these as a formula (CSV injection). Tab and carriage return are
// included because some spreadsheets treat a cell that starts with them the same way.
const FORMULA_START_PATTERN = /^[=+\-@\t\r]/;
// Leading spaces, tabs and carriage returns are skipped before the check, so " =1" is treated like "=1".
const LEADING_BLANKS_PATTERN = /^[ \t\r]+/;

/** Add a single quote in front of text that starts like a formula, so a spreadsheet shows it as text. */
export function neutraliseFormula(text) {
  const firstVisible = text.replace(LEADING_BLANKS_PATTERN, '');
  return FORMULA_START_PATTERN.test(firstVisible) ? `'${text}` : text;
}

/**
 * Return one CSV cell: formula-safe text, in quotes when it has a comma, quote or line break.
 * Null, undefined and NaN give an empty cell.
 */
export function csvCell(value) {
  if (value === null || value === undefined) {
    return '';
  }
  // Numbers are never formulas, so a negative number such as -2 is written as it is.
  if (typeof value === 'number') {
    return Number.isNaN(value) ? '' : String(value);
  }
  const text = neutraliseFormula(String(value));
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
