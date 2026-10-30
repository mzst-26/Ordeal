// Suggests settings for a batch run from what the run has already shown: how many calls can really run at once, how
// many calls the rest of the run needs, and whether the reply size is too small. The functions only suggest. Each one
// returns a value and a plain note, and the page decides whether to apply it. Why not change the settings directly:
// the user chose them on purpose, and a suggestion that quietly changes a cap they set would be a surprise.

// The largest call cap the batch page accepts for one Start. Matches MAX_BATCH_CALLS on the batch page.
export const MAX_CAP = 400;
// Calls are counted with this margin when a cap is worked out, so a retry does not end a run early.
export const CAP_MARGIN = 1.5;
// The caps are suggested in steps of this size, so the number reads as a round figure.
const CAP_STEP = 10;
// The reply sizes the batch page offers, smallest first. Matches the choices in index.html.
export const MAX_TOKEN_CHOICES = [2048, 4096, 8192, 16384, 32768];
// No advice about reply size until this many units have been started. A few bad units are not a pattern.
export const MIN_UNITS_FOR_ADVICE = 20;
// If more than this share of units stopped at an empty or cut-short reply, the reply size is too small. A unit has about
// twelve replies, so a small share of bad replies stops most units; the share is measured by unit for that reason.
// The limit matches health_max_unparsed_rate in ordeal/data/config.json.
export const UNUSABLE_ALERT_SHARE = 0.2;

/**
 * Suggest a concurrency. Only so many calls can run at once: the models each allow a number of calls, and the
 * platform allows a number overall. A higher setting changes nothing, so it is brought down to the usable number.
 */
export function adviseConcurrency({ concurrency, models, perModelLimit, platformLimit }) {
  const usable = Math.min(models * perModelLimit, platformLimit);
  if (concurrency <= usable) return { value: concurrency, note: null };
  return {
    value: usable,
    note: `Only ${usable} calls can run at once with ${models} model${models === 1 ? '' : 's'}, `
      + `so a setting above ${usable} changes nothing.`,
  };
}

/**
 * Suggest a call cap for the steps left. Each step may need more than one HTTP attempt, because a call can fail and
 * be tried again, so the attempts seen so far (attemptsPerStep) are used. A cap above MAX_CAP is set to MAX_CAP, and
 * the note says how many Starts the rest of the run will take.
 */
export function adviseCap({ stepsLeft, attemptsPerStep }) {
  const perStep = Number.isFinite(attemptsPerStep) && attemptsPerStep >= 1 ? attemptsPerStep : 1;
  const needed = roundUpTo(Math.ceil(stepsLeft * perStep), CAP_STEP);
  if (needed <= MAX_CAP) return { value: needed, starts: 1, note: null };
  const starts = Math.ceil(needed / MAX_CAP);
  return {
    value: MAX_CAP,
    starts,
    note: `The page allows at most ${MAX_CAP} calls per Start, so the rest of the run needs about ${starts} Starts. `
      + 'Saved replies are reused, so no call is made twice.',
  };
}

/**
 * Suggest a reply size. When many units stop at an empty or cut-short reply, the model ran out of room, which happens with
 * reasoning models that spend the reply size on reasoning. The next size up is suggested. If the largest is already in
 * use, the note says so, because no setting here can fix it.
 *
 * units is how many units have been started, and stopped is how many of them stopped at an unusable reply.
 */
export function adviseMaxTokens({ maxTokens, units, stopped }) {
  const share = units > 0 ? stopped / units : 0;
  if (units < MIN_UNITS_FOR_ADVICE || share <= UNUSABLE_ALERT_SHARE) return { value: maxTokens, note: null };
  const percent = Math.round(share * 100);
  const larger = MAX_TOKEN_CHOICES.find((choice) => choice > maxTokens);
  if (larger === undefined) {
    return {
      value: maxTokens,
      note: `${percent}% of units stopped at an empty or cut-short reply, even at the largest setting. Check the model before running more.`,
    };
  }
  return {
    value: larger,
    note: `${percent}% of units stopped at an empty or cut-short reply at ${maxTokens} tokens. Reasoning models often need more room.`,
  };
}

/**
 * Return the call cap a Start needs to finish the steps left. It is never lower than the cap the form holds, so a cap left
 * over from an earlier run is raised, not kept. The steps are counted with a margin, because a call can need another try.
 */
export function capToFinish({ cap, stepsLeft, attemptsPerStep }) {
  const needed = adviseCap({ stepsLeft, attemptsPerStep: attemptsPerStep * CAP_MARGIN }).value;
  return Math.max(cap, needed);
}

/** Return the number rounded up to the next multiple of step. A count of zero stays zero. */
function roundUpTo(value, step) {
  return Math.ceil(value / step) * step;
}
