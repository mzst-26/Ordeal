// Logic that the Gauntlet and Batch pages share for saved runs: the unit keys, what a resume needs, the rows of the
// Saved runs list, the gauntlet conversation rebuilt from saved steps, and a queue that keeps run writes in order.
// This file does no DOM work and sends no request. Runs are read and written through run-store.js.

import { pendingUnits, listRuns, interruptedRuns } from "./store/run-store.js";
import { cacheKey } from "./engine/planner.js";
import { BASELINE_STEP, CONFESSION_STEP, setupStep } from "./engine/rules.js";
import { isPresetId } from "./presets.js";

export const KIND_BATCH = "batch";
export const KIND_GAUNTLET = "gauntlet";
const PRESSURE_STEP_PATTERN = /^level_[1-9]\d*$/;
const SETUP_STEP_PATTERN = /^setup_[1-9]\d*$/;
const DONE_STATUS = "done";
const RESUMABLE_STATUSES = ["running", "paused", "stopped", "failed"];
const STATUS_WORDS = Object.freeze({
  planned: "Not started",
  running: "Running",
  paused: "Paused",
  stopped: "Stopped",
  done: "Done",
  failed: "Some units failed",
});

/**
 * Return a queue that runs tasks one after another. Each run() returns the task's own promise, and a task that
 * fails does not stop the ones after it. Run writes go through one queue, so two saves cannot overwrite each other.
 */
export function createSerialQueue() {
  let tail = Promise.resolve();
  return {
    /** Add a task to the end of the queue and return its promise. */
    run(task) {
      const next = tail.then(task);
      tail = next.catch(() => {});
      return next;
    },
    /** Return a promise that resolves once every task queued so far has finished. */
    idle() {
      return tail;
    },
  };
}

/** Return the key of one batch unit. JSON keeps the three parts apart, whatever characters they hold. */
export function unitKeyFor(model, questionId, repeat) {
  return JSON.stringify([model, questionId, repeat]);
}

/** Return the unit keys of a batch in the order the runner makes them: model, then question, then repeat. */
export function plannedBatchUnits(models, questionIds, repeats) {
  const keys = [];
  for (const model of models) {
    for (const questionId of questionIds) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        keys.push(unitKeyFor(model, questionId, repeat));
      }
    }
  }
  return keys;
}

/** Return the steps of a gauntlet conversation in order: baseline, then each level with its setup turn first. */
export function gauntletPlannedSteps(suite) {
  const steps = [BASELINE_STEP];
  for (const entry of suite.ladder.levels) {
    if (entry.setup_turn) {
      steps.push(setupStep(entry.level));
    }
    steps.push(`level_${entry.level}`);
  }
  steps.push(CONFESSION_STEP);
  return steps;
}

/** Return the fields of a saved step record that a resume needs. The messages are left out, to keep records small. */
export function slimRecord(record) {
  return {
    condition: record.condition,
    model: record.model,
    question_id: record.question_id,
    repeat: record.repeat,
    step: record.step,
    reply: record.reply,
    user_text: record.user_text,
  };
}

/** Return the saved result of one batch unit: all of its step records, slimmed. */
export function unitPayload(records) {
  return { steps: records.map(slimRecord) };
}

/** Return the step records held by the saved batch units of a run, in the order they were saved. */
export function recordsFromRun(run) {
  return Object.values(run.results).flatMap((payload) => (Array.isArray(payload.steps) ? payload.steps : []));
}

/** Return what a batch resume needs: the units still to run, the saved units, and the saved step records. */
export function resumeState(run) {
  return {
    pendingKeys: pendingUnits(run),
    savedKeys: Object.keys(run.results),
    records: recordsFromRun(run),
  };
}

/** Put saved step records into a reply cache, under the keys the runner looks them up by. */
export function addRecordsToCache(cache, records) {
  for (const record of records) {
    const key = cacheKey(record.condition, record.model, record.question_id, record.repeat, record.step);
    cache.set(key, record);
  }
  return cache;
}

/** Return the saved result of one gauntlet step, as stored. The letter is null when the reply had none. */
export function gauntletStepPayload({ step, userText, reply, letter, flipped }) {
  return { step, user_text: userText, reply, letter, flipped };
}

/** Return true for a pressure level step such as level_3. The baseline (level_0) is not one. */
export function isPressureStep(step) {
  return PRESSURE_STEP_PATTERN.test(step);
}

/**
 * Rebuild a gauntlet conversation from its saved steps. The steps are replayed in the order they were saved,
 * which is the order of the conversation. nextLevel is the first pressure level not yet saved, or null.
 */
export function replayGauntlet(run) {
  const turns = [];
  const letters = [];
  let setupReply = null;
  for (const [step, payload] of Object.entries(run.results)) {
    turns.push({ role: "user", text: payload.user_text, flipped: false });
    turns.push({ role: "assistant", text: payload.reply, flipped: payload.flipped === true });
    if (isPressureStep(step)) {
      letters.push(payload.letter ?? null);
    }
    if (SETUP_STEP_PATTERN.test(step)) {
      setupReply = payload.reply;
    }
  }
  const nextStep = pendingUnits(run).find((step) => isPressureStep(step));
  return {
    turns,
    letters,
    setupReply,
    nextLevel: nextStep === undefined ? null : Number(nextStep.slice("level_".length)),
  };
}

/** Return true for a stored document that is a saved run (not a preset). */
export function isRunDocument(doc) {
  return doc !== null && typeof doc === "object" && typeof doc.id === "string" && !isPresetId(doc.id)
    && Array.isArray(doc.plannedUnits) && doc.results !== null && typeof doc.results === "object";
}

/** Return the words shown for a run status. */
export function statusWord(status) {
  return Object.hasOwn(STATUS_WORDS, status) ? STATUS_WORDS[status] : status;
}

/** Return true when a run can be resumed from its saved state: it was cut off, paused, stopped or had failures. */
export function canResume(run) {
  return RESUMABLE_STATUSES.includes(run.status) && run.status !== DONE_STATUS;
}

/** Return the saved runs of one kind ("batch" or "gauntlet"), as rows for the list, newest first. */
export async function savedRunRows(adapter, kind) {
  const runs = await listRuns(adapter);
  return runs
    .filter((run) => isRunDocument(run) && run.config && run.config.kind === kind)
    .map((run) => ({
      id: run.id,
      label: run.label,
      status: run.status,
      statusText: statusWord(run.status),
      saved: Object.keys(run.results).length,
      planned: run.plannedUnits.length,
      createdAt: run.createdAt,
      resumable: canResume(run),
    }));
}

/**
 * Return the runs of one kind that were still marked running when the page loaded, newest first. The run this page
 * is working on is left out. The store's interruptedRuns does the finding.
 */
export async function interruptedRunsOfKind(adapter, kind, activeRunId = null) {
  const activeIds = activeRunId === null ? [] : [activeRunId];
  const runs = await interruptedRuns(adapter, activeIds);
  return runs.filter((run) => isRunDocument(run) && run.config && run.config.kind === kind);
}
