// Tests for the run totals module (frontend/js/store/run-totals.js). Totals add up over every Start of one saved run,
// so a Stop, a Start again or a rerun does not forget the calls that failed before it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RECENT_FAILURES, addSession, emptyTotals, readTotals, sumTotals } from '../../frontend/js/store/run-totals.js';

/** Return one failure as the batch page records it. */
function failure(step) {
  return { model: 'model-a', question: 'h01', step, reason: 'other', message: 'Server gave up' };
}

/** Return the counts of one Start, with no failures listed, for the tests that only add numbers. */
function session(overrides = {}) {
  return {
    calls: 0, reused: 0, failed: 0, unusable: 0, retries: 0, rateLimits: 0, activeSeconds: 0, failures: [],
    ...overrides,
  };
}

test('a new run has zero totals and no failures listed', () => {
  assert.deepEqual(emptyTotals(), {
    calls: 0, reused: 0, failed: 0, unusable: 0, retries: 0, rateLimits: 0, activeSeconds: 0, failures: [],
  });
});

test('a run saved before totals existed reads as zero totals', () => {
  assert.deepEqual(readTotals({ id: 'old', status: 'done' }), emptyTotals());
});

test('a partly filled totals object reads the missing fields as zero', () => {
  const totals = readTotals({ totals: { failed: 4 } });
  assert.equal(totals.failed, 4);
  assert.equal(totals.calls, 0);
  assert.deepEqual(totals.failures, []);
});

test('adding a Start adds its counts to the saved totals', () => {
  const first = addSession(emptyTotals(), session({ calls: 10, failed: 2, unusable: 1, activeSeconds: 60 }));
  const second = addSession(first, session({ calls: 5, failed: 1, reused: 7, rateLimits: 3 }));
  assert.equal(second.calls, 15);
  assert.equal(second.failed, 3);
  assert.equal(second.unusable, 1);
  assert.equal(second.reused, 7);
  assert.equal(second.rateLimits, 3);
  assert.equal(second.activeSeconds, 60);
});

test('the failure from an earlier Start is still there after a later Start with no failures', () => {
  const saved = addSession(emptyTotals(), session({ failed: 1, failures: [failure('level_0')] }));
  const later = addSession(saved, session({ calls: 4 }));
  assert.equal(later.failed, 1);
  assert.equal(later.failures.length, 1);
  assert.equal(later.failures[0].step, 'level_0');
});

test('only the most recent failures are kept, so the saved run stays small', () => {
  let totals = emptyTotals();
  const many = Array.from({ length: MAX_RECENT_FAILURES + 5 }, (_, index) => failure(`level_${index}`));
  totals = addSession(totals, session({ failed: many.length, failures: many }));
  assert.equal(totals.failures.length, MAX_RECENT_FAILURES);
  assert.equal(totals.failures.at(-1).step, `level_${MAX_RECENT_FAILURES + 4}`);
});

test('adding totals does not change the totals it was given', () => {
  const before = addSession(emptyTotals(), session({ calls: 2 }));
  const snapshot = JSON.stringify(before);
  addSession(before, session({ calls: 9, failures: [failure('level_1')] }));
  assert.equal(JSON.stringify(before), snapshot);
});

test('summing totals adds the counts of every run, such as every condition of one batch', () => {
  const first = addSession(emptyTotals(), session({ calls: 4, failed: 1, failures: [failure('level_0')] }));
  const second = addSession(emptyTotals(), session({ calls: 6, failed: 2, unusable: 1, failures: [failure('level_2')] }));
  const total = sumTotals([first, second]);
  assert.equal(total.calls, 10);
  assert.equal(total.failed, 3);
  assert.equal(total.unusable, 1);
  assert.deepEqual(total.failures.map((item) => item.step), ['level_0', 'level_2']);
});

test('summing no totals gives zero totals', () => {
  assert.deepEqual(sumTotals([]), emptyTotals());
});

test('summing keeps only the most recent failures across the runs', () => {
  const many = Array.from({ length: MAX_RECENT_FAILURES }, (_, index) => failure(`a_${index}`));
  const total = sumTotals([
    addSession(emptyTotals(), session({ failed: many.length, failures: many })),
    addSession(emptyTotals(), session({ failed: 1, failures: [failure('b_0')] })),
  ]);
  assert.equal(total.failed, MAX_RECENT_FAILURES + 1);
  assert.equal(total.failures.length, MAX_RECENT_FAILURES);
  assert.equal(total.failures.at(-1).step, 'b_0');
});
