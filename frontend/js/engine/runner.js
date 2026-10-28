// Runs many units (one model, one question, one repeat each) in the browser. It reuses saved replies,
// limits how many calls are in flight, and can be paused, resumed and stopped. This is the browser port
// of run_all in runner.py. It never reads the API key: the client holds it, and no event carries it.
import { BudgetExhausted, KeyRefused, RateLimited } from "./api.js";
import { runFlows } from "./flows.js";
import { cacheKey, makeUnits } from "./planner.js";
import { BASELINE_STEP, formatQuestion, systemPromptFor } from "./rules.js";

const MAX_CONCURRENCY = 300;
// The log used when the caller gives none: it keeps nothing.
const NO_LOG = { record() {} };

/** Return the concurrency if it is a whole number from 1 to 300. Otherwise throw a clear Error. */
function checkConcurrency(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
    throw new Error(`Concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}. Got ${value}.`);
  }
  return value;
}

/** Return the opening messages: the system prompt when there is one, then the question. */
function openingMessages(question, systemPrompt) {
  const messages = [];
  if (systemPrompt !== null) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: formatQuestion(question) });
  return messages;
}

/** Return the text of the last user message, or an empty string when there is none. */
function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      return messages[index].content;
    }
  }
  return "";
}

/** Return the fields that name a unit, ready to spread into an event. */
function unitFields(unit) {
  return { model: unit.model, questionId: unit.question.id, repeat: unit.repeat };
}

/** Return the message of an error. A value that is not an Error is turned into text. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Return { runUnit(unit) }. runUnit gets or sends every reply of one unit, then runs its flows.
 * 'shared' holds the state of the whole batch: the stop flag, the abort signal, the counts and emit.
 * pairFor is optional. A mixed run gives each question its own { ladder, probeSpec } (see planner.js).
 */
export function makeReplyRunner({ client, cache, condition, config, families, ladder, probeSpec, pairFor = null, shared }) {
  const systemPrompt = systemPromptFor(condition, config);

  /** Return the ladder and probe spec for one unit: its question's own pair in a mixed run, else the batch's pair. */
  function pairOf(unit) {
    return pairFor ? pairFor(unit.question) : { ladder, probeSpec };
  }

  /** Save a new reply in the cache, count it, and emit step-done. Return the reply. */
  function saveReply(unit, step, messages, key, reply) {
    const record = {
      condition,
      model: unit.model,
      question_id: unit.question.id,
      repeat: unit.repeat,
      step,
      reply,
      user_text: lastUserText(messages),
      messages,
    };
    cache.set(key, record);
    shared.counts.calls += 1;
    shared.emit({ kind: "step-done", ...unitFields(unit), step, reply, reused: false });
    return reply;
  }

  /** Return the saved reply for a step, count it as reused, and emit step-done. */
  function reuseReply(unit, step, saved) {
    shared.counts.reused += 1;
    shared.emit({ kind: "step-done", ...unitFields(unit), step, reply: saved.reply, reused: true });
    return saved.reply;
  }

  /** Send one request unless a stop was requested first. Return null when it was stopped. */
  function sendRequest(unit, messages) {
    if (shared.stopRequested) {
      shared.log.record("step-skipped", { ...unitFields(unit), reason: "stop" });
      return null;
    }
    return client.complete({
      model: unit.model,
      messages,
      temperature: config.temperature,
      maxTokens: config.max_tokens,
      signal: shared.controller.signal,
    });
  }

  /**
   * Handle a failed request. A spent budget, a refused key or a long rate-limit pause stops the batch. A stop is not a
   * failure. Always returns null.
   */
  function handleCallError(unit, step, error) {
    if (error instanceof BudgetExhausted) {
      shared.reportBudgetExhausted();
    } else if (error instanceof KeyRefused) {
      shared.reportKeyRefused(error);
    } else if (error instanceof RateLimited) {
      shared.reportRateLimited(error);
    } else if (!shared.stopRequested) {
      shared.counts.failed += 1;
      shared.emit({ kind: "step-failed", ...unitFields(unit), step, message: errorMessage(error) });
    }
    return null;
  }

  /** Call the model for one step and save the reply. Return null if the call failed or was stopped. */
  async function callModel(unit, step, messages, key) {
    shared.emit({ kind: "step-start", ...unitFields(unit), step });
    let reply;
    try {
      reply = await sendRequest(unit, messages);
    } catch (error) {
      return handleCallError(unit, step, error);
    }
    // A stop can come while the request is in flight, so a reply that arrives after it is not saved.
    if (shared.stopRequested) {
      return null;
    }
    return saveReply(unit, step, messages, key, reply);
  }

  /** Return the reply for one step: the saved one when there is one, otherwise a new call. Null means stop. */
  async function getReply(unit, step, messages) {
    if (shared.stopRequested) {
      return null;
    }
    const key = cacheKey(condition, unit.model, unit.question.id, unit.repeat, step);
    const saved = cache.get(key);
    if (saved !== undefined) {
      return reuseReply(unit, step, saved);
    }
    await shared.waitWhilePaused();
    if (shared.stopRequested) {
      return null;
    }
    return callModel(unit, step, messages, key);
  }

  /**
   * Run one unit: its baseline reply first, then the flows that the families ask for.
   * Return true only when every step was answered. Return false when a stop or a failed call cut it short.
   */
  async function runUnit(unit) {
    let cutShort = false;
    const ask = async (step, messages) => {
      const reply = await getReply(unit, step, messages);
      if (reply === null) {
        cutShort = true;
      }
      return reply;
    };
    const baseline = await ask(BASELINE_STEP, openingMessages(unit.question, systemPrompt));
    if (baseline !== null) {
      const pair = pairOf(unit);
      await runFlows(unit.question, systemPrompt, baseline, ask, families, pair.ladder, pair.probeSpec, config);
    }
    return !cutShort;
  }

  return { runUnit };
}

