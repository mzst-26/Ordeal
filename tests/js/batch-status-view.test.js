// Tests for the batch status view (frontend/js/pages/batch-status-view.js). The view turns the run's numbers into the
// plain sentences the status panel shows. It reads no clock and no page: each test passes the time it needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatusView } from '../../frontend/js/pages/batch-status-view.js';
import { MIN_ACTIVE_SECONDS_FOR_ESTIMATE, MIN_CALLS_FOR_ESTIMATE } from '../../frontend/js/engine/run-pace.js';

const NOW = 1_000_000;

/** Return the inputs for a run that is in the middle of its units, with nothing wrong yet. */
function input(overrides = {}) {
  return {
    phase: 'running',
    stop: null,
    counts: { done: 28, total: 135, calls: 40, reused: 287, failed: 0, unusable: 0 },
    saved: null,
    activeSeconds: 600,
    callsPerMinute: 4,
    estimate: { state: 'estimating' },
    wait: null,
    nowMs: NOW,
    advice: [],
    ...overrides,
  };
}

test('a run with no numbers yet says it is measuring speed and estimating', () => {
  const view = buildStatusView(input({ callsPerMinute: 0, estimate: { state: 'estimating' } }));
  assert.equal(view.stateWord, 'Running');
  assert.match(view.speed, /Measuring/);
  assert.match(view.eta, /^Estimating/);
});

test('the estimate names the typical time and the range', () => {
  const view = buildStatusView(input({
    estimate: { state: 'ready', seconds: 3600, lowSeconds: 1800, highSeconds: 5400 },
  }));
  assert.equal(view.eta, 'About 1 h 0 min left (between 30 min and 1 h 30 min).');
});

test('the estimate explains how much data it still needs, in words', () => {
  const view = buildStatusView(input({ estimate: { state: 'estimating' } }));
  assert.match(view.eta, new RegExp(`${MIN_CALLS_FOR_ESTIMATE} calls`));
  assert.match(view.eta, new RegExp(`${MIN_ACTIVE_SECONDS_FOR_ESTIMATE / 60} minutes`));
});

test('a platform wait shows the time left, counting down from the wait it was given', () => {
  const view = buildStatusView(input({ wait: { reason: 'rate-limit', seconds: 42, untilMs: NOW + 42_000 } }));
  assert.match(view.wait, /Waiting 42 s/);
  assert.match(view.wait, /tried again/);
});

test('a wait that has already passed is not shown', () => {
  const view = buildStatusView(input({ wait: { reason: 'retry', seconds: 5, untilMs: NOW - 1 } }));
  assert.equal(view.wait, null);
});

test('a stop shows its title, reason and next step, and a run that has not stopped shows none', () => {
  const stopped = buildStatusView(input({
    phase: 'stopped',
    stop: { title: 'The call cap was reached', why: '350 of 350 calls were used.', next: 'Raise the cap.' },
  }));
  assert.equal(stopped.stateWord, 'Stopped');
  assert.equal(stopped.reason, 'The call cap was reached');
  assert.equal(stopped.why, '350 of 350 calls were used.');
  assert.equal(stopped.next, 'Raise the cap.');
  const running = buildStatusView(input());
  assert.equal(running.reason, null);
});

test('a paused run says so and does not claim it is running', () => {
  const view = buildStatusView(input({ phase: 'paused' }));
  assert.equal(view.stateWord, 'Paused');
});

test('elapsed time says that paused time is not counted', () => {
  const view = buildStatusView(input({ activeSeconds: 3720 }));
  assert.equal(view.elapsed, 'Active time 1 h 2 min. Paused time is not counted.');
});

test('the failure line adds the earlier Starts to this Start', () => {
  const view = buildStatusView(input({
    counts: { done: 2, total: 10, calls: 3, reused: 0, failed: 2, unusable: 1 },
    saved: { failed: 5, unusable: 3, rateLimits: 1, retries: 0 },
  }));
  assert.equal(view.failures, '2 failed in this Start, 1 of them unusable. 5 failed in earlier Starts of this run.');
});

test('the failure line says there were no failures when there are none', () => {
  const view = buildStatusView(input());
  assert.equal(view.failures, 'No failed calls.');
});

test('advice rows are passed on with their control and value, and an empty list stays empty', () => {
  const view = buildStatusView(input({
    advice: [
      { label: 'Concurrency', control: 'concurrency-input', value: 8, note: 'Only 8 calls can run at once.' },
    ],
  }));
  assert.deepEqual(view.advice, [
    { text: 'Only 8 calls can run at once.', control: 'concurrency-input', value: 8 },
  ]);
  assert.deepEqual(buildStatusView(input()).advice, []);
});
