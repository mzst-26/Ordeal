// Tests for the run pace module (frontend/js/engine/run-pace.js). It reads no clock of its own: each test passes a fake
// clock, so the speeds and the estimates can be checked exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_ACTIVE_SECONDS_FOR_ESTIMATE,
  PACE_WINDOW_SECONDS,
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

test('a new tracker has made no calls, finished no unit, and has no active time', () => {
  const tracker = createPaceTracker({ now: fakeClock().now });
  assert.equal(tracker.callCount(), 0);
  assert.equal(tracker.activeSeconds(), 0);
  assert.equal(tracker.callsPerMinute(), 0);
  assert.equal(tracker.unitsInWindow(), 0);
  assert.equal(tracker.secondsSinceLastUnit(), null);
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

test('units finished are counted in the window, and the time since the last one is kept', () => {
  const clock = fakeClock();
  const tracker = createPaceTracker({ now: clock.now });
  tracker.start();
  clock.advanceSeconds(60);
  tracker.noteUnit();
  clock.advanceSeconds(30);
  tracker.noteUnit();
  clock.advanceSeconds(90);
  assert.equal(tracker.unitsInWindow(), 2);
  assert.equal(tracker.secondsSinceLastUnit(), 90);
});

test('units per minute counts the units in the window per active minute', () => {
  const clock = fakeClock();
  const tracker = createPaceTracker({ now: clock.now });
  tracker.start();
  clock.advanceSeconds(120);
  tracker.noteUnit();
  tracker.noteUnit();
  // Two units in two active minutes: one unit a minute.
  assert.equal(tracker.unitsPerMinute(), 1);
});

test('a unit finished long ago is not in the window, but still counts as the last unit', () => {
  const clock = fakeClock();
  const tracker = createPaceTracker({ now: clock.now });
  tracker.start();
  tracker.noteUnit();
  clock.advanceSeconds(PACE_WINDOW_SECONDS + 60);
  assert.equal(tracker.unitsInWindow(), 0);
  assert.equal(tracker.secondsSinceLastUnit(), PACE_WINDOW_SECONDS + 60);
});

test('estimateRemaining says it is estimating until there is enough active time', () => {
  const result = estimateRemaining({
    unitsLeft: 100,
    unitsFinished: 3,
    unitsPerMinute: 2,
    activeSeconds: MIN_ACTIVE_SECONDS_FOR_ESTIMATE - 1,
    secondsSinceLastUnit: 10,
  });
  assert.equal(result.state, 'estimating');
});

test('estimateRemaining says it is estimating early in a run, before any unit has finished', () => {
  const result = estimateRemaining({
    unitsLeft: 100,
    unitsFinished: 0,
    unitsPerMinute: 0,
    activeSeconds: MIN_ACTIVE_SECONDS_FOR_ESTIMATE,
    secondsSinceLastUnit: null,
  });
  assert.equal(result.state, 'estimating');
});

test('estimateRemaining gives the time left at the pace of the window', () => {
  // 40 units left at 4 units a minute: ten minutes, which is 600 seconds.
  const result = estimateRemaining({
    unitsLeft: 40,
    unitsFinished: 12,
    unitsPerMinute: 4,
    activeSeconds: 900,
    secondsSinceLastUnit: 30,
  });
  assert.equal(result.state, 'ready');
  assert.equal(result.seconds, 600);
});

test('estimateRemaining reports a stall when no unit has finished for the whole window', () => {
  // Calls are being made, but the last unit finished 12 active minutes ago: there is no honest estimate.
  const result = estimateRemaining({
    unitsLeft: 100,
    unitsFinished: 30,
    unitsPerMinute: 0,
    activeSeconds: 3000,
    secondsSinceLastUnit: 12 * 60,
  });
  assert.equal(result.state, 'stalled');
  assert.equal(result.minutes, 12);
});

test('estimateRemaining reports a stall when no unit has finished after a whole window of active time', () => {
  const result = estimateRemaining({
    unitsLeft: 135,
    unitsFinished: 0,
    unitsPerMinute: 0,
    activeSeconds: PACE_WINDOW_SECONDS,
    secondsSinceLastUnit: null,
  });
  assert.equal(result.state, 'stalled');
  assert.equal(result.minutes, 10);
});

test('estimateRemaining says there is nothing left when no unit is left', () => {
  const result = estimateRemaining({
    unitsLeft: 0,
    unitsFinished: 135,
    unitsPerMinute: 0,
    activeSeconds: 3000,
    secondsSinceLastUnit: 5,
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
