// Paces the calls to one platform (for example OpenRouter), using only what the platform's own replies tell us.
// A platform can limit all of its models together, and that limit is not written in our files. So the pacer starts
// at a ceiling. Each 429 halves the calls allowed in flight and parks the whole platform for the time the 429 asks
// for. After a run of successful calls it allows one more call in flight again.
// Why parking the whole platform: once one call is refused, the other calls to that platform are refused too.
// Waiting on the platform, not on each model, stops them all from retrying at the same moment.

// With no Retry-After header, the first wait after a 429 is this many seconds. Each 429 in a row doubles it.
export const RATE_LIMIT_FLOOR_SECONDS = 5;
// The longest back-off used when the platform sends no Retry-After. A longer wait is capped here.
const MAX_BACKOFF_SECONDS = 60;
// A Retry-After longer than this is not a short burst. It is more likely a daily cap, so the batch stops instead.
export const LONG_WAIT_SECONDS = 300;
// A wait after a 429 is made longer by up to this share, so calls refused together do not all retry together.
const JITTER_SHARE = 0.25;
// Successful calls in a row needed before one more call in flight is allowed.
export const SUCCESSES_TO_RAISE = 10;
// Calls in flight to a platform when the page does not give another number. It matches the batch page's default.
export const DEFAULT_PLATFORM_LIMIT = 8;

/**
 * Return the seconds to wait after a 429. The platform's Retry-After is used when it sent one, otherwise a back-off
 * that doubles with each 429 in a row. A random extra of up to JITTER_SHARE is added, from the given random function.
 */
export function rateLimitSeconds(retryAfter, attempt, random = Math.random) {
  const base = retryAfter ?? Math.min(RATE_LIMIT_FLOOR_SECONDS * 2 ** attempt, MAX_BACKOFF_SECONDS);
  return base * (1 + random() * JITTER_SHARE);
}

/** Return true when a Retry-After is too long to wait out in the batch. A missing Retry-After is never long. */
export function isLongWait(retryAfter) {
  return retryAfter !== null && retryAfter > LONG_WAIT_SECONDS;
}

/**
 * Create the pacer for one platform. It keeps the calls allowed in flight, and the time the platform is parked until.
 * The clock is passed in, so tests can move time on by hand.
 */
export function createPlatformPacer({ ceiling = DEFAULT_PLATFORM_LIMIT, now = Date.now } = {}) {
  let allowed = ceiling;
  let parkedUntil = 0;
  let successRun = 0;

  return {
    /** Return how many calls may be in flight to the platform right now. */
    limit() {
      return allowed;
    },
    /** Return the milliseconds left in the current park, or 0 when calls may go now. */
    waitMs() {
      return Math.max(0, parkedUntil - now());
    },
    /**
     * Record a 429 and park the platform for the given seconds. Calls already parked by an earlier 429 do not halve
     * the limit again, because they were refused by the same burst. Returns the seconds parked.
     */
    recordRateLimit(seconds) {
      // A 429 that arrives while the platform is still parked belongs to the burst that parked it.
      if (parkedUntil <= now()) {
        allowed = Math.max(1, Math.floor(allowed / 2));
      }
      successRun = 0;
      parkedUntil = Math.max(parkedUntil, now() + seconds * 1000);
      return seconds;
    },
    /** Record a successful call. After SUCCESSES_TO_RAISE in a row, allow one more call in flight, up to the ceiling. */
    recordSuccess() {
      successRun += 1;
      if (successRun >= SUCCESSES_TO_RAISE && allowed < ceiling) {
        allowed += 1;
        successRun = 0;
      }
    },
  };
}
