// Tests for the per-model limiter (frontend/js/engine/limiter.js): each model gets its own places, and a failed task frees its place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelLimiter } from '../../frontend/js/engine/limiter.js';

/** A task that records how many tasks of its model are running at the same time, then waits for a release. */
function gatedTask(counter, model, release) {
  return async () => {
    counter[model].running += 1;
    counter[model].peak = Math.max(counter[model].peak, counter[model].running);
    await release;
    counter[model].running -= 1;
    return model;
  };
}

test('no more tasks of one model run at once than the limit', async () => {
  const limiter = createModelLimiter(2);
  const counter = { a: { running: 0, peak: 0 } };
  const gates = [];
  const runs = [];
  for (let index = 0; index < 6; index += 1) {
    let open;
    const release = new Promise((resolve) => { open = resolve; });
    gates.push(open);
    runs.push(limiter.run('a', gatedTask(counter, 'a', release)));
  }
  // Let the first two start, then open their gates one at a time.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(counter.a.running, 2);
  for (const open of gates) {
    open();
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await Promise.all(runs);
  assert.equal(counter.a.peak, 2);
});

test('one model being busy does not hold back another model', async () => {
  const limiter = createModelLimiter(1);
  let openA;
  const blockA = new Promise((resolve) => { openA = resolve; });
  const slowA = limiter.run('a', () => blockA);
  // The other model is not blocked by model a's place, so its task finishes first.
  const quickB = await limiter.run('b', async () => 'done');
  assert.equal(quickB, 'done');
  openA();
  assert.equal(await slowA, undefined);
});

test('a task that fails frees its place for the next waiter', async () => {
  const limiter = createModelLimiter(1);
  const first = limiter.run('a', async () => { throw new Error('boom'); });
  const second = limiter.run('a', async () => 'second ran');
  await assert.rejects(first, /boom/);
  assert.equal(await second, 'second ran');
});

/** Wait a few milliseconds, so that the tasks that are due to start have started. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

test('a limit that drops is applied to the tasks still waiting', async () => {
  let limit = 2;
  const limiter = createModelLimiter(() => limit);
  const started = [];
  const gates = [];
  const taskNamed = (name) => () => new Promise((resolve) => {
    started.push(name);
    gates.push(resolve);
  });
  const runs = ['one', 'two', 'three', 'four'].map((name) => limiter.run('a', taskNamed(name)));
  await tick();
  assert.deepEqual(started, ['one', 'two']);
  // The limit drops to 1 while two tasks run. Finishing one leaves one running, so nothing new may start.
  limit = 1;
  gates[0]('done');
  await tick();
  assert.deepEqual(started, ['one', 'two']);
  // Finishing the second leaves none running, so the next waiter starts, and only one at a time.
  gates[1]('done');
  await tick();
  assert.deepEqual(started, ['one', 'two', 'three']);
  gates[2]('done');
  await tick();
  assert.deepEqual(started, ['one', 'two', 'three', 'four']);
  gates[3]('done');
  await Promise.all(runs);
});
