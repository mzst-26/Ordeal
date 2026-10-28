// Tests for the platform pacer (frontend/js/engine/platform-pacer.js). The pacer reads no clock of its own:
// each test passes a fake clock and a fixed random number, so the waits can be checked exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PLATFORM_LIMIT,
  LONG_WAIT_SECONDS,
  SUCCESSES_TO_RAISE,
  createPlatformPacer,
  isLongWait,
  rateLimitSeconds,
} from '../../frontend/js/engine/platform-pacer.js';

// A random number of 0 adds no extra wait, so the base wait is what the test sees.
const NO_EXTRA = () => 0;

/** Return a fake clock that starts at time 0 and moves only when the test says so. */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    advanceSeconds: (seconds) => { time += seconds * 1000; },
  };
}

test('a platform with no 429 has no park and the default number of calls allowed', () => {
  const pacer = createPlatformPacer({ now: fakeClock().now });
  assert.equal(pacer.waitMs(), 0);
  assert.equal(pacer.limit(), DEFAULT_PLATFORM_LIMIT);
});

test('the first 429 with a Retry-After of 7 seconds parks the platform for 7 seconds', () => {
  const clock = fakeClock();
  const pacer = createPlatformPacer({ now: clock.now });
  pacer.recordRateLimit(7);
  assert.equal(pacer.waitMs(), 7000);
  clock.advanceSeconds(3);
  assert.equal(pacer.waitMs(), 4000);
  clock.advanceSeconds(4);
  assert.equal(pacer.waitMs(), 0);
});

test('each 429 halves the calls allowed in flight, and the count never drops below 1', () => {
  const clock = fakeClock();
  const pacer = createPlatformPacer({ ceiling: 8, now: clock.now });
  const seen = [];
  for (let index = 0; index < 4; index += 1) {
    pacer.recordRateLimit(1);
    clock.advanceSeconds(2);
    seen.push(pacer.limit());
  }
  assert.deepEqual(seen, [4, 2, 1, 1]);
});

test('several 429s in one park halve the calls allowed only once', () => {
  const clock = fakeClock();
  const pacer = createPlatformPacer({ ceiling: 8, now: clock.now });
  // Eight calls were all refused at the same moment. They are one event, not eight.
  for (let index = 0; index < 8; index += 1) {
    pacer.recordRateLimit(5);
  }
  assert.equal(pacer.limit(), 4);
});

test('ten successes in a row allow one more call in flight, up to the ceiling', () => {
  const clock = fakeClock();
  const pacer = createPlatformPacer({ ceiling: 8, now: clock.now });
  pacer.recordRateLimit(1);
  clock.advanceSeconds(2);
  assert.equal(pacer.limit(), 4);
  for (let index = 0; index < SUCCESSES_TO_RAISE; index += 1) {
    pacer.recordSuccess();
  }
  assert.equal(pacer.limit(), 5);
  for (let index = 0; index < SUCCESSES_TO_RAISE * 10; index += 1) {
    pacer.recordSuccess();
  }
  assert.equal(pacer.limit(), 8);
});

test('a 429 in the middle of a success run starts the run again from zero', () => {
  const clock = fakeClock();
  const pacer = createPlatformPacer({ ceiling: 8, now: clock.now });
  pacer.recordRateLimit(1);
  clock.advanceSeconds(2);
  for (let index = 0; index < SUCCESSES_TO_RAISE - 1; index += 1) {
    pacer.recordSuccess();
  }
  pacer.recordRateLimit(1);
  clock.advanceSeconds(2);
  pacer.recordSuccess();
  assert.equal(pacer.limit(), 2);
});

test('with no Retry-After the wait starts at 5 seconds and doubles with each 429 in a row', () => {
  assert.equal(rateLimitSeconds(null, 0, NO_EXTRA), 5);
  assert.equal(rateLimitSeconds(null, 1, NO_EXTRA), 10);
  assert.equal(rateLimitSeconds(null, 2, NO_EXTRA), 20);
  assert.equal(rateLimitSeconds(null, 9, NO_EXTRA), 60);
});

test('a Retry-After from the platform is used as the wait, not the back-off', () => {
  assert.equal(rateLimitSeconds(12, 0, NO_EXTRA), 12);
  assert.equal(rateLimitSeconds(12, 3, NO_EXTRA), 12);
});

test('the wait is longer by at most a quarter, so calls refused together do not retry together', () => {
  const almostOne = () => 0.999;
  const wait = rateLimitSeconds(8, 0, almostOne);
  assert.ok(wait > 8, 'the extra should be applied');
  assert.ok(wait <= 10, 'the extra should stay within a quarter of the wait');
});

test('a Retry-After longer than five minutes is a long wait, which stops the batch', () => {
  assert.equal(isLongWait(null), false);
  assert.equal(isLongWait(LONG_WAIT_SECONDS), false);
  assert.equal(isLongWait(LONG_WAIT_SECONDS + 1), true);
});
