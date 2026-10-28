// The shared site header: a brand line, the view links, and the theme toggle and Key button. It is a left
// sidebar from 1024px and a top bar below. The links use the hash and call the router, so moving between
// views does not reload the page. The router (app.js) marks the open link with aria-current.

import { useLayoutEffect, useState } from "react";
import { askForToken } from "../token-dialog.js";
import { nextSidebarState, readStoredSidebar, writeStoredSidebar } from "../sidebar-state.js";

// localStorage key that remembers the visitor's theme choice between visits.
const THEME_STORAGE_KEY = "sycophancy-theme";
// The theme choices in the order the button cycles through them. Anything else in storage is ignored.
const THEME_ORDER = ["light", "dark", "system"];
// The query that matches the wide screens, where the header is a sidebar that can be collapsed.
const WIDE_QUERY = "(min-width: 1024px)";
// One entry per view. "view" must match a name in app.js VIEWS; "label" is the full text (also the tooltip and
// the accessible name); "short" is the text shown when the sidebar is collapsed.
const NAV_LINKS = [
  { view: "gauntlet", label: "I. Gauntlet", short: "I" },
  { view: "batch", label: "II. Batch", short: "II" },
  { view: "live", label: "III. Live", short: "III" },
];

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
    // The theme still changes for this visit, because the state holds it; it just is not saved.
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

/** The localStorage object, or undefined when the browser blocks access to it. */
function getLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Set data-sidebar on the html element when the sidebar is collapsed on a wide screen. Below 1024px the
 * header is a top bar, so the attribute is removed there and the toggle is hidden by CSS.
 */
function applySidebar(collapsed) {
  const wide = typeof window.matchMedia === "function" && window.matchMedia(WIDE_QUERY).matches;
  if (collapsed && wide) {
    document.documentElement.setAttribute("data-sidebar", "collapsed");
  } else {
    document.documentElement.removeAttribute("data-sidebar");
  }
}

/** Show "Key saved" when a key is set, or "No key set" when none is. Never show any part of the key. */
function keyStatusText(vault) {
  return vault.has() ? "Key saved" : "No key set";
}

/**
 * The header. `vault` holds the Token Factory key, and `navigate(view)` shows a view through the router.
 * The theme is applied before the first paint, so the page never flashes the wrong theme.
 */
export function SiteHeader({ vault, navigate }) {
  const [theme, setTheme] = useState(readStoredTheme);
  const [keyStatus, setKeyStatus] = useState(() => keyStatusText(vault));
  const [collapsed, setCollapsed] = useState(() => readStoredSidebar(getLocalStorage()));

  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Apply the collapsed state, and apply it again when the window crosses the 1024px breakpoint.
  useLayoutEffect(() => {
    applySidebar(collapsed);
    if (typeof window.matchMedia !== "function") {
      return undefined;
    }
    const query = window.matchMedia(WIDE_QUERY);
    const onChange = () => applySidebar(collapsed);
    query.addEventListener("change", onChange);
    return () => {
      query.removeEventListener("change", onChange);
      document.documentElement.removeAttribute("data-sidebar");
    };
  }, [collapsed]);

  /** Move to the next theme choice and remember it. */
  function cycleTheme() {
    const next = nextTheme(theme);
    storeTheme(next);
    setTheme(next);
  }

  /** Collapse or expand the sidebar and remember the choice. */
  function toggleSidebar() {
    const next = nextSidebarState(collapsed);
    writeStoredSidebar(getLocalStorage(), next);
    setCollapsed(next);
  }

  /** Open the key dialog, then show the new status. */
  async function changeKey() {
    await askForToken({ vault });
    setKeyStatus(keyStatusText(vault));
  }

  return (
    <header className={collapsed ? "site-header is-collapsed" : "site-header"}>
      <button
        type="button"
        className="sidebar-toggle"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-controls="site-nav"
        aria-expanded={!collapsed}
        onClick={toggleSidebar}
      >
        <span aria-hidden="true">{collapsed ? "»" : "«"}</span>
      </button>
      <p className="site-brand">Ordeal</p>
      <nav id="site-nav" className="site-nav" aria-label="Main">
        <ul className="site-nav-list">
          {NAV_LINKS.map(({ view, label, short }) => (
            <li key={view}>
              <a
                className="site-nav-link"
                href={`#${view}`}
                data-nav-view={view}
                title={label}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(view);
                }}
              >
                {/* The full label is the accessible name. CSS hides it and shows the short label only when collapsed. */}
                <span className="site-nav-full">{label}</span>
                <span className="site-nav-short" aria-hidden="true" hidden>{short}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="site-tools">
        <button type="button" className="btn btn-quiet" onClick={cycleTheme}>
          {`Theme: ${theme}`}
        </button>
        <button type="button" className="btn btn-quiet" onClick={changeKey}>
          Key
        </button>
        <span className="key-status">{keyStatus}</span>
      </div>
    </header>
  );
}
