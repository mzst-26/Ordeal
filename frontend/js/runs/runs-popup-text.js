// The words for the Runs popup on the Batch page: the count on the Runs button and the count line in each of the
// two sections (Unfinished and Saved). The wording is kept in one place, so the button and the popup always agree.
// These are plain functions that take numbers and return text. They never touch the page, so the tests can run
// them in Node without a browser.

/**
 * Return the label of the Runs button. The button names only the kinds of run that exist, so an empty page shows
 * just "Runs" and a page with one unfinished run and three saved runs shows "Runs (1 unfinished, 3 saved)".
 * The counts are passed in rather than read here, so this file stays free of storage and DOM code.
 */
export function runsButtonText(unfinished, saved) {
  const parts = [];
  if (unfinished > 0) {
    parts.push(`${unfinished} unfinished`);
  }
  if (saved > 0) {
    parts.push(`${saved} saved`);
  }
  return parts.length === 0 ? "Runs" : `Runs (${parts.join(", ")})`;
}

/**
 * Return the count line of the Unfinished section, such as "2 unfinished runs". Zero gets its own sentence, so the
 * section never looks blank while it is empty.
 */
export function unfinishedCountText(count) {
  if (count === 0) {
    return "No unfinished runs";
  }
  return count === 1 ? "1 unfinished run" : `${count} unfinished runs`;
}

/**
 * Return the count line of the Saved section, such as "4 saved runs". Zero says there are none yet, which is the
 * same message the list used to show on its own.
 */
export function savedCountText(count) {
  if (count === 0) {
    return "No saved runs yet";
  }
  return count === 1 ? "1 saved run" : `${count} saved runs`;
}
