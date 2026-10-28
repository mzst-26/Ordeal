// Limits how many calls are in flight to one model at a time. Each model has its own queue, so a busy model
// never holds back another model, and no model gets more calls at once than its provider allows.

/**
 * Create a limiter that lets at most 'limit' tasks run for the same model. run(model, task) waits for a free
 * place, runs task() and frees the place when it settles, even if it failed.
 */
export function createModelLimiter(limit) {
  const states = new Map();

  /** Return the state for one model, made the first time the model is seen. */
  function stateFor(model) {
    if (!states.has(model)) states.set(model, { running: 0, waiting: [] });
    return states.get(model);
  }

  /** Take a place. When all places are taken, wait until release hands one over. */
  async function acquire(state) {
    if (state.running < limit) {
      state.running += 1;
      return;
    }
    // release() hands its place to the next waiter and does not change the count, so nothing is added here.
    await new Promise((resolve) => state.waiting.push(resolve));
  }

  /** Give the place to the next waiter, or free it when nobody is waiting. */
  function release(state) {
    const next = state.waiting.shift();
    if (next) next();
    else state.running -= 1;
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
