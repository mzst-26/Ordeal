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
  header = null,
  searchText = null,
  limit = null,
  onReady = null,
}) {
  const search = el("input", { className: "text-input", id: SEARCH_ID, type: "search", placeholder: searchPlaceholder });
  const count = el("p", { className: "picker-count", id: COUNT_ID, role: "status", "aria-live": "polite" });
  const grid = el("div", { className: "picker-grid" });

  // Draw the grid from scratch. Filtering and selection changes both come through here.
  const render = () => {
    // A long list passes searchText and limit: only the matching rows up to the limit get a card, so the page never
    // builds a card for every item. Without them, every card is built and then filtered by its text, as before.
    const bounded = searchText !== null && limit !== null;
    const { cards, more } = bounded
      ? boundedCards(items, search.value, searchText, limit, renderCard, isSelected)
      : { cards: allCards(items, search.value, renderCard, isSelected), more: 0 };
    grid.replaceChildren(...cards.map(({ item, node }) => cardButton(item, node, isSelected, onToggle, render)));
    const { total, selected } = summarizeSelection(items, isSelected);
    const moreText = more > 0 ? ` ${more} more match. Refine the search.` : "";
    count.textContent = `${selected} of ${total} selected${moreText}`;
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
    header,
    count,
    el("div", { className: "picker-body" }, [grid]),
    el("div", { className: "dialog-actions" }, [done]),
  ]);

  search.addEventListener("input", render);
  dialog.addEventListener("close", () => dialog.remove());

  render();
  // The caller may keep the redraw function, so it can refresh the grid after it changes the items (see the batch page).
  onReady?.(render);
  document.body.append(dialog);
  dialog.showModal();
  search.focus();
  return dialog;
}

/**
 * Return a card for every item that matches the query, using the text of the whole card. This is the original path:
 * the cards are built first and then filtered by their text, so it is only used for short lists.
 */
export function allCards(items, query, renderCard, isSelected) {
  const entries = items.map((item) => ({ item, node: renderCard(item, isSelected(item) === true) }));
  return filterItems(entries, query, (entry) => entry.node.textContent);
}

/**
 * Return cards for at most `limit` items whose search text contains the query, and how many more match. Only the
 * shown items are given a card, so a list of many thousands of names never builds thousands of nodes.
 */
export function boundedCards(items, query, searchText, limit, renderCard, isSelected) {
  const needle = query.trim().toLowerCase();
  const cards = [];
  let matches = 0;
  for (const item of items) {
    if (needle === "" || searchText(item).toLowerCase().includes(needle)) {
      matches += 1;
      if (cards.length < limit) {
        cards.push({ item, node: renderCard(item, isSelected(item) === true) });
      }
    }
  }
  return { cards, more: matches - cards.length };
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
