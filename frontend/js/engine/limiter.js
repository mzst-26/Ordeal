// Limits how many calls are in flight to one model at a time. Each model has its own queue, so a busy model
// never holds back another model, and no model gets more calls at once than its provider allows.

/**
 * Create a limiter that lets at most 'limit' tasks run for the same model. 'limit' is a number, or a function that
 * returns the number. run(model, task) waits for a free place, runs task() and frees the place when it settles, even
 * if it failed. A function is read again each time a place is taken or freed, so a limit that drops applies at once.
 */
export function createModelLimiter(limit) {
  const currentLimit = typeof limit === 'function' ? limit : () => limit;
  const states = new Map();

  /** Return the state for one model, made the first time the model is seen. */
  function stateFor(model) {
    if (!states.has(model)) states.set(model, { running: 0, waiting: [] });
    return states.get(model);
  }

  /** Take a place. When there is no room under the limit, or someone is already waiting, queue behind them. */
  async function acquire(state) {
    if (state.waiting.length === 0 && state.running < currentLimit()) {
      state.running += 1;
      return;
    }
    // wakeWaiters counts the place for this caller before it resolves, so nothing is added here.
    await new Promise((resolve) => state.waiting.push(resolve));
  }

  /**
   * Hand free places to the oldest waiters, while there is room under the current limit. The count goes up when a
   * place is handed over, so a waiter that wakes up already holds its place.
   */
  function wakeWaiters(state) {
    while (state.waiting.length > 0 && state.running < currentLimit()) {
      state.running += 1;
      state.waiting.shift()();
    }
  }

  /** Free one place, then let waiters in. A place is not reused while the count is above the limit. */
  function release(state) {
    state.running -= 1;
    wakeWaiters(state);
  }

  return {
    /** Run task() once a place is free for this model, and return what it returns or throw what it throws. */
    async run(model, task) {
      const state = stateFor(model);
      await acquire(state);
      try {
        return await task();
      } finally {
        release(state);
      }
    },
  };
}
