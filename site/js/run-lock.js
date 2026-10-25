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
