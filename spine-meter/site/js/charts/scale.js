// Pure helpers for chart maths. No DOM access, so these also run in Node tests.

// A tiny tolerance so floating-point error (for example 0.30000000000000004) does not add an extra tick.
const TICK_EPSILON = 1e-9;

// Each series is packed as three blocks of numbers: values, lows, highs.
const VALUE_BLOCK = 0;
const LOW_BLOCK = 1;
const HIGH_BLOCK = 2;
const BLOCKS_PER_SERIES = 3;

/** Returns a function that maps a value in the domain to a position in the range. */
export function linearScale(domainMin, domainMax, rangeMin, rangeMax) {
  const domainSpan = domainMax - domainMin;
  if (domainSpan === 0) {
    return () => rangeMin;
  }
  const rangeSpan = rangeMax - rangeMin;
  return (value) => rangeMin + ((value - domainMin) / domainSpan) * rangeSpan;
}

/** Picks a round step (1, 2 or 5 times a power of ten) close to the rough step. */
function niceStep(roughStep) {
  const exponent = Math.floor(Math.log10(roughStep));
  const fraction = roughStep / 10 ** exponent;
  let niceFraction = 10;
  if (fraction < 1.5) {
    niceFraction = 1;
  } else if (fraction < 3) {
    niceFraction = 2;
  } else if (fraction < 7) {
    niceFraction = 5;
  }
  return niceFraction * 10 ** exponent;
}

/** Round tick values that cover min to max, aiming for about count ticks. Includes 0 when min is 0. */
export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [];
  }
  const low = Math.min(min, max);
  let high = Math.max(min, max);
  // A zero-width range would give a zero step, so widen it to give the loop below something to span.
  if (high === low) {
    high = low + (low === 0 ? 1 : Math.abs(low));
  }
  const intervals = Math.max(1, Math.round(count) - 1);
  const step = niceStep((high - low) / intervals);
  // Decimal places the step needs. Rounding each tick to this many removes floating-point noise.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const firstIndex = Math.floor(low / step + TICK_EPSILON);
  const lastIndex = Math.ceil(high / step - TICK_EPSILON);
  const ticks = [];
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    ticks.push(Number((index * step).toFixed(decimals)));
  }
  return ticks;
}

/** Rounds a coordinate to two decimals so the markup stays short. */
export function roundPx(value) {
  return Math.round(value * 100) / 100;
}

/** Formats a number for an SVG coordinate: at most two decimals, no trailing zeros. */
function formatCoordinate(value) {
  return String(Number(value.toFixed(2)));
}

/** Builds "M x y L x y ..." from an array of { x, y } points. Returns "" for no points. */
export function pathFromPoints(points) {
  return points
    .map((point, index) => {
      const command = index === 0 ? "M" : "L";
      return `${command} ${formatCoordinate(point.x)} ${formatCoordinate(point.y)}`;
    })
    .join(" ");
}

/** Closed shape for a shaded band: the high edge left to right, then the low edge right to left. */
export function bandPath(xs, lows, highs) {
  const count = Math.min(xs.length, lows.length, highs.length);
  if (count === 0) {
    return "";
  }
  const upperEdge = [];
  const lowerEdge = [];
  for (let index = 0; index < count; index += 1) {
    upperEdge.push({ x: xs[index], y: highs[index] });
  }
  for (let index = count - 1; index >= 0; index -= 1) {
    lowerEdge.push({ x: xs[index], y: lows[index] });
  }
  return `${pathFromPoints(upperEdge.concat(lowerEdge))} Z`;
}

/** Short text for an axis tick: at most three decimals, no trailing zeros. */
export function formatTick(value) {
  if (!Number.isFinite(value)) {
    return "";
  }
  return String(Number(value.toFixed(3)));
}

/** The value as a number, or NaN when it is missing, empty, or not a finite number. NaN means "no data". */
export function cleanNumber(value) {
  if (value === null || value === undefined || value === "") {
    return Number.NaN;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

/** Returns exactly count numbers from the array. A missing or bad value stays NaN, so it draws as a gap. */
export function fitNumbers(values, count) {
  const result = [];
  for (let index = 0; index < count; index += 1) {
    result.push(cleanNumber(values ? values[index] : undefined));
  }
  return result;
}

/** Packs each series into three blocks (values, lows, highs), each exactly count numbers long. */
export function packSeries(seriesList, count) {
  const numbers = [];
  for (const item of seriesList) {
    numbers.push(...fitNumbers(item.values, count));
    numbers.push(...fitNumbers(item.lows || item.values, count));
    numbers.push(...fitNumbers(item.highs || item.values, count));
  }
  return numbers;
}

/** Reads the three blocks for one series back out of the packed numbers. */
export function seriesBlocks(numbers, seriesIndex, count) {
  const readBlock = (blockIndex) => {
    const start = (seriesIndex * BLOCKS_PER_SERIES + blockIndex) * count;
    return numbers.slice(start, start + count);
  };
  return { values: readBlock(VALUE_BLOCK), lows: readBlock(LOW_BLOCK), highs: readBlock(HIGH_BLOCK) };
}

/** Groups the indexes whose flag is true into runs of neighbours. A false flag breaks a run. */
export function validRuns(flags) {
  const runs = [];
  let current = [];
  flags.forEach((flag, index) => {
    if (flag) {
      current.push(index);
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  });
  if (current.length > 0) {
    runs.push(current);
  }
  return runs;
}

/** Tick values from 0 up to the maximum. Uses 1 when the maximum is not a number. */
export function axisTicks(maxValue, count) {
  const top = Number.isFinite(maxValue) ? maxValue : 1;
  return niceTicks(0, top, count);
}

/** The last tick, which is the top of the value axis. */
export function topOf(ticks) {
  return ticks[ticks.length - 1];
}

/** Clamps a value into the 0 to 1 range. A missing or NaN value stays NaN. */
export function clamp01(value) {
  const number = cleanNumber(value);
  if (!Number.isFinite(number)) {
    return Number.NaN;
  }
  return Math.min(1, Math.max(0, number));
}
