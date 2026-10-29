// Tests for the run pace module (frontend/js/engine/run-pace.js). It reads no clock of its own: each test passes a fake
// clock, so the speeds and the estimates can be checked exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_ACTIVE_SECONDS_FOR_ESTIMATE,
  MIN_CALLS_FOR_ESTIMATE,
  createPaceTracker,
  estimateRemaining,
  formatDuration,
} from '../../frontend/js/engine/run-pace.js';

/** Return a fake clock that starts at time 0 and moves only when the test says so. */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    advanceSeconds: (seconds) => { time += seconds * 1000; },
  };
}

test('a new tracker has made no calls and has no active time', () => {
  const tracker = createPaceTracker({ now: fakeClock().now });
  assert.equal(tracker.callCount(), 0);
  assert.equal(tracker.activeSeconds(), 0);
  assert.equal(tracker.callsPerMinute(), 0);
});

test('time while the tracker is paused does not count as active time', () => {
  const clock = fakeClock();
  const tracker = createPaceTracker({ now: clock.now });
  tracker.start();
  clock.advanceSeconds(60);
  tracker.pause();
  clock.advanceSeconds(3600);
  assert.equal(tracker.activeSeconds(), 60);
});

test('calls per minute counts the calls in the last ten active minutes', () => {
  const clock = fakeClock();
  const tracker = createPaceTracker({ now: clock.now });
  tracker.start();
  for (let i = 0; i < 30; i += 1) {
    clock.advanceSeconds(10);
    tracker.noteCall();
  }
  // Five minutes of active time, thirty calls: six calls a minute.
  assert.equal(tracker.callCount(), 30);
  assert.equal(tracker.callsPerMinute(), 6);
});

test('calls older than the window do not change the speed', () => {
  const clock = fakeClock();
  const tracker = createPaceTracker({ now: clock.now });
  tracker.start();
  tracker.noteCall();
  clock.advanceSeconds(3600);
  tracker.noteCall();
  tracker.noteCall();
  // Only the last two calls are inside the ten-minute window, and the window is full, so the speed is 2 per 10 min.
  assert.equal(tracker.callsPerMinute(), 0.2);
  assert.equal(tracker.callCount(), 3);
});

test('estimateRemaining says it is estimating until enough calls and active time are seen', () => {
  const result = estimateRemaining({
    unitsLeft: 100,
    unitSteps: [4, 5, 6],
    callsPerMinute: 2,
    callCount: MIN_CALLS_FOR_ESTIMATE - 1,
    activeSeconds: MIN_ACTIVE_SECONDS_FOR_ESTIMATE * 2,
  });
  assert.equal(result.state, 'estimating');
});

test('estimateRemaining says it is estimating when no unit has finished yet', () => {
  const result = estimateRemaining({
    unitsLeft: 100,
    unitSteps: [],
    callsPerMinute: 6,
    callCount: 500,
    activeSeconds: 3600,
  });
  assert.equal(result.state, 'estimating');
});

test('estimateRemaining gives a typical time and a range from the steps seen per unit', () => {
  // Two units left, each about 4 calls on average, between 3 and 5. At 6 calls a minute:
  // typical 8 calls = 80 s, low 6 calls = 60 s, high 10 calls = 100 s.
  const result = estimateRemaining({
    unitsLeft: 2,
    unitSteps: [3, 4, 5],
    callsPerMinute: 6,
    callCount: MIN_CALLS_FOR_ESTIMATE,
    activeSeconds: MIN_ACTIVE_SECONDS_FOR_ESTIMATE,
  });
  assert.equal(result.state, 'ready');
  assert.equal(result.seconds, 80);
  assert.equal(result.lowSeconds, 60);
  assert.equal(result.highSeconds, 100);
});

test('estimateRemaining says there is nothing left when no unit is left', () => {
  const result = estimateRemaining({
    unitsLeft: 0,
    unitSteps: [4],
    callsPerMinute: 6,
    callCount: MIN_CALLS_FOR_ESTIMATE,
    activeSeconds: MIN_ACTIVE_SECONDS_FOR_ESTIMATE,
  });
  assert.equal(result.state, 'ready');
  assert.equal(result.seconds, 0);
});

test('formatDuration writes seconds, minutes and hours in plain words', () => {
  assert.equal(formatDuration(45), '45 s');
  assert.equal(formatDuration(90), '2 min');
  assert.equal(formatDuration(3720), '1 h 2 min');
  assert.equal(formatDuration(-5), '0 s');
});
