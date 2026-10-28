// Tests for banner-height.js: the levels drawer's offset follows the height of the storage banner.
// Node has no document or ResizeObserver, so both are small fakes that record what the module writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keepBannerHeight } from "../../frontend/js/ui/banner-height.js";

// A fake document with one banner, and a record of every CSS variable the module sets on the root element.
function fakeDocument(banner) {
  const written = {};
  return {
    written,
    querySelector: (selector) => (selector === ".experiment-banner" ? banner : null),
    documentElement: {
      style: {
        setProperty: (name, value) => {
          written[name] = value;
        },
      },
    },
  };
}

// A fake ResizeObserver that keeps its callback, so a test can play the part of a resize.
const observers = [];
class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.observed = null;
    observers.push(this);
  }
  observe(element) {
    this.observed = element;
  }
}

// Put the fake ResizeObserver in place for one test, and remove it afterwards.
function withResizeObserver(run) {
  const saved = globalThis.ResizeObserver;
  globalThis.ResizeObserver = FakeResizeObserver;
  observers.length = 0;
  try {
    run();
  } finally {
    globalThis.ResizeObserver = saved;
  }
}

test("the banner's height is written into the drawer offset variable when the page opens", () => {
  withResizeObserver(() => {
    const banner = { offsetHeight: 31 };
    const doc = fakeDocument(banner);
    keepBannerHeight(doc);
    assert.equal(doc.written["--experiment-banner-height"], "31px");
    assert.equal(observers[0].observed, banner);
  });
});

test("when the banner wraps to two lines the offset is written again with the new height", () => {
  withResizeObserver(() => {
    const banner = { offsetHeight: 31 };
    const doc = fakeDocument(banner);
    keepBannerHeight(doc);
    banner.offsetHeight = 49;
    observers[0].callback();
    assert.equal(doc.written["--experiment-banner-height"], "49px");
  });
});

test("a page without the banner is left alone, and nothing is written", () => {
  withResizeObserver(() => {
    const doc = fakeDocument(null);
    keepBannerHeight(doc);
    assert.deepEqual(doc.written, {});
    assert.equal(observers.length, 0);
  });
});

test("where ResizeObserver is missing nothing is written, so the drawer keeps its default offset", () => {
  const saved = globalThis.ResizeObserver;
  globalThis.ResizeObserver = undefined;
  try {
    const doc = fakeDocument({ offsetHeight: 31 });
    assert.doesNotThrow(() => keepBannerHeight(doc));
    assert.deepEqual(doc.written, {});
  } finally {
    globalThis.ResizeObserver = saved;
  }
});
