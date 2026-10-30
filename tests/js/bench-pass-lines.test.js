// Tests for the pass-line checker of the chart benchmark (benchmarks/charts/pass-lines.js). The checker turns a measured
// number into a verdict: pass, fail, or unmeasured. The third verdict matters: a case that could not run must never be
// counted as a pass, so a missing number is reported with the reason it is missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PASS_LINES, judgeTiming, judgeCheck, summarise } from "../../benchmarks/charts/pass-lines.js";

test("the proposed pass lines are one second for a render and 100 ms for an interaction", () => {
  assert.equal(PASS_LINES.renderMs, 1000);
  assert.equal(PASS_LINES.interactionMs, 100);
});

test("a timing under its line passes", () => {
  const verdict = judgeTiming({ name: "hover", valueMs: 42, lineMs: 100 });
  assert.equal(verdict.verdict, "pass");
  assert.equal(verdict.valueMs, 42);
});

test("a timing at or over its line fails, because the line is a strict upper bound", () => {
  assert.equal(judgeTiming({ name: "hover", valueMs: 100, lineMs: 100 }).verdict, "fail");
  assert.equal(judgeTiming({ name: "render", valueMs: 1500, lineMs: 1000 }).verdict, "fail");
});

test("a timing that is missing, not finite, or negative is unmeasured, with its reason", () => {
  for (const valueMs of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -5]) {
    const verdict = judgeTiming({ name: "render", valueMs, lineMs: 1000, reason: "timed out after 60 s" });
    assert.equal(verdict.verdict, "unmeasured");
    assert.equal(verdict.reason, "timed out after 60 s");
  }
});

test("an unmeasured timing with no reason still says that nothing was recorded", () => {
  const verdict = judgeTiming({ name: "render", valueMs: null, lineMs: 1000 });
  assert.equal(verdict.verdict, "unmeasured");
  assert.match(verdict.reason, /no timing/);
});

test("a check that holds passes, one that does not fails, and one not run is unmeasured", () => {
  assert.equal(judgeCheck({ name: "legend", passed: true }).verdict, "pass");
  assert.equal(judgeCheck({ name: "legend", passed: false }).verdict, "fail");
  const skipped = judgeCheck({ name: "legend", passed: null, reason: "the engine did not render" });
  assert.equal(skipped.verdict, "unmeasured");
  assert.equal(skipped.reason, "the engine did not render");
});

test("the summary counts pass, fail and unmeasured results, and keeps unmeasured apart from pass", () => {
  const results = [
    judgeTiming({ name: "a", valueMs: 10, lineMs: 100 }),
    judgeTiming({ name: "b", valueMs: 900, lineMs: 100 }),
    judgeTiming({ name: "c", valueMs: null, lineMs: 100 }),
    judgeCheck({ name: "d", passed: true }),
  ];
  assert.deepEqual(summarise(results), { pass: 2, fail: 1, unmeasured: 1 });
});