/**
 * Create a batch runner for every unit of the models, questions and repeats given.
 * start() runs the batch and resolves when it ends. concurrency must be a whole number from 1 to 300,
 * and defaults to config.concurrency. onEvent(event) gets one plain object per event, in order.
 * Other options are as in runner.py. pairFor is the optional per-question pair of a mixed run.
 */
export function createBatchRunner({
  client, models, questions, repeats, condition, families, ladder, probeSpec, config, cache,
  concurrency, onEvent = () => {}, log = NO_LOG, pairFor = null,
}) {
  const limit = checkConcurrency(concurrency ?? config.concurrency);
  const pending = makeUnits(models, questions, repeats);
  const total = pending.length;
  // The phase is "idle", "running", "stopped" or "finished". status() adds "paused" and "stopping".
  let phase = "idle";
  let paused = false;
  let startPromise = null;
  const pauseWaiters = [];

  /** Release every caller that waits for resume() or for a stop. */
  function releasePauseWaiters() {
    const waiting = pauseWaiters.splice(0);
    for (const resolve of waiting) {
      resolve();
    }
  }

  /** Wait while the batch is paused. A stop also ends the wait. */
  async function waitWhilePaused() {
    while (paused && !shared.stopRequested) {
      await new Promise((resolve) => pauseWaiters.push(resolve));
    }
  }

  /** Stop the batch: no new work starts, and calls in flight are aborted. The reason is logged. */
  function requestStop(reason = "user") {
    log.record("stop-requested", { reason });
    shared.stopRequested = true;
    shared.controller.abort();
    releasePauseWaiters();
  }

  /** Emit a notice that ends the batch, then stop it. Only the first notice is sent. */
  function endWithNotice(event) {
    if (shared.noticeSent) {
      return;
    }
    shared.noticeSent = true;
    shared.emit(event);
    requestStop(event.kind);
  }

  /** Emit budget-exhausted once, then stop the batch. */
  function reportBudgetExhausted() {
    endWithNotice({ kind: "budget-exhausted" });
  }

  /** Emit key-refused once, then stop the batch so that no further call is sent. */
  function reportKeyRefused(error) {
    endWithNotice({ kind: "key-refused", message: errorMessage(error) });
  }

  /** Emit rate-limited once, then stop the batch. A long pause is not waited out, so the run can be resumed later. */
  function reportRateLimited(error) {
    endWithNotice({ kind: "rate-limited", message: errorMessage(error) });
  }

  const shared = {
    log,
    stopRequested: false,
    noticeSent: false,
    controller: new AbortController(),
    counts: { done: 0, calls: 0, reused: 0, failed: 0 },
    emit: (event) => {
      log.record(event.kind, event);
      onEvent(event);
    },
    waitWhilePaused,
    requestStop,
    reportBudgetExhausted,
    reportKeyRefused,
    reportRateLimited,
  };

  const replyRunner = makeReplyRunner({
    client, cache, condition, config, families, ladder, probeSpec, pairFor, shared,
  });

  /** Return the next unit to run. Waits while paused. Returns null when none is left or a stop was requested. */
  async function takeUnit() {
    await waitWhilePaused();
    if (shared.stopRequested) {
      return null;
    }
    return pending.shift() ?? null;
  }

  /** Emit a progress event with the current counts. */
  function emitProgress() {
    const { done, calls, reused, failed } = shared.counts;
    shared.emit({ kind: "progress", done, total, calls, reused, failed });
  }

  /** Count a unit that threw, and emit unit-failed with its message. The other units keep running. */
  function reportUnitFailed(unit, error) {
    shared.counts.failed += 1;
    shared.emit({ kind: "unit-failed", ...unitFields(unit), message: errorMessage(error) });
    emitProgress();
  }

  /** Run one unit with its start event. Only a unit that finished normally is counted as done. */
  async function runOneUnit(unit) {
    shared.emit({ kind: "unit-start", ...unitFields(unit) });
    let finished;
    try {
      finished = await replyRunner.runUnit(unit);
    } catch (error) {
      reportUnitFailed(unit, error);
      return;
    }
    if (finished) {
      shared.counts.done += 1;
      shared.emit({ kind: "unit-done", ...unitFields(unit) });
      emitProgress();
    }
  }

  /** Take units one at a time, until none are left or a stop is requested. */
  async function workLoop() {
    let unit = await takeUnit();
    while (unit !== null) {
      await runOneUnit(unit);
      unit = await takeUnit();
    }
  }

  /** Emit the end event: stopped when a stop was requested, otherwise finished. */
  function emitEndEvent() {
    if (shared.stopRequested) {
      phase = "stopped";
      shared.emit({ kind: "stopped" });
      return;
    }
    phase = "finished";
    const { calls, reused, failed } = shared.counts;
    shared.emit({ kind: "finished", calls, reused, failed });
  }

  /** Run the batch with one work loop per concurrency slot. The end event is sent once, even on error. */
  async function runBatch() {
    phase = "running";
    log.record("batch-started", { units: total, slots: limit, models: models.length, repeats });
    const loops = [];
    for (let slot = 0; slot < limit; slot += 1) {
      loops.push(workLoop());
    }
    try {
      await Promise.all(loops);
    } finally {
      emitEndEvent();
    }
  }

  /** Return the state name for status(). A stop requested while running shows as stopping. */
  function currentState() {
    if (phase === "running" && shared.stopRequested) {
      return "stopping";
    }
    if (paused && (phase === "idle" || phase === "running")) {
      return "paused";
    }
    return phase;
  }

  return {
    /** Start the batch once. Later calls return the same promise. */
    start() {
      if (startPromise === null) {
        startPromise = runBatch();
      }
      return startPromise;
    },
    /** Pause before the next unit or call. Work already in flight is not stopped. */
    pause() {
      paused = true;
      log.record("paused");
    },
    /** Let paused work continue. */
    resume() {
      paused = false;
      log.record("resumed");
      releasePauseWaiters();
    },
    /** Stop the batch. Nothing happens once it has already ended. */
    stop() {
      if (phase === "stopped" || phase === "finished") {
        return;
      }
      requestStop("user");
    },
    /** Return true while the batch is paused. */
    isPaused() {
      return paused;
    },
    /** Return the counts and the state name. */
    status() {
      const { done, calls, reused, failed } = shared.counts;
      return { done, total, calls, reused, failed, state: currentState() };
    },
  };
}
