// Says whether a batch run is in progress on this page. The batch page turns the lock on while a run is going or
// its confirmation is open, and off when it ends. The platform section reads it and refuses a platform change while
// it is on, so a run can never switch to another platform halfway through, or lose its ticked models.
// It is one flag for the whole document, because both copies of the platform section read the same page.

let locked = false;

/** Turn the lock on or off. Any value other than true turns it off, so a missing value never locks the page. */
export function setRunLocked(value) {
  locked = value === true;
}

/** Return true while a batch run or its confirmation is open. */
export function isRunLocked() {
  return locked;
}

/**
 * Say which Shuffle controls are locked. The tick box is locked while a batch is busy, so it cannot change mid-run.
 * The two set dropdowns are locked while busy too, and also while the tick box is on, because a mixed run always
 * uses both sets. Its inputs are the busy flag and the box state, and it returns two plain flags.
 */
export function shuffleControlsState({ busy, shuffleOn }) {
  return { toggleDisabled: busy === true, setsDisabled: busy === true || shuffleOn === true };
}
