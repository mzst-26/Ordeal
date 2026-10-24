// Pure helpers for FIG 4 (head to head), FIG 5 (transcript replay) and the Model Card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { betterSide, biggestGapAxis, numericValue } from "../site/js/compare/fig-h2h.js";
import {
  visibleCharCount,
  visibleText,
  replayTimeline,
  stampFor,
  confessionSentence,
  TURN_MS,
} from "../site/js/compare/fig-replay.js";
import {
  backboneFormulaText,
  sizeText,
  cardFileName,
  confessionBar,
  qualityChips,
  viewChange,
  closeHandoff,
  consistencyStatus,
} from "../site/js/compare/model-card.js";

const rate = (value, low = null, high = null, n = 10) => ({ rate: value, ci_low: low, ci_high: high, n });

test("betterSide: higher is better, lower is better, ties and nulls are not bold", () => {
  assert.equal(betterSide(rate(0.6), rate(0.4), true), "a");
  assert.equal(betterSide(rate(0.6), rate(0.4), false), "b");
  assert.equal(betterSide(rate(0.3), rate(0.3, 0.1, 0.5), true), null, "a tie is not bold, even with different intervals");
  assert.equal(betterSide(rate(null), rate(0.4), true), null, "not run is never bold");
  assert.equal(betterSide(rate(0.4), null, false), null);
  assert.equal(betterSide(undefined, rate(0.4), true), null);
  assert.equal(betterSide(rate(0.9), rate(0.1), null), null, "a row without a direction is never bold");
});

test("numericValue reads rates, numbers and nulls", () => {
  assert.equal(numericValue(rate(0.25)), 0.25);
  assert.equal(numericValue(3), 3);
  assert.equal(numericValue(rate(null)), null);
  assert.equal(numericValue(NaN), null);
  assert.equal(numericValue(undefined), null);
});

test("biggestGapAxis picks the widest gap and ignores axes with a null on either side", () => {
  const axes = ["bare", "oracle", "trojan", "authority"];
  const a = { bare: rate(0.1), oracle: rate(0.9), trojan: rate(null), authority: rate(0.5) };
  const b = { bare: rate(0.2), oracle: rate(0.2), trojan: rate(0.0), authority: rate(0.4) };
  const found = biggestGapAxis(axes, a, b);
  assert.equal(found.axis, "oracle");
  assert.equal(found.higher, "a", "model A has the higher flip rate on oracle");
  assert.ok(Math.abs(found.gap - 0.7) < 1e-9);
});

test("biggestGapAxis returns null when no axis has both values", () => {
  const axes = ["bare", "oracle"];
  assert.equal(biggestGapAxis(axes, { bare: rate(null) }, { bare: rate(0.3) }), null);
  assert.equal(biggestGapAxis(axes, {}, {}), null);
});

test("biggestGapAxis: a tie in the gap keeps the earlier axis, and a tie in value picks side a", () => {
  const axes = ["bare", "oracle"];
  const a = { bare: rate(0.5), oracle: rate(0.5) };
  const b = { bare: rate(0.2), oracle: rate(0.2) };
  const found = biggestGapAxis(axes, a, b);
  assert.equal(found.axis, "bare");
  assert.equal(found.higher, "a");
  assert.equal(biggestGapAxis(["bare"], { bare: rate(0.2) }, { bare: rate(0.5) }).higher, "b");
});

test("replay timing: visible characters grow with time and speed", () => {
  assert.equal(visibleCharCount("Hello", 10, 0), 0);
  assert.equal(visibleCharCount("Hello", 10, 300), 3);
  assert.equal(visibleCharCount("Hello", 10, 499), 4);
  assert.equal(visibleCharCount("Hello", 10, 10000), 5, "never more than the text length");
  assert.equal(visibleCharCount("Hello", 20, 200), 4);
  assert.equal(visibleCharCount("", 60, 1000), 0);
  assert.equal(visibleCharCount("Hi", 0, 1000), 0, "a speed of zero shows nothing");
  assert.equal(visibleText("Hello", 10, 200), "He");
  assert.equal(visibleCharCount("a😀b", 1, 1000), 1);
  assert.equal(visibleText("a😀b", 2, 1000), "a😀", "counts whole characters, not UTF-16 units");
});

test("replay timeline: turns come first, then the reply types, then it is done", () => {
  const base = { priorCount: 2, replyText: "Answer: B", cps: 10 };
  const early = replayTimeline({ ...base, elapsedMs: 0 });
  assert.deepEqual(early, { turnsShown: 1, replyStarted: false, replyChars: 0, done: false });
  const mid = replayTimeline({ ...base, elapsedMs: 2 * TURN_MS + 300 });
  assert.equal(mid.replyStarted, true);
  assert.equal(mid.replyChars, 3);
  assert.equal(mid.done, false);
  const end = replayTimeline({ ...base, elapsedMs: 2 * TURN_MS + 1000 });
  assert.equal(end.replyChars, 9);
  assert.equal(end.done, true);
  assert.equal(end.turnsShown, 2);
  const noPrior = replayTimeline({ priorCount: 0, replyText: "", cps: 60, elapsedMs: 0 });
  assert.deepEqual(noPrior, { turnsShown: 0, replyStarted: true, replyChars: 0, done: true });
});

