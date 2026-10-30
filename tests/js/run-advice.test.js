// Tests for the run advice module (frontend/js/engine/run-advice.js). The advice is only a suggestion: each function
// takes the numbers it needs and returns a value and a plain note, so the page can show both and let the user decide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CAP,
  MAX_TOKEN_CHOICES,
  MIN_UNITS_FOR_ADVICE,
  adviseCap,
  adviseConcurrency,
  adviseMaxTokens,
  capToFinish,
  replySizeAdvice,
} from '../../frontend/js/engine/run-advice.js';

test('concurrency above what the models and the platform can use is cut to that number, with a note', () => {
  // Five models at 4 calls each would allow 20, but the platform only lets 8 calls run at once.
  const advice = adviseConcurrency({ concurrency: 300, models: 5, perModelLimit: 4, platformLimit: 8 });
  assert.equal(advice.value, 8);
  assert.match(advice.note, /8 calls can run at once/);
});

test('concurrency within the usable number is kept and has no note', () => {
  const advice = adviseConcurrency({ concurrency: 4, models: 5, perModelLimit: 4, platformLimit: 8 });
  assert.equal(advice.value, 4);
  assert.equal(advice.note, null);
});

test('a cap that fits under the page maximum is rounded up to a multiple of ten with no note', () => {
  const advice = adviseCap({ stepsLeft: 101, attemptsPerStep: 1, currentCap: 50 });
  assert.equal(advice.value, 110);
  assert.equal(advice.starts, 1);
  assert.equal(advice.note, null);
});

test('a cap need above the page maximum is set to the maximum and says how many Starts are needed', () => {
  // 1000 calls are needed, at most 400 per Start: three Starts.
  const advice = adviseCap({ stepsLeft: 1000, attemptsPerStep: 1, currentCap: 50 });
  assert.equal(advice.value, MAX_CAP);
  assert.equal(advice.starts, 3);
  assert.match(advice.note, /3 Starts/);
});

test('retries seen so far raise the calls needed for the steps left', () => {
  // 100 steps, but each one has taken 1.5 attempts on average: 150 calls needed, rounded to 150.
  const advice = adviseCap({ stepsLeft: 100, attemptsPerStep: 1.5, currentCap: 50 });
  assert.equal(advice.value, 150);
});

test('max tokens is kept when too few replies have been seen', () => {
  const advice = adviseMaxTokens({ maxTokens: 2048, units: MIN_UNITS_FOR_ADVICE - 1, stopped: 10 });
  assert.equal(advice.value, 2048);
  assert.equal(advice.note, null);
});

test('max tokens is kept when unusable replies are at or below the alert share', () => {
  // 4 of 20 is exactly 20 percent, the alert share, so nothing changes.
  const advice = adviseMaxTokens({ maxTokens: 2048, units: 20, stopped: 4 });
  assert.equal(advice.value, 2048);
  assert.equal(advice.note, null);
});

test('max tokens steps up to the next setting when many replies are empty or cut short', () => {
  const advice = adviseMaxTokens({ maxTokens: 2048, units: 20, stopped: 9 });
  assert.equal(advice.value, 4096);
  assert.match(advice.note, /45% of units/);
});

test('max tokens says so when even the largest setting is not enough', () => {
  const largest = MAX_TOKEN_CHOICES[MAX_TOKEN_CHOICES.length - 1];
  const advice = adviseMaxTokens({ maxTokens: largest, units: 20, stopped: 9 });
  assert.equal(advice.value, largest);
  assert.match(advice.note, /largest setting/);
});

// The cap a Start must have to finish what is left: at least the cap the form holds, and at least what the remaining steps
// need. A stale small cap is raised, so a Start is not stopped by a cap left over from an earlier run.
test("the cap is raised to the calls the remaining steps need, and never lowered", () => {
  assert.equal(capToFinish({ cap: 8, stepsLeft: 100, attemptsPerStep: 1 }), 150);
  assert.equal(capToFinish({ cap: 400, stepsLeft: 10, attemptsPerStep: 1 }), 400);
  assert.equal(capToFinish({ cap: 8, stepsLeft: 0, attemptsPerStep: 1 }), 8);
});

// The reply size suggestion describes the calls that were sent. A reply size chosen on the form but not yet sent says it
// takes effect at the next Start; the suggestion comes back only from calls sent at that size.
test("a reply size chosen but not yet sent shows as pending, not as a suggestion from the old calls", () => {
  const advice = replySizeAdvice({ chosen: 4096, statsAt: 2048, units: 30, stopped: 9 });
  assert.equal(advice.value, 4096);
  assert.match(advice.note, /takes effect at the next Start or Resume/);
});

test("once calls are sent at the chosen size, the pending note is gone", () => {
  const advice = replySizeAdvice({ chosen: 4096, statsAt: 4096, units: 0, stopped: 0 });
  assert.equal(advice.note, null);
});

test("the suggestion comes back only from units stopped at the chosen size", () => {
  const advice = replySizeAdvice({ chosen: 4096, statsAt: 4096, units: 30, stopped: 9 });
  assert.match(advice.note, /4096 tokens/);
});

test("before any call has been sent there are no statistics, so the suggestion is the plain rule", () => {
  assert.equal(replySizeAdvice({ chosen: 2048, statsAt: null, units: 0, stopped: 0 }).note, null);
});
