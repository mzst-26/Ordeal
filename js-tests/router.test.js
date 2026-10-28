// Tests for frontend/js/app.js: which view a visit asks for, and how the router shows, mounts and titles views.
// The DOM is a small stand-in: only the attributes, the title and the history calls that the router uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeFromLocation, createRouter } from "../frontend/js/app.js";

/** A stand-in element with the attribute methods the router uses, and `hidden` reflected as an attribute. */
class FakeElement {
  constructor(navView = null) {
    this.attributes = new Map();
    this.dataset = { navView };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  // A view with no dialogs open: the router looks for open dialogs before it hides a view.
  querySelectorAll() {
    return [];
  }
  get hidden() {
    return this.attributes.has("hidden");
  }
  set hidden(value) {
    if (value) {
      this.setAttribute("hidden", "");
    } else {
      this.removeAttribute("hidden");
    }
  }
}

/** Build the views, nav links, document and window the router needs, with the history calls recorded. */
function makeDom(hash = "", pathname = "/") {
  const views = { gauntlet: new FakeElement(), batch: new FakeElement(), live: new FakeElement() };
  const links = [new FakeElement("gauntlet"), new FakeElement("batch"), new FakeElement("live")];
  const calls = { pushState: [], replaceState: [] };
  const document = { title: "", querySelectorAll: () => links };
  const window = {
    location: { hash, pathname },
    history: {
      pushState: (state, title, url) => calls.pushState.push(url),
      replaceState: (state, title, url) => calls.replaceState.push(url),
    },
    addEventListener: () => {},
  };
  return { views, links, calls, document, window };
}

/** Mounts that do nothing, one per view, so a test can replace the one it cares about. */
function noMounts() {
  return { gauntlet: () => {}, batch: () => {}, live: () => {} };
}

// Reading the view from the URL: the hash wins over the path, and anything unknown falls back to the gauntlet.
test("routeFromLocation opens batch for the #batch hash", () => {
  assert.equal(routeFromLocation("#batch", "/"), "batch");
});

test("routeFromLocation opens live for the /live path", () => {
  assert.equal(routeFromLocation("", "/live"), "live");
});

test("routeFromLocation opens gauntlet for an unknown hash", () => {
  assert.equal(routeFromLocation("#nope", "/"), "gauntlet");
});

test("routeFromLocation opens gauntlet when there is no hash and the path is the root", () => {
  assert.equal(routeFromLocation("", "/"), "gauntlet");
});

test("routeFromLocation lets the hash win over the path", () => {
  assert.equal(routeFromLocation("#batch", "/live"), "batch");
});

// Router behaviour: mount once, show one section at a time, set the nav state and page title, and keep history tidy.
test("createRouter mounts a view once even when it is shown twice", () => {
  const { views, document, window } = makeDom();
  const mountedRoots = [];
  const mounts = noMounts();
  mounts.batch = (root) => mountedRoots.push(root);
  const router = createRouter({ views, mounts, document, window });
  router.show("batch");
  router.show("gauntlet");
  router.show("batch");
  assert.equal(mountedRoots.length, 1);
  assert.equal(mountedRoots[0], views.batch);
});

test("show hides the other sections and sets aria-current on the matching nav link", () => {
  const { views, links, document, window } = makeDom();
  const router = createRouter({ views, mounts: noMounts(), document, window });
  router.show("live");
  assert.equal(views.live.hidden, false);
  assert.equal(views.gauntlet.hidden, true);
  assert.equal(views.batch.hidden, true);
  assert.equal(links[2].getAttribute("aria-current"), "page");
  assert.equal(links[0].getAttribute("aria-current"), null);
});

// A modal dialog left open in a view that gets hidden keeps the rest of the page inert, so it must be closed first.
test("show closes an open dialog inside a view before it hides that view", () => {
  const { views, document, window } = makeDom();
  let closedCount = 0;
  const dialog = { open: true, close() { this.open = false; closedCount += 1; } };
  views.batch.querySelectorAll = (selector) => (selector === "dialog[open]" && dialog.open ? [dialog] : []);
  const router = createRouter({ views, mounts: noMounts(), document, window });
  router.show("batch");
  router.show("live");
  assert.equal(closedCount, 1);
  assert.equal(dialog.open, false);
});

test("show sets the document title for the view", () => {
  const { views, document, window } = makeDom();
  const router = createRouter({ views, mounts: noMounts(), document, window });
  router.show("batch");
  assert.equal(document.title, "Ordeal: Batch");
});

test("start shows the view from the location and replaces the history entry with its hash", () => {
  const { views, calls, document, window } = makeDom("#batch", "/");
  const router = createRouter({ views, mounts: noMounts(), document, window });
  router.start();
  assert.equal(views.batch.hidden, false);
  assert.deepEqual(calls.replaceState, ["#batch"]);
  assert.deepEqual(calls.pushState, []);
});

test("navigate to another view pushes its hash, and navigate to the same view pushes nothing", () => {
  const { views, calls, document, window } = makeDom("#gauntlet", "/");
  const router = createRouter({ views, mounts: noMounts(), document, window });
  router.start();
  router.navigate("live");
  router.navigate("live");
  assert.deepEqual(calls.pushState, ["#live"]);
  assert.equal(router.current(), "live");
});
