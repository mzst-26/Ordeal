// Small DOM helpers shared by the three pages. Text always goes in as text, never as markup.

/** Create an element. "text" sets textContent, "className" sets the class, other names use setAttribute. */
export function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    applyAttribute(node, name, value);
  }
  // Null and undefined children are skipped, so callers can write "condition ? node : null" in a list.
  for (const child of children) {
    if (child !== null && child !== undefined) {
      node.append(child);
    }
  }
  return node;
}

/** Set one attribute. false, null and undefined leave it off; true becomes a bare attribute. */
function applyAttribute(node, name, value) {
  if (name === "text") {
    node.textContent = String(value ?? "");
    return;
  }
  if (value === false || value === null || value === undefined) {
    return;
  }
  const attributeName = name === "className" ? "class" : name;
  node.setAttribute(attributeName, value === true ? "" : String(value));
}

/** Remove every child of a node. */
export function clear(node) {
  node.replaceChildren();
}

/** Format a number with a fixed number of digits. NaN (or a non-number) shows as an en dash. */
export function formatNumber(value, digits = 3) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "–";
  }
  return value.toFixed(digits);
}
