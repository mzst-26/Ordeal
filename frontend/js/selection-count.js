// The "N of M selected" line shown at the top of each multi-select group on the batch page. The wording is in
// one place so the models, questions and probe families all read the same way.

/**
 * Return the count line, such as "3 of 29 models selected". With no items at all it says there is nothing to
 * select. The noun is given by the caller (models, questions, families) and only becomes singular for one item,
 * so "1 of 1 model selected" reads correctly.
 */
export function selectionCountText(ticked, total, noun) {
  if (total === 0) {
    return `No ${noun} to select`;
  }
  const word = total === 1 ? singularNoun(noun) : noun;
  return `${ticked} of ${total} ${word} selected`;
}

/** Write the count line into an element's text. Text only, so no markup can come from a label. */
export function updateSelectionCount(element, ticked, total, noun) {
  element.textContent = selectionCountText(ticked, total, noun);
}

/** Return the singular of a plain English plural noun: "families" gives "family", "models" gives "model". */
function singularNoun(noun) {
  if (noun.endsWith("ies")) {
    return `${noun.slice(0, -3)}y`;
  }
  return noun.endsWith("s") ? noun.slice(0, -1) : noun;
}
