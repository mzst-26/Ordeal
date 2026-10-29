// Guards the batch page's Resume button. After a Stop the page must offer Resume, which continues the stopped run with its
// own saved settings. Start alone starts again with the form's settings, and so it looks like a reset. These checks read the
// page's markup and source, so a later edit that drops the button or its wiring fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");
const HTML = read("frontend/index.html");
const PAGE = read("frontend/js/pages/page-batch.js");

test("the batch page has a Resume button, hidden until a run is stopped", () => {
  assert.match(HTML, /<button[^>]*id="batch-resume-button"[^>]*hidden[^>]*>Resume<\/button>/);
});

test("Resume continues the last stopped run with its own settings, and is shown only after a stop", () => {
  assert.ok(PAGE.includes('resume: VIEW_IDS.batch["resume-button"]'), "the page must look up the Resume button");
  assert.ok(PAGE.includes("dom.resume.addEventListener(\"click\", resumeLastRun)"), "Resume must be wired to resumeLastRun");
  assert.ok(PAGE.includes("dom.resume.hidden = page.phase !== \"stopped\" || page.lastRunId === null"),
    "Resume must be hidden unless the batch has stopped with a run");
});

test("Resume goes through resumeBatchRun, so the run's own settings are restored", () => {
  const body = PAGE.slice(PAGE.indexOf("async function resumeLastRun("), PAGE.indexOf("\n}\n", PAGE.indexOf("async function resumeLastRun(")));
  assert.ok(body.includes("resumeBatchRun(run)"));
  assert.ok(body.includes("getRun("));
});
