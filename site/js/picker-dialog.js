// A reusable picker: a wide native dialog with search, a count line, bulk actions and a grid of cards.
// A long list can be shown one page at a time (pageSize), with letter headings between its groups (groupItems).
// Short lists keep the original path, where every card is built and then filtered by its text.

import { el } from "./ui.js";
import { pageOf } from "./model-list.js";

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
 * Return the line that says which page is on show and which names it holds, out of how many match. An empty result
 * says so in plain words, so the visitor is never left with a blank count.
 */
export function pageRangeText(result, size) {
  if (result.total === 0) {
    return "No models match.";
  }
  const first = (result.page - 1) * size + 1;
  const last = first + result.items.length - 1;
  return `Page ${result.page} of ${result.pageCount}. Showing ${first}-${last} of ${formatTotal(result.total)}`;
}

/** Write a count with thousands separators, such as 22,000, so the page line is easy to read. */
function formatTotal(total) {
  return total.toLocaleString("en-US");
}

/**
 * Open a picker dialog and return the dialog element. Each card is a button with aria-pressed, so it
 * works with the keyboard. Search matches the text that renderCard puts into the card.
 * The dialog removes itself from the page when it closes.
 *
 * Optional, for long lists:
 * - pageSize: show this many names per page, with Previous and Next. A new search goes back to page 1.
 * - searchText: the text a name is searched by (default: the item itself, as a string).
 * - groupItems(items): split the shown page into groups, returned as [{label, items}]. Each group with a label gets a
 *   heading across the grid. Headings are not cards, so they are never clicked and never searched.
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
  pageSize = null,
  groupItems = null,
  onReady = null,
}) {
  const search = el("input", { className: "text-input", id: SEARCH_ID, type: "search", placeholder: searchPlaceholder });
  const count = el("p", { className: "picker-count", id: COUNT_ID, role: "status", "aria-live": "polite" });
  const grid = el("div", { className: "picker-grid" });
  const textOf = searchText ?? ((item) => String(item));

  // The page on show, counted from 1. Typing in the search box starts again at page 1 (see the search listener).
  let page = 1;

  // Draw the grid from scratch. Filtering, paging and selection changes all come through here.
  const render = () => {
    const view = pageSize === null ? plainView() : pagedView();
    grid.replaceChildren(...view.nodes);
    count.textContent = view.countText;
  };

  // The short-list path: every card is built, then the cards are filtered by their text.
  const plainView = () => {
    const entries = allCards(items, search.value, renderCard, isSelected);
    const { total, selected } = summarizeSelection(items, isSelected);
    return {
      nodes: entries.map(({ item, node }) => cardButton(item, node, isSelected, onToggle, render)),
      countText: `${selected} of ${total} selected`,
    };
  };

  // The long-list path: the names are filtered first, then only the names on this page get a card.
  const pagedView = () => {
    const matches = filterItems(items, search.value, textOf);
    const result = pageOf(matches, page, pageSize);
    page = result.page;
    showPager(result);
    const { total, selected } = summarizeSelection(items, isSelected);
    return {
      nodes: pageNodes(result.items),
      countText: `${formatTotal(result.total)} match. ${selected} of ${total} selected.`,
    };
  };

  // Build the cards for one page. With groupItems, each group starts with a heading across the grid.
  const pageNodes = (pageItems) => {
    const groups = groupItems ? groupItems(pageItems) : [{ label: null, items: pageItems }];
    return groups.flatMap((group) => [
      ...(group.label === null ? [] : [groupHeading(group.label)]),
      ...group.items.map((item) => {
        const node = renderCard(item, isSelected(item) === true);
        return cardButton(item, node, isSelected, onToggle, render);
      }),
    ]);
  };

  // Put the page line on show, and turn Previous and Next off at the first and last pages.
  const showPager = (result) => {
    pageText.textContent = pageRangeText(result, pageSize);
    previous.disabled = result.page <= 1;
    next.disabled = result.page >= result.pageCount;
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

  // The page controls are only drawn for a long list. Previous and Next move one page at a time.
  const previous = el("button", { type: "button", className: "btn btn-quiet", text: "Previous" });
  const next = el("button", { type: "button", className: "btn btn-quiet", text: "Next" });
  const pageText = el("span", { className: "picker-page-text" });
  previous.addEventListener("click", () => {
    page -= 1;
    render();
  });
  next.addEventListener("click", () => {
    page += 1;
    render();
  });
  const pager = el("div", { className: "picker-pager", hidden: pageSize === null }, [previous, pageText, next]);

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
    pager,
    el("div", { className: "picker-body" }, [grid]),
    el("div", { className: "dialog-actions" }, [done]),
  ]);

  // A new search starts again at page 1, so the visitor never lands on an empty later page.
  search.addEventListener("input", () => {
    page = 1;
    render();
  });
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

/** Build the heading for one group of a long list. It is plain text, so it is never clickable. */
function groupHeading(label) {
  return el("h3", { className: "picker-group", text: label });
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
