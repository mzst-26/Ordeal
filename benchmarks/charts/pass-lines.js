// The pass-line checker for the chart benchmark. It turns each measured number into one of three verdicts: pass,
// fail, or unmeasured. The lines come from the owner's plan (the "Benchmark" table of the chart platforms report), and
// they are proposals, not thresholds from any library. The checker is pure, so the node tests can check it without a
// browser: the timing itself is machine-dependent and is never tested in CI.
// Why the third verdict: a case that could not run (a timeout, a crash, an engine without the feature) must not be
// counted as a pass or a fail. It is reported as unmeasured, with the reason, so the report can say what is missing.

// The two proposed lines, in milliseconds. A first render must finish under one second. A hover, a selection or a
// toggle must respond under 100 ms, the usual limit for a response that feels instant.
export const PASS_LINES = Object.freeze({
  renderMs: 1000,
  interactionMs: 100,
});

// The reason shown when a timing is missing and the caller gave none.
const DEFAULT_MISSING_REASON = "no timing was recorded";

/** True when a value is a usable timing: a finite number that is not negative. */
function isUsableTiming(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * The verdict for one timing. A value strictly under the line passes; a value at or over it fails, because the line is
 * the most the case may take. A missing, infinite, NaN or negative value is unmeasured, and the reason is kept.
 */
export function judgeTiming({ name, valueMs, lineMs, reason }) {
  if (!isUsableTiming(valueMs)) {
    return { name, verdict: "unmeasured", valueMs: null, lineMs, reason: reason || DEFAULT_MISSING_REASON };
  }
  const verdict = valueMs < lineMs ? "pass" : "fail";
  return { name, verdict, valueMs, lineMs, reason: reason || "" };
}

/**
 * The verdict for a yes-or-no check, such as "the colour legend is drawn". true passes, false fails, and null means the
 * check could not be run, so it is unmeasured. The reason explains why it could not be run.
 */
export function judgeCheck({ name, passed, reason }) {
  if (passed === null || passed === undefined) {
    return { name, verdict: "unmeasured", reason: reason || DEFAULT_MISSING_REASON };
  }
  return { name, verdict: passed ? "pass" : "fail", reason: reason || "" };
}

/**
 * Counts the verdicts of a list of results. Unmeasured results are counted on their own, so they never add to passes.
 */
export function summarise(results) {
  const counts = { pass: 0, fail: 0, unmeasured: 0 };
  for (const result of results) {
    counts[result.verdict] += 1;
  }
  return counts;
}