test("stamp choice: HELD for held, FOLDED for folded, nothing for anything else", () => {
  assert.deepEqual(stampFor("held"), { label: "HELD", tone: "held" });
  assert.deepEqual(stampFor("folded"), { label: "FOLDED", tone: "folded" });
  assert.equal(stampFor("unknown"), null);
  assert.equal(stampFor(undefined), null);
});

test("confession sentence: names the letter and text, or says none was saved", () => {
  assert.equal(
    confessionSentence({ letter: "C", text: "The capital is Canberra." }),
    "It still believed: C. The capital is Canberra.",
  );
  assert.equal(confessionSentence(null), "No confession was saved for this question.");
  assert.equal(confessionSentence({ letter: "", text: "" }), "No confession was saved for this question.");
});

test("backbone formula text states the mean of the 12 fingerprint rates", () => {
  const text = backboneFormulaText();
  assert.match(text, /1 minus the mean of the 12 fingerprint flip rates/);
  assert.match(text, /higher means firmer/);
  assert.match(text, /built from the same 12 rates/);
  assert.match(text, /not an exact interval/);
});

test("size text: params and active params, dense, or not run", () => {
  assert.equal(sizeText({ params_b: 30, active_params_b: 3 }), "30B parameters, 3B active");
  assert.equal(sizeText({ params_b: 27, active_params_b: null }), "27B parameters, dense");
  assert.equal(sizeText({ params_b: null, active_params_b: null }), "size not run");
});

test("card file name is a safe slug", () => {
  assert.equal(cardFileName("Qwen/Qwen3-30B-A3B-Instruct-2507"), "model-card-qwen-qwen3-30b-a3b-instruct-2507.png");
  assert.equal(cardFileName("///"), "model-card-model.png");
});

test("confession bar: hidden without confessions, widths fill the bar otherwise", () => {
  assert.equal(confessionBar({ capitulated_share: rate(null), converted_share: rate(null) }), null);
  assert.equal(
    confessionBar({ capitulated_share: rate(0, null, null, 0), converted_share: rate(0, null, null, 0) }),
    null,
  );
  const bar = confessionBar({ capitulated_share: rate(0.25, 0.1, 0.4, 8), converted_share: rate(0.75, 0.6, 0.9, 8) });
  assert.ok(Math.abs(bar.capitulatedWidth - 25) < 1e-9);
  assert.ok(Math.abs(bar.convertedWidth - 75) < 1e-9);
});

test("quality chips carry their numbers and flag warnings", () => {
  const model = {
    units: 56,
    questions: 29,
    unparsed_share: rate(0.12),
    gates: {
      low_sample: true,
      low_sample_cells: ["bare"],
      data_warning: true,
      consistency_flag: false,
      final_correct_check: { lower: 0.5, upper: 0.6, final: 0.55, ok: true },
    },
  };
  const chips = qualityChips(model);
  assert.equal(chips[0].text, "56 units");
  assert.equal(chips[1].text, "29 questions");
  assert.equal(chips[2].text, "Unparsed 12%");
  assert.equal(chips[2].warn, true);
  assert.equal(chips[3].text, "Low sample: 1 cell under 15 units");
  assert.equal(chips[4].warn, true);
  assert.equal(chips[5].warn, false);
});

test("view change: the same model opens again after it was closed", () => {
  assert.equal(viewChange(null, "m1", null), "open", "first open");
  assert.equal(viewChange("m1", "m1", "m1"), null, "no change while it stays open");
  // After Close, app.js clears openId, so the next view has no open model...
  assert.equal(viewChange("m1", null, null), null, "closed card with nothing to do");
  // ...and opening the same model again is a change from null to m1.
  assert.equal(viewChange(null, "m1", null), "open", "reopen the same model");
  assert.equal(viewChange("m1", null, "m1"), "close", "app clears the model while the card is open");
  assert.equal(viewChange("m1", "m2", "m1"), "open", "a different model opens");
});

test("close handoff calls api.closeModel once, and tolerates an api without it", () => {
  let calls = 0;
  assert.equal(closeHandoff({ closeModel: () => { calls += 1; } }), true);
  assert.equal(calls, 1);
  assert.equal(closeHandoff({}), false);
  assert.equal(closeHandoff(undefined), false);
});

test("consistency status uses the builder status, and falls back to the flag", () => {
  const check = { lower: 0.5, upper: 0.6, final: 0.55 };
  assert.equal(consistencyStatus({ final_correct_check: { ...check, status: "ok" } }), "ok");
  assert.equal(consistencyStatus({ final_correct_check: { ...check, status: "fail" } }), "fail");
  assert.equal(consistencyStatus({ final_correct_check: { ...check, status: "not_run" } }), "not_run");
  assert.equal(consistencyStatus({ final_correct_check: check, consistency_flag: true }), "fail");
  assert.equal(consistencyStatus({ final_correct_check: check, consistency_flag: false }), "ok");
  assert.equal(consistencyStatus({}), "not_run");
  assert.equal(qualityChips({ units: 1, questions: 1, gates: { final_correct_check: { ...check, status: "not_run" } } })[5].text, "Consistency: not run");
});
