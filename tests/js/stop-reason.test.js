// Tests for the stop reason module (frontend/js/engine/stop-reason.js). It turns the reason a run stopped into three
// plain sentences: what happened, why, and what to do next. It reads no clock; the caller passes the times it needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeStop, stopSentence } from '../../frontend/js/engine/stop-reason.js';

test('a stop by the user says so and says that saved replies are reused', () => {
  const reason = describeStop({ kind: 'user-stop' });
  assert.equal(reason.title, 'Stopped by you');
  assert.match(reason.next, /saved replies are reused/i);
});

test('a reached call cap says how many calls were used and what to raise', () => {
  const reason = describeStop({ kind: 'budget-exhausted', calls: 350, cap: 350 });
  assert.equal(reason.title, 'The call cap was reached');
  assert.match(reason.why, /350 of 350 calls/);
  assert.match(reason.next, /cap/);
});

test('a refused key tells the user to check the key', () => {
  const reason = describeStop({ kind: 'key-refused' });
  assert.match(reason.next, /Check the key/);
});

test('a long pause gives how long it asked for and says when to start again', () => {
  // The provider asked for 7200 seconds from now; that is 2 h.
  const reason = describeStop({ kind: 'rate-limited', waitSeconds: 7200 });
  assert.equal(reason.title, 'The provider asked for a long pause');
  assert.match(reason.why, /2 h 0 min/);
  assert.match(reason.next, /after that time/);
});

test('a long pause with no known time still tells the user what to do', () => {
  const reason = describeStop({ kind: 'rate-limited', waitSeconds: null });
  assert.match(reason.why, /did not say how long/);
  assert.match(reason.next, /Start again later/);
});

test('a finished run with failed calls offers a retry and does not say it is complete', () => {
  const reason = describeStop({ kind: 'finished', failed: 3 });
  assert.equal(reason.title, 'Finished, with failed calls');
  assert.match(reason.why, /3 calls failed/);
  assert.match(reason.next, /Start/);
});

test('a finished run with no failed calls says every unit has a reply', () => {
  const reason = describeStop({ kind: 'finished', failed: 0 });
  assert.equal(reason.title, 'Finished');
  assert.match(reason.why, /Every unit has a reply/);
});

test('an unknown stop kind is said plainly rather than guessed at', () => {
  const reason = describeStop({ kind: 'something-new' });
  assert.equal(reason.title, 'Stopped');
  assert.match(reason.why, /does not know/);
});

test('a stop reads as one line: title, reason and next step, in that order', () => {
  const line = stopSentence({ title: 'Stopped by you', why: 'You pressed Stop.', next: 'Press Start.' });
  assert.equal(line, 'Stopped by you. You pressed Stop. Press Start.');
});
