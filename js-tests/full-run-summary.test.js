// Tests for the links to the full-run summary on the runs page. The links must point at the real files in
// docs/full-run-summary/, and every summary file must have a link, so neither side can drift away from the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { summaryLinks, SUMMARY_URL } from "../site/js/full-run-summary.js";

const SUMMARY_DIR = fileURLToPath(new URL("../docs/full-run-summary/", import.meta.url));

/** Return the paths, relative to the summary folder, of every .md and .csv file in it, including the subfolders. */
function summaryFiles(dir = SUMMARY_DIR) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...summaryFiles(`${full}/`));
    } else if (/\.(md|csv)$/.test(entry.name)) {
      found.push(relative(SUMMARY_DIR, full));
    }
  }
  return found;
}

test("the summary links start with the report, then each condition's results and probes", () => {
  const labels = summaryLinks().map((link) => link.label);
  assert.equal(labels.length, 9);
  assert.match(labels[0], /^Report/);
  assert.deepEqual(labels.slice(1, 3), ["Control: results", "Control: probes"]);
  assert.deepEqual(labels.slice(7, 9), ["Third person: results", "Third person: probes"]);
});

test("every summary link points at a file that exists in docs/full-run-summary", () => {
  for (const link of summaryLinks()) {
    assert.ok(link.href.startsWith(SUMMARY_URL), link.href);
    const file = link.href.slice(SUMMARY_URL.length);
    assert.ok(existsSync(`${SUMMARY_DIR}${file}`), `missing ${file}`);
  }
});

test("every .md and .csv file in the summary folder has a link on the runs page", () => {
  const linked = summaryLinks().map((link) => link.href.slice(SUMMARY_URL.length)).sort();
  assert.deepEqual(linked, summaryFiles().sort());
});
