// Suggests settings for a batch run from what the run has already shown: how many calls can really run at once, how
// many calls the rest of the run needs, and whether the reply size is too small. The functions only suggest. Each one
// returns a value and a plain note, and the page decides whether to apply it. Why not change the settings directly:
// the user chose them on purpose, and a suggestion that quietly changes a cap they set would be a surprise.

// The largest call cap the batch page accepts for one Start. Matches MAX_BATCH_CALLS on the batch page.
export const MAX_CAP = 400;
// The caps are suggested in steps of this size, so the number reads as a round figure.
const CAP_STEP = 10;
// The reply sizes the batch page offers, smallest first. Matches the choices in index.html.
export const MAX_TOKEN_CHOICES = [2048, 4096, 8192, 16384, 32768];
// No advice about reply size until this many replies have been seen. A few bad replies are not a pattern.
export const MIN_REPLIES_FOR_ADVICE = 20;
// If more than this share of replies are empty or cut short, the reply size is too small. Matches
// health_max_unparsed_rate in ordeal/data/config.json, so the web page and the command line agree.
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
 * Suggest a reply size. When many replies come back empty or cut short, the model ran out of room, which happens with
 * reasoning models that spend the reply size on reasoning. The next size up is suggested. If the largest is already in
 * use, the note says so, because no setting here can fix it.
 */
export function adviseMaxTokens({ maxTokens, replies, unusable }) {
  const share = replies > 0 ? unusable / replies : 0;
  if (replies < MIN_REPLIES_FOR_ADVICE || share <= UNUSABLE_ALERT_SHARE) return { value: maxTokens, note: null };
  const percent = Math.round(share * 100);
  const larger = MAX_TOKEN_CHOICES.find((choice) => choice > maxTokens);
  if (larger === undefined) {
    return {
      value: maxTokens,
      note: `${percent}% of replies were empty or cut short, even at the largest setting. Check the model before running more.`,
    };
  }
  return {
    value: larger,
    note: `${percent}% of replies were empty or cut short at ${maxTokens} tokens. Reasoning models often need more room.`,
  };
}

/** Return the number rounded up to the next multiple of step. A count of zero stays zero. */
function roundUpTo(value, step) {
  return Math.ceil(value / step) * step;
}
