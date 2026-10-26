// Tests for the Runs popup wiring that the Batch and Gauntlet pages share (persistence-ui.js). The helpers take plain
// stand-in objects instead of real elements, so they run in Node without a browser. The stand-ins record what was
// called, which is all the wiring has to do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wireRunsPopup, showRunCounts, closePopupBeforeResume } from "../site/js/persistence-ui.js";

/** A stand-in for a button: it keeps its click listener so a test can press it, and a text the helper can write. */
function fakeButton() {
  const listeners = {};
  return {
    textContent: "",
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    press() {
      listeners.click();
    },
  };
}

/** A stand-in for a native dialog: it records showModal() and close() calls and tracks whether it is open. */
function fakeDialog() {
  return {
    open: false,
    closedCount: 0,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      this.closedCount += 1;
    },
  };
}

// The Runs button opens the popup as a modal, and the Done button closes it. Both are needed on every page.
test("wireRunsPopup makes the Runs button open the dialog as a modal", () => {
  const button = fakeButton();
  const dialog = fakeDialog();
  wireRunsPopup({ button, dialog, done: fakeButton() });
  button.press();
  assert.equal(dialog.open, true);
});

test("wireRunsPopup makes the Done button close the dialog", () => {
  const button = fakeButton();
  const done = fakeButton();
  const dialog = fakeDialog();
  wireRunsPopup({ button, dialog, done });
  button.press();
  done.press();
  assert.equal(dialog.open, false);
  assert.equal(dialog.closedCount, 1);
});

// The counts are written in three places: the button label and one count line per section. They must all agree.
test("showRunCounts writes the button label and both section count lines", () => {
  const button = fakeButton();
  const unfinishedLine = { textContent: "" };
  const savedLine = { textContent: "" };
  showRunCounts({ button, unfinishedLine, savedLine }, 1, 3);
  assert.equal(button.textContent, "Runs (1 unfinished, 3 saved)");
  assert.equal(unfinishedLine.textContent, "1 unfinished run");
  assert.equal(savedLine.textContent, "3 saved runs");
});

test("showRunCounts writes the empty wording when there are no runs", () => {
  const button = fakeButton();
  const unfinishedLine = { textContent: "x" };
  const savedLine = { textContent: "x" };
  showRunCounts({ button, unfinishedLine, savedLine }, 0, 0);
  assert.equal(button.textContent, "Runs");
  assert.equal(unfinishedLine.textContent, "No unfinished runs");
  assert.equal(savedLine.textContent, "No saved runs yet");
});

// Resume is pressed from inside the popup. The popup must close first, so the visitor sees the form the run was
// loaded into, and the resume itself must still run with the same run and return the same result.
test("closePopupBeforeResume closes the dialog before the resume runs", async () => {
  const dialog = fakeDialog();
  dialog.open = true;
  let closedWhenResumed = null;
  const resume = async (run) => {
    closedWhenResumed = dialog.closedCount;
    return `resumed ${run.id}`;
  };
  const wrapped = closePopupBeforeResume(dialog, resume);
  const result = await wrapped({ id: "r1" });
  assert.equal(closedWhenResumed, 1);
  assert.equal(dialog.open, false);
  assert.equal(result, "resumed r1");
});
