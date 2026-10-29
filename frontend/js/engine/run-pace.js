// Measures how fast a batch run is going and estimates how long it has left. It counts only active time: the time the
// run spends paused or waiting for the platform is left out, so the speed and the estimate describe the calls that
// are actually made. Why a window: the speed of the last ten minutes says more about the run now than the speed of
// the whole run, which includes the slow start and any long pauses.

// The speed is measured over this many seconds of active time, or less while the run is young.
export const PACE_WINDOW_SECONDS = 600;
// No estimate is shown until this many seconds of active time have passed. Less time gives a guess, not a measurement.
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
  // The active time of each finished unit, in milliseconds. A unit is what the user counts, so its pace is what matters.
  const unitTimes = [];

  /** Return the active time so far, in milliseconds. */
  function activeMs() {
    return banked + (runningSince === null ? 0 : now() - runningSince);
  }

  /** Return how many of the given active times fall inside the window that ends now. */
  function countInWindow(times) {
    const nowActive = activeMs();
    const windowStart = nowActive - Math.min(PACE_WINDOW_SECONDS * 1000, nowActive);
    return times.filter((time) => time > windowStart).length;
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
    /** Record that one unit has finished at the current active time. */
    noteUnit() {
      unitTimes.push(activeMs());
    },
    /** Return how many units finished in the last PACE_WINDOW_SECONDS of active time. */
    unitsInWindow() {
      return countInWindow(unitTimes);
    },
    /** Return the units finished per active minute over the last window. Returns 0 before any active time. */
    unitsPerMinute() {
      const nowActive = activeMs();
      if (nowActive <= 0) return 0;
      const windowMs = Math.min(PACE_WINDOW_SECONDS * 1000, nowActive);
      return countInWindow(unitTimes) / (windowMs / 60000);
    },
    /** Return the active seconds since the last unit finished, or null when no unit has finished yet. */
    secondsSinceLastUnit() {
      if (unitTimes.length === 0) return null;
      return Math.floor((activeMs() - unitTimes[unitTimes.length - 1]) / 1000);
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
      return countInWindow(callTimes) / (windowMs / 60000);
    },
  };
}

/**
 * Estimate the time left for the units that have not finished, at the pace of the last window. The estimate needs
 * active time and at least one unit finished. When no unit has finished for a whole window, it says so as a stall,
 * instead of giving a time that the stalled run cannot keep.
 *
 * The result is one of:
 *   { state: 'estimating' }        not enough active time, or no unit has finished yet
 *   { state: 'stalled', minutes }  no unit has finished for a whole window of active time
 *   { state: 'ready', seconds }    the time left at the current pace
 */
export function estimateRemaining({ unitsLeft, unitsFinished, unitsPerMinute, activeSeconds, secondsSinceLastUnit }) {
  if (unitsLeft <= 0) return { state: 'ready', seconds: 0 };
  if (activeSeconds < MIN_ACTIVE_SECONDS_FOR_ESTIMATE) return { state: 'estimating' };
  if (unitsFinished === 0) {
    if (activeSeconds < PACE_WINDOW_SECONDS) return { state: 'estimating' };
    return { state: 'stalled', minutes: Math.round(activeSeconds / 60) };
  }
  if (secondsSinceLastUnit !== null && secondsSinceLastUnit >= PACE_WINDOW_SECONDS) {
    return { state: 'stalled', minutes: Math.round(secondsSinceLastUnit / 60) };
  }
  if (unitsPerMinute <= 0) return { state: 'stalled', minutes: Math.round(activeSeconds / 60) };
  return { state: 'ready', seconds: Math.round((unitsLeft / unitsPerMinute) * 60) };
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
