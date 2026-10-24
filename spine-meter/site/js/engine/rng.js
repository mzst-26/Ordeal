// A port of numpy's np.random.default_rng(seed).integers(0, high), so that the browser's bootstrap
// draws the same question resamples as grade.py. It is PCG64, seeded through numpy's SeedSequence.
// Only whole, non-negative seeds and high values up to 2**32 are supported, which covers config.json.
const MASK32 = 0xffffffffn;
const MASK64 = (1n << 64n) - 1n;
const MASK128 = (1n << 128n) - 1n;
const PCG_MULTIPLIER = 0x2360ed051fc65da44385df649fccf645n;
const TWO_POW_32 = 4294967296;
const POOL_SIZE = 4;
const INIT_A = 0x43b0d7e5;
const MULT_A = 0x931e8875;
const INIT_B = 0x8b51f9dd;
const MULT_B = 0x58f38ded;
const MIX_MULT_L = 0xca01f9dd;
const MIX_MULT_R = 0x4973f715;
const XSHIFT = 16;

/** Return the 32-bit words of a whole, non-negative seed, least significant word first. */
function seedWords(seed) {
  const words = [];
  let rest = BigInt(seed);
  do {
    words.push(Number(rest & MASK32));
    rest >>= 32n;
  } while (rest > 0n);
  return words;
}

/** Return the next hash value of numpy's hashmix. 'state' holds the running constant in state.constant. */
function hashmix(value, state) {
  let result = (value ^ state.constant) >>> 0;
  state.constant = Math.imul(state.constant, MULT_A) >>> 0;
  result = Math.imul(result, state.constant) >>> 0;
  return (result ^ (result >>> XSHIFT)) >>> 0;
}

/** Return the mixture of two pool words, as numpy's mix does. */
function mix(x, y) {
  const result = (Math.imul(MIX_MULT_L, x) - Math.imul(MIX_MULT_R, y)) >>> 0;
  return (result ^ (result >>> XSHIFT)) >>> 0;
}

/** Return the four-word entropy pool that numpy builds from the seed words. */
function mixEntropy(entropy) {
  const pool = [0, 0, 0, 0];
  const state = { constant: INIT_A };
  for (let index = 0; index < POOL_SIZE; index += 1) {
    pool[index] = hashmix(index < entropy.length ? entropy[index] : 0, state);
  }
  for (let source = 0; source < POOL_SIZE; source += 1) {
    for (let target = 0; target < POOL_SIZE; target += 1) {
      if (source !== target) {
        pool[target] = mix(pool[target], hashmix(pool[source], state));
      }
    }
  }
  for (let source = POOL_SIZE; source < entropy.length; source += 1) {
    for (let target = 0; target < POOL_SIZE; target += 1) {
      pool[target] = mix(pool[target], hashmix(entropy[source], state));
    }
  }
  return pool;
}

/** Return 'count' 32-bit words derived from the pool, as numpy's SeedSequence.generate_state does. */
function generateStateWords(pool, count) {
  const words = [];
  const state = { constant: INIT_B };
  for (let index = 0; index < count; index += 1) {
    let value = (pool[index % POOL_SIZE] ^ state.constant) >>> 0;
    state.constant = Math.imul(state.constant, MULT_B) >>> 0;
    value = Math.imul(value, state.constant) >>> 0;
    words.push((value ^ (value >>> XSHIFT)) >>> 0);
  }
  return words;
}

/** Return the 64-bit values that numpy's PCG64 seeding reads: four values, two 32-bit words each. */
function seedValues(seed) {
  const words = generateStateWords(mixEntropy(seedWords(seed)), 8);
  const values = [];
  for (let index = 0; index < 4; index += 1) {
    values.push(BigInt(words[2 * index]) | (BigInt(words[2 * index + 1]) << 32n));
  }
  return values;
}

/** Return value rotated right by rotation bits (a BigInt, taken modulo 64), in 64 bits. */
function rotateRight64(value, rotation) {
  const shift = rotation & 63n;
  return ((value >> shift) | (value << ((64n - shift) & 63n))) & MASK64;
}

/** Return a PCG64 generator in the state numpy gives for this seed. */
function createPcg64(seed) {
  const [initStateHigh, initStateLow, initSeqHigh, initSeqLow] = seedValues(seed);
  const initState = (initStateHigh << 64n) | initStateLow;
  const initSeq = (initSeqHigh << 64n) | initSeqLow;
  const generator = { state: 0n, inc: ((initSeq << 1n) | 1n) & MASK128, hasUint32: false, uinteger: 0 };
  step(generator);
  generator.state = (generator.state + initState) & MASK128;
  step(generator);
  return generator;
}

/** Advance the 128-bit linear congruential state of a PCG64 generator. */
function step(generator) {
  generator.state = (generator.state * PCG_MULTIPLIER + generator.inc) & MASK128;
}

/** Return the next 64-bit output of a PCG64 generator (XSL RR output of the new state). */
function nextUint64(generator) {
  step(generator);
  const high = generator.state >> 64n;
  const low = generator.state & MASK64;
  return rotateRight64(high ^ low, generator.state >> 122n);
}

/** Return the next 32-bit output. Each 64-bit output gives its low half first, then its high half. */
function nextUint32(generator) {
  if (generator.hasUint32) {
    generator.hasUint32 = false;
    return generator.uinteger;
  }
  const value = nextUint64(generator);
  generator.hasUint32 = true;
  generator.uinteger = Number(value >> 32n);
  return Number(value & MASK32);
}

/** Return a whole number from 0 to range - 1, using numpy's 32-bit Lemire method (range is at least 1). */
function lemireBounded(generator, range) {
  const exclusive = range;
  let product = nextUint32(generator) * exclusive;
  let leftover = product % TWO_POW_32;
  if (leftover < exclusive) {
    const threshold = (TWO_POW_32 - exclusive) % exclusive;
    while (leftover < threshold) {
      product = nextUint32(generator) * exclusive;
      leftover = product % TWO_POW_32;
    }
  }
  return Math.floor(product / TWO_POW_32);
}

/**
 * Return a function draw(high) that gives the next whole number from 0 to high - 1, as
 * np.random.default_rng(seed).integers(0, high) does, one call at a time. high must be from 1 to 2**32.
 */
export function createIntegerDraw(seed) {
  const generator = createPcg64(seed);
  return function draw(high) {
    if (!Number.isInteger(high) || high < 1 || high > TWO_POW_32) {
      throw new Error(`The range must be a whole number from 1 to 2**32. Got ${high}.`);
    }
    if (high === 1) {
      return 0;
    }
    // numpy uses the raw 32-bit output when the range is the whole 32-bit range.
    if (high === TWO_POW_32) {
      return nextUint32(generator);
    }
    return lemireBounded(generator, high);
  };
}
