// Explains, in three plain sentences, why a batch run stopped or finished: what happened, why, and what to do next.
// Why this exists: a run that stops with only "Stopped at 28 calls" leaves the user guessing whether to wait, change a
// setting or give up. Each reason here has one fixed set of words, so the same stop always reads the same way.

import { formatDuration } from './run-pace.js';

/**
 * Return { title, why, next } for the event that ended a run. The kinds are the events the runner and the batch page
 * use: 'user-stop', 'budget-exhausted', 'key-refused', 'rate-limited', and 'finished'. Any other kind is said plainly
 * as unknown, rather than guessed at.
 *
 * The fields used are calls and cap (for a reached cap), waitSeconds (for a long pause, null when the provider did not
 * say) and failed (for a finished run).
 */
export function describeStop(event) {
  switch (event.kind) {
    case 'user-stop':
      return {
        title: 'Stopped by you',
        why: 'You pressed Stop. Replies already saved are kept.',
        next: 'Press Start to carry on. Saved replies are reused and do not use the cap.',
      };
    case 'budget-exhausted':
      return {
        title: 'The call cap was reached',
        why: `${event.calls} of ${event.cap} calls were used for this Start.`,
        next: 'Raise the cap or wait, then press Start. Saved replies are reused and do not use the cap.',
      };
    case 'key-refused':
      return {
        title: 'The key was refused',
        why: 'The platform did not accept the key.',
        next: 'Check the key, then press Start again.',
      };
    case 'rate-limited':
      return rateLimitedReason(event.waitSeconds);
    case 'finished':
      return finishedReason(event.failed);
    default:
      return {
        title: 'Stopped',
        why: 'The run stopped for a reason this page does not know.',
        next: 'Press Start to carry on. Saved replies are reused.',
      };
  }
}

/**
 * Explain a long pause. The provider's own time is used when it gave one, so the user can see when to start again. When
 * it gave no time, the words say so, rather than inventing one.
 */
function rateLimitedReason(waitSeconds) {
  if (waitSeconds === null || waitSeconds === undefined) {
    return {
      title: 'The provider asked for a long pause',
      why: 'The provider asked for a pause longer than five minutes, and did not say how long.',
      next: 'Start again later. Saved replies are reused.',
    };
  }
  return {
    title: 'The provider asked for a long pause',
    why: `The provider asked for ${formatDuration(waitSeconds)}, so the run stopped rather than wait.`,
    next: 'Press Start after that time. Saved replies are reused.',
  };
}

/**
 * Explain the end of a run. A run with failed calls is not called complete, because some units have no reply yet.
 */
function finishedReason(failed) {
  if (failed > 0) {
    return {
      title: 'Finished, with failed calls',
      why: `${failed} ${failed === 1 ? 'call' : 'calls'} failed, so some units have no reply yet.`,
      next: 'Press Start to try the failed units again. Saved replies are reused.',
    };
  }
  return {
    title: 'Finished',
    why: 'Every unit has a reply.',
    next: 'Export the run to keep it.',
  };
}
