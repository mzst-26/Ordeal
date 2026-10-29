// Measures how fast a batch run is going and estimates how long it has left. It counts only active time: the time the
// run spends paused or waiting for the platform is left out, so the speed and the estimate describe the calls that
// are actually made. Why a window: the speed of the last ten minutes says more about the run now than the speed of
// the whole run, which includes the slow start and any long pauses.

// The speed is measured over this many seconds of active time, or less while the run is young.
export const PACE_WINDOW_SECONDS = 600;
// No estimate is shown until this many calls have been made. Fewer calls give a guess, not a measurement.
export const MIN_CALLS_FOR_ESTIMATE = 20;
// No estimate is shown until this many seconds of active time have passed, for the same reason.
export const MIN_ACTIVE_SECONDS_FOR_ESTIMATE = 120;

/**
 * Create a tracker for one run. It keeps the times of the finished calls on an active clock, which only moves while
 * the run is started. The clock is passed in, so tests can move time on by hand.
 */
export function createPaceTracker({ now = Date.now } = {}) {
  // Active time that has already passed, in milliseconds, before the current running stretch.
  let banked = 0;
  // The real time the current running stretch began, or null while paused.
  let runningSince = null;
  // The active time of each finished call, in milliseconds, in the order the calls finished.
  const callTimes = [];

  /** Return the active time so far, in milliseconds. */
  function activeMs() {
    return banked + (runningSince === null ? 0 : now() - runningSince);
  }

  return {
    /** Start the active clock. Starting a clock that is already running changes nothing. */
    start() {
      if (runningSince === null) runningSince = now();
    },
    /** Stop the active clock, keeping the time it has run. Pausing a stopped clock changes nothing. */
    pause() {
      if (runningSince === null) return;
      banked += now() - runningSince;
      runningSince = null;
    },
    /** Record that one call has finished at the current active time. */
    noteCall() {
      callTimes.push(activeMs());
    },
    /** Return the number of calls recorded so far. */
    callCount() {
      return callTimes.length;
    },
    /** Return the active time so far, in whole seconds. */
    activeSeconds() {
      return Math.floor(activeMs() / 1000);
    },
    /**
     * Return the calls per active minute over the last PACE_WINDOW_SECONDS. Before the window is full, the time since
     * the start is used instead, so a fast first minute is not hidden. Returns 0 when there is no active time yet.
     */
    callsPerMinute() {
      const nowActive = activeMs();
      if (nowActive <= 0) return 0;
      const windowMs = Math.min(PACE_WINDOW_SECONDS * 1000, nowActive);
      const windowStart = nowActive - windowMs;
      const inWindow = callTimes.filter((time) => time > windowStart).length;
      return inWindow / (windowMs / 60000);
    },
  };
}

/**
 * Estimate the seconds left for the units that have not finished. Each unit may take a different number of calls, so
 * the estimate uses the calls the finished units took: the average gives the typical time, and the smallest and
 * largest give the range. Returns { state: 'estimating' } until there is enough data to say anything honest.
 *
 * unitSteps is the number of fresh calls each finished unit made (replies reused from earlier Starts are not counted,
 * since they took no time). callsPerMinute comes from the tracker above.
 */
export function estimateRemaining({ unitsLeft, unitSteps, callsPerMinute, callCount, activeSeconds }) {
  const enoughCalls = callCount >= MIN_CALLS_FOR_ESTIMATE;
  const enoughTime = activeSeconds >= MIN_ACTIVE_SECONDS_FOR_ESTIMATE;
  if (!enoughCalls || !enoughTime || unitSteps.length === 0 || callsPerMinute <= 0) {
    return { state: 'estimating' };
  }
  const average = unitSteps.reduce((sum, steps) => sum + steps, 0) / unitSteps.length;
  const fewest = Math.min(...unitSteps);
  const most = Math.max(...unitSteps);
  return {
    state: 'ready',
    seconds: secondsFor(unitsLeft * average, callsPerMinute),
    lowSeconds: secondsFor(unitsLeft * fewest, callsPerMinute),
    highSeconds: secondsFor(unitsLeft * most, callsPerMinute),
  };
}

/** Return the seconds needed for a number of calls at a speed in calls per minute, rounded to whole seconds. */
function secondsFor(calls, callsPerMinute) {
  return Math.round((calls / callsPerMinute) * 60);
}

/**
 * Write a number of seconds in plain words for the status panel: "45 s", "2 min", or "1 h 2 min". Negative numbers
 * are written as 0 s, since a time left cannot be below zero.
 */
export function formatDuration(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} s`;
  const minutes = Math.round(whole / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
