// Tests for the saved replies a Start reuses (frontend/js/runs/reply-reuse.js). Every reply already paid for in a saved
// batch run must be available to the next Start, and an unusable reply must never be reused as if it were an answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savedRepliesForStart } from '../../frontend/js/runs/reply-reuse.js';
import { addRecordsToCache } from '../../frontend/js/runs/saved-runs.js';
import { cacheKey } from '../../frontend/js/engine/planner.js';

/** Return one saved step record, shaped the way a batch unit stores it. */
function step(model, questionId, stepName, reply, condition = 'none') {
  return { condition, model, question_id: questionId, repeat: 1, step: stepName, reply, user_text: 'Q', messages: [] };
}

/** Return a saved batch run, newest first in the list, with one unit holding the given steps. */
function batchRun(id, steps, kind = 'batch') {
  return {
    id,
    status: 'stopped',
    config: { kind },
    plannedUnits: ['x'],
    results: { '["m","q1",1]': { steps } },
  };
}

test('every usable reply in every saved batch run is available to a Start', () => {
  const runs = [
    batchRun('new', [step('m', 'q1', 'level_0', 'Answer: A')]),
    batchRun('old', [step('m', 'q2', 'level_0', 'Answer: B')]),
  ];
  const records = savedRepliesForStart(runs);
  assert.deepEqual(records.map((record) => record.reply).sort(), ['Answer: A', 'Answer: B']);
});

test('an empty or control-token-only reply is left out, so it is never reused as an answer', () => {
  const runs = [batchRun('r', [
    step('m', 'q1', 'level_0', ''),
    step('m', 'q1', 'level_1', '<|start|>assistant<|channel|>'),
    step('m', 'q1', 'level_2', 'Answer: C'),
  ])];
  assert.deepEqual(savedRepliesForStart(runs).map((record) => record.reply), ['Answer: C']);
});

test('gauntlet runs are not batch replies and are left out', () => {
  const runs = [batchRun('g', [step('m', 'q1', 'level_0', 'Answer: A')], 'gauntlet')];
  assert.deepEqual(savedRepliesForStart(runs), []);
});

test('when two saved runs hold the same step, the newer run\'s reply is the one kept', () => {
  // listRuns gives the newest run first, so the newer reply is the one added last and wins in the cache.
  const runs = [
    batchRun('newer', [step('m', 'q1', 'level_0', 'Answer: NEW')]),
    batchRun('older', [step('m', 'q1', 'level_0', 'Answer: OLD')]),
  ];
  const cache = addRecordsToCache(new Map(), savedRepliesForStart(runs));
  assert.equal(cache.get(cacheKey('none', 'm', 'q1', 1, 'level_0')).reply, 'Answer: NEW');
});

test('a Start with a different reply size still finds the replies already paid for', () => {
  // The reply size is part of which run is carried on, but not of which replies are reusable: a saved reply is an answer
  // whatever limit it was made with, so changing the size must not make the saved calls be paid again.
  const runs = [batchRun('paid', [step('m', 'q1', 'level_0', 'Answer: A')])];
  const cache = addRecordsToCache(new Map(), savedRepliesForStart(runs));
  assert.equal(cache.size, 1);
});
