// The shared site header: a brand line, the view links, and the theme toggle and Key button. It is a left
// sidebar from 1024px and a top bar below. The router (app.js) builds it once. The links use the hash and
// call the router, so moving between views does not reload the page.

import { askForToken } from "./token-dialog.js";
import { el } from "./ui.js";

// localStorage key that remembers the visitor's theme choice between visits.
const THEME_STORAGE_KEY = "sycophancy-theme";
// The theme choices in the order the button cycles through them. Anything else in storage is ignored.
const THEME_ORDER = ["light", "dark", "system"];
// One entry per view. "view" must match a name in app.js VIEWS; "label" is the text shown in the header.
const NAV_LINKS = [
  { view: "gauntlet", label: "I. Gauntlet" },
  { view: "batch", label: "II. Batch" },
  { view: "live", label: "III. Live" },
];

// The theme shown on this page. It is read from storage once, when the shell is built, and the
// theme button updates it on each press.
let currentTheme = "system";

/** Apply the saved theme and return the header: brand line, view links, then the theme and Key controls. */
export function buildShell({ vault, navigate }) {
  currentTheme = readStoredTheme();
  applyTheme(currentTheme);
  return el("header", { className: "site-header" }, [
    el("p", { className: "site-brand", text: "Ordeal" }),
    buildNav(navigate),
    el("div", { className: "site-tools" }, [buildThemeButton(), ...buildKeyControls(vault)]),
  ]);
}

/** Does nothing; kept exported so the page modules still load. The router builds the header once. */
export function initShell() {}

/** Create the navigation list. Each link carries its view name, so the router can mark the open one. */
function buildNav(navigate) {
  const items = NAV_LINKS.map((link) => el("li", {}, [buildNavLink(link, navigate)]));
  const list = el("ul", { className: "site-nav-list" }, items);
  return el("nav", { className: "site-nav", "aria-label": "Main" }, [list]);
}

/**
 * Create one view link. It uses the hash, so it works as a normal link, but a click is handled by the
 * router, which shows the view without reloading the page.
 */
function buildNavLink({ view, label }, navigate) {
  const link = el("a", {
    className: "site-nav-link",
    href: `#${view}`,
    text: label,
    "data-nav-view": view,
  });
  link.addEventListener("click", (event) => {
    event.preventDefault();
    navigate(view);
  });
  return link;
}

/** Create the theme button. Each press moves to the next choice and remembers it. */
function buildThemeButton() {
  const button = el("button", { type: "button", className: "btn btn-quiet" });
  showThemeLabel(button, currentTheme);
  button.addEventListener("click", () => {
    currentTheme = nextTheme(currentTheme);
    storeTheme(currentTheme);
    applyTheme(currentTheme);
    showThemeLabel(button, currentTheme);
  });
  return button;
}

/** Create the Key button and the status text that sits beside it. */
function buildKeyControls(vault) {
  const status = el("span", { className: "key-status" });
  const button = el("button", { type: "button", className: "btn btn-quiet", text: "Key" });
  refreshKeyStatus(vault, status);
  button.addEventListener("click", async () => {
    await askForToken({ vault });
    refreshKeyStatus(vault, status);
  });
  return [button, status];
}

/** Show "Key saved" when a key is set, or "No key set" when none is. Never show any part of the key. */
function refreshKeyStatus(vault, status) {
  status.textContent = vault.has() ? "Key saved" : "No key set";
}

/** Write the theme name on the theme button. */
function showThemeLabel(button, theme) {
  button.textContent = `Theme: ${theme}`;
}

/** Return the theme after the given one, wrapping from "system" back to "light". */
function nextTheme(theme) {
  const index = THEME_ORDER.indexOf(theme);
  return THEME_ORDER[(index + 1) % THEME_ORDER.length];
}

/** Read the saved theme choice. Falls back to "system" when nothing valid is saved or storage is blocked. */
function readStoredTheme() {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return THEME_ORDER.includes(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

/** Save the theme choice. Storage can be blocked, so a failure is ignored. */
function storeTheme(theme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The theme still changes for this visit, because currentTheme holds it; it just is not saved.
  }
}

/** Set data-theme on the html element. "system" removes it so the operating system setting decides. */
function applyTheme(theme) {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}
