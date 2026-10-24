// Classic script (not a module) so that it still runs when the page's ES modules fail to load.
// If a page is still on its loading text after 8 seconds, it shows a clear message instead.
(function () {
  "use strict";

  const WAIT_MS = 8000;
  const FAILURE_TEXT = "This page did not finish loading. Check your connection, then reload.";
  // The loading texts that the pages show before their data arrives.
  const LOADING_TEXTS = ["Loading the saved runs.", "Loading the data files."];

  // The three views share one document and each has its own status line, so every one is checked.
  function showFailureIfStillLoading() {
    for (const statusElement of document.querySelectorAll("[data-loading-status]")) {
      if (!LOADING_TEXTS.includes(statusElement.textContent.trim())) {
        continue;
      }
      statusElement.textContent = FAILURE_TEXT;
      statusElement.setAttribute("role", "alert");
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(showFailureIfStillLoading, WAIT_MS);
  });
})();
