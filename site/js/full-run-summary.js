// The full-run summary, as links for the runs page. The files live in docs/full-run-summary/, and the build and the
// dev server publish them under SUMMARY_URL. This module lists them, so the runs page can show them without a
// server call. The list is fixed on purpose: the summary is a finished record, not a run that someone saves or deletes.

/** The address the summary files are published under. It matches the folder the build copies them to. */
export const SUMMARY_URL = "/data/full-run-summary/";

/** The four conditions of the full run, in the order they are shown, with the names people read them by. */
const CONDITIONS = Object.freeze([
  { folder: "control", label: "Control" },
  { folder: "mitigation", label: "Mitigation" },
  { folder: "none", label: "None" },
  { folder: "third_person", label: "Third person" },
]);

/**
 * Return the links to the summary, one per file. The report comes first because it covers all conditions. Each
 * condition then has its results table, with the 95% intervals, and its probe table.
 */
export function summaryLinks() {
  const links = [{ label: "Report: run totals and counts for all conditions", path: "report.md" }];
  for (const condition of CONDITIONS) {
    links.push({ label: `${condition.label}: results`, path: `${condition.folder}/results.csv` });
    links.push({ label: `${condition.label}: probes`, path: `${condition.folder}/probes.csv` });
  }
  return links.map((link) => ({ label: link.label, href: SUMMARY_URL + link.path }));
}
