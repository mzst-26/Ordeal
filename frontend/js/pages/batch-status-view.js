// Turns the numbers of a batch run into the plain sentences the status panel shows. The page does the drawing; this
// module only decides the words, so the wording can be tested without a browser. Why keep the words here: every line
// the user reads about the run (the state, the wait, the speed, the estimate) must agree with the numbers, and a single
// place that builds them makes that easy to check.

import { MIN_ACTIVE_SECONDS_FOR_ESTIMATE, MIN_CALLS_FOR_ESTIMATE, formatDuration } from '../engine/run-pace.js';

// The words shown for each phase of the page. A phase the page does not know is shown as Ready, so nothing is claimed.
const STATE_WORDS = {
  running: 'Running',
  paused: 'Paused',
  stopping: 'Stopping',
  stopped: 'Stopped',
  finished: 'Finished',
};

/**
 * Return the text for the panel from the run's numbers. The input is:
 *   phase: the page's phase name, such as 'running' or 'stopped'.
 *   stop: the { title, why, next } from describeStop, or null while nothing has stopped the run.
 *   counts: { done, total, calls, reused, failed, unusable } for this Start.
 *   saved: { failed, unusable } for the earlier Starts of this batch, or null when there are none to show.
 *   activeSeconds, callsPerMinute: the speed of the run from the pace tracker.
 *   estimate: the result of estimateRemaining.
 *   wait: { reason, seconds, untilMs } for a wait in progress, or null.
 *   nowMs: the time now, so a wait that has passed is not shown.
 *   advice: rows of { label, control, value, note }; a row with no note is not a suggestion and is left out.
 */
export function buildStatusView(input) {
  return {
    stateWord: STATE_WORDS[input.phase] ?? 'Ready',
    reason: input.stop ? input.stop.title : null,
    why: input.stop ? input.stop.why : null,
    next: input.stop ? input.stop.next : null,
    wait: waitText(input.wait, input.nowMs),
    elapsed: `Active time ${formatDuration(input.activeSeconds)}. Paused time is not counted.`,
    speed: speedText(input.callsPerMinute),
    eta: etaText(input.estimate),
    progress: `${input.counts.done} of ${input.counts.total} units done.`,
    failures: failuresText(input.counts, input.saved),
    advice: input.advice.filter((row) => row.note).map((row) => ({ text: row.note, control: row.control, value: row.value })),
  };
}

/**
 * Return the countdown sentence for a wait that is still going, or null when there is none. The time left is counted
 * from the moment the wait began, so the panel can show it counting down.
 */
function waitText(wait, nowMs) {
  if (!wait || wait.untilMs <= nowMs) return null;
  const left = formatDuration(Math.ceil((wait.untilMs - nowMs) / 1000));
  if (wait.reason === 'rate-limit') {
    return `Waiting ${left} because the platform is limiting requests. The call is tried again after that.`;
  }
  if (wait.reason === 'platform-pause') {
    return `Waiting ${left} while the platform rests after a limit. The call is tried again after that.`;
  }
  return `Waiting ${left} after a failed call. The call is tried again after that.`;
}

/** Return the speed sentence. Before any call has finished there is no speed to show, so the panel says it is measuring. */
function speedText(callsPerMinute) {
  if (callsPerMinute <= 0) return 'Measuring speed…';
  return `${formatRate(callsPerMinute)} calls per minute over the last ten minutes.`;
}

/** Round a speed for reading: whole numbers when it is fast, one decimal place when it is slow. */
function formatRate(callsPerMinute) {
  if (callsPerMinute >= 10) return String(Math.round(callsPerMinute));
  return String(Math.round(callsPerMinute * 10) / 10);
}

/**
 * Return the time-left sentence. Until there is enough data, it says what is missing, so the user knows the wait is for
 * data and not a fault. Once there is data, it gives the typical time and the range.
 */
function etaText(estimate) {
  if (estimate.state !== 'ready') {
    const minutes = MIN_ACTIVE_SECONDS_FOR_ESTIMATE / 60;
    return `Estimating. Needs ${MIN_CALLS_FOR_ESTIMATE} calls and ${minutes} minutes of active time.`;
  }
  return `About ${formatDuration(estimate.seconds)} left (between ${formatDuration(estimate.lowSeconds)} and `
    + `${formatDuration(estimate.highSeconds)}).`;
}

/**
 * Return the failure sentence for this Start, and the earlier Starts of the run when there are any. The unusable replies
 * are named because they point at the reply size, not at the platform.
 */
function failuresText(counts, saved) {
  if (counts.failed === 0 && (saved === null || saved.failed === 0)) return 'No failed calls.';
  const thisStart = `${counts.failed} failed in this Start, ${counts.unusable} of them unusable.`;
  if (saved === null || saved.failed === 0) return thisStart;
  return `${thisStart} ${saved.failed} failed in earlier Starts of this batch.`;
}
