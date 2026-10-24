// Tweens arrays of numbers with requestAnimationFrame. Reduced motion jumps straight to the end.

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** True when the user has asked the system to reduce motion. */
function prefersReducedMotion() {
  if (typeof globalThis.matchMedia !== "function") {
    return false;
  }
  return globalThis.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** Ease-out curve: quick at the start, gentle at the end. */
function easeOut(progress) {
  return 1 - (1 - progress) ** 3;
}

/**
 * Moves each number part of the way from fromArray to toArray. A missing or NaN start uses the end value,
 * and a NaN end stays NaN (a gap).
 */
function blend(fromArray, toArray, amount) {
  return toArray.map((target, index) => {
    const start = Number.isFinite(fromArray[index]) ? fromArray[index] : target;
    return start + (target - start) * amount;
  });
}

/**
 * Animates numbers from fromArray to toArray over durationMs. onFrame gets each set of numbers and
 * onDone runs at the end. Reduced motion, or a zero duration, jumps to the end at once.
 * Returns a cancel function that stops the animation without calling onDone.
 */
export function tweenNumbers(fromArray, toArray, durationMs, onFrame, onDone) {
  if (prefersReducedMotion() || !(durationMs > 0)) {
    onFrame(toArray.slice());
    if (onDone) {
      onDone();
    }
    return () => {};
  }

  let frameId = 0;
  let startTime = null;
  let cancelled = false;

  /** One animation frame: works out how far through the animation the time has got. */
  function step(timestamp) {
    if (cancelled) {
      return;
    }
    if (startTime === null) {
      startTime = timestamp;
    }
    const progress = Math.min(1, (timestamp - startTime) / durationMs);
    if (progress < 1) {
      onFrame(blend(fromArray, toArray, easeOut(progress)));
      frameId = requestAnimationFrame(step);
    } else {
      onFrame(toArray.slice());
      if (onDone) {
        onDone();
      }
    }
  }

  frameId = requestAnimationFrame(step);
  return function cancel() {
    cancelled = true;
    cancelAnimationFrame(frameId);
  };
}
