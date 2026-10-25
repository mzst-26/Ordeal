// A reusable picker: a wide native dialog with search, a count line, bulk actions and a grid of cards.

import { el } from "./ui.js";

const TITLE_ID = "picker-dialog-title";
const SEARCH_ID = "picker-dialog-search";
const COUNT_ID = "picker-dialog-count";

/** Count the items and how many of them the predicate marks as selected. */
export function summarizeSelection(items, isSelected) {
  const selected = items.filter((item) => isSelected(item)).length;
  return { total: items.length, selected };
}

/** Keep the items whose text contains the query, ignoring case and outer spaces. An empty query keeps all. */
export function filterItems(items, query, textOf) {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return items;
  }
  return items.filter((item) => textOf(item).toLowerCase().includes(needle));
}

/**
 * Open a picker dialog and return the dialog element. Each card is a button with aria-pressed, so it
 * works with the keyboard. Search matches the text that renderCard puts into the card.
 * The dialog removes itself from the page when it closes.
 */
export function openPicker({
  title,
  items,
  isSelected,
  onToggle,
  renderCard,
  onSelectAll,
  onClear,
  bulk = true,
  searchPlaceholder = "Search",
}) {
  const search = el("input", { className: "text-input", id: SEARCH_ID, type: "search", placeholder: searchPlaceholder });
  const count = el("p", { className: "picker-count", id: COUNT_ID, role: "status", "aria-live": "polite" });
  const grid = el("div", { className: "picker-grid" });

  // Draw the grid from scratch. Filtering and selection changes both come through here.
  const render = () => {
    const entries = items.map((item) => ({ item, node: renderCard(item, isSelected(item) === true) }));
    const visible = filterItems(entries, search.value, (entry) => entry.node.textContent);
    grid.replaceChildren(...visible.map(({ item, node }) => cardButton(item, node, isSelected, onToggle, render)));
    const { total, selected } = summarizeSelection(items, isSelected);
    count.textContent = `${selected} of ${total} selected`;
  };

  const selectAll = el("button", { type: "button", className: "btn btn-quiet", text: "Select all" });
  const clear = el("button", { type: "button", className: "btn btn-quiet", text: "Clear" });
  selectAll.addEventListener("click", () => {
    onSelectAll?.();
    render();
  });
  clear.addEventListener("click", () => {
    onClear?.();
    render();
  });

  const done = el("button", { type: "button", className: "btn btn-primary", text: "Done" });
  done.addEventListener("click", () => dialog.close());

  const dialog = el("dialog", { className: "picker-dialog", "aria-labelledby": TITLE_ID }, [
    el("h2", { className: "dialog-title", id: TITLE_ID, text: title }),
    el("div", { className: "picker-search" }, [
      el("label", { className: "field-label", for: SEARCH_ID, text: "Search" }),
      search,
      bulk ? el("div", { className: "picker-bulk" }, [selectAll, clear]) : null,
    ]),
    count,
    el("div", { className: "picker-body" }, [grid]),
    el("div", { className: "dialog-actions" }, [done]),
  ]);

  search.addEventListener("input", render);
  dialog.addEventListener("close", () => dialog.remove());

  render();
  document.body.append(dialog);
  dialog.showModal();
  search.focus();
  return dialog;
}

/** Wrap a rendered card in a button that toggles the item and redraws the grid. */
function cardButton(item, node, isSelected, onToggle, render) {
  const selected = isSelected(item) === true;
  const button = el("button", { type: "button", className: "picker-card", "aria-pressed": String(selected) }, [node]);
  button.addEventListener("click", () => {
    onToggle(item);
    render();
  });
  return button;
}
